/**
 * Unit tests for LearningService.
 * Uses mock storage and embedding service.
 * Traces to AC-1 through AC-15, AC-27, AC-28, AC-29, AC-30.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { LearningService } from '../../src/services/learning-service.js';
import { ValidationError, NotFoundError } from '../../src/utils/errors.js';
import type { StorageAdapter } from '../../src/storage/storage-adapter.js';
import type { EmbeddingService } from '../../src/services/embedding-service.js';
import type { Learning } from '../../src/models/learning.js';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeLearning(overrides: Partial<Learning> = {}): Learning {
  return {
    id: randomUUID(),
    content: 'Use transactions for all writes.',
    category: 'architecture',
    tags: ['database'],
    repository: '/repo/test',
    workspace: null,
    group_id: null,
    source: 'test-agent',
    status: 'active',
    stale_flag: false,
    embedding: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeMockStorage(overrides: Partial<StorageAdapter> = {}): StorageAdapter {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    createLearning: vi.fn().mockImplementation(async (record) => makeLearning({ id: record.id })),
    getLearning: vi.fn().mockResolvedValue(null),
    updateLearning: vi.fn().mockResolvedValue(null),
    deleteLearning: vi.fn().mockResolvedValue(false),
    listAll: vi.fn().mockResolvedValue([]),
    searchByText: vi.fn().mockResolvedValue([]),
    searchByVector: vi.fn().mockResolvedValue([]),
    listRepositories: vi.fn().mockResolvedValue([]),
    listWorkspaces: vi.fn().mockResolvedValue([]),
    createApiKey: vi.fn().mockResolvedValue({}),
    getApiKeyByHash: vi.fn().mockResolvedValue(null),
    listApiKeys: vi.fn().mockResolvedValue([]),
    revokeApiKey: vi.fn().mockResolvedValue(false),
    touchApiKey: vi.fn().mockResolvedValue(undefined),
    getStats: vi.fn().mockResolvedValue({ total: 0, active: 0, deprecated: 0, stale: 0, withEmbeddings: 0, byCategory: [], byRepository: [], byWorkspace: [], oldestAt: null, newestAt: null }),
    getContextLearnings: vi.fn().mockResolvedValue({ repo: [], workspace: [], global: [], stale: [], summary: { total_repo: 0, total_workspace: 0, total_global: 0, stale_count: 0, last_updated: '' } }),
    getDuplicateCandidates: vi.fn().mockResolvedValue([]),
    checkAndStoreDuplicates: vi.fn().mockResolvedValue(undefined),
    cleanupDuplicateCandidates: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeMockEmbedding(overrides: Partial<EmbeddingService> = {}): EmbeddingService {
  return {
    generateEmbedding: vi.fn().mockResolvedValue(null),
    getDimensions: vi.fn().mockReturnValue(0),
    getProviderName: vi.fn().mockReturnValue('none'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// storeLearning tests
// ---------------------------------------------------------------------------
describe('LearningService.storeLearning', () => {
  let storage: StorageAdapter;
  let embedding: EmbeddingService;
  let service: LearningService;

  beforeEach(() => {
    storage = makeMockStorage();
    embedding = makeMockEmbedding();
    service = new LearningService(storage, embedding);
  });

  it('validates input and creates a learning (AC-1)', async () => {
    const result = await service.storeLearning({
      content: 'Use async/await consistently.',
      category: 'conventions',
    });

    expect(storage.createLearning).toHaveBeenCalledOnce();
    expect(result.id).toBeTruthy();
  });

  it('generates an embedding when provider is not "none" (AC-9)', async () => {
    const mockEmbedding = [0.1, 0.2, 0.3];
    embedding.generateEmbedding = vi.fn().mockResolvedValue(mockEmbedding);

    await service.storeLearning({ content: 'Test.', category: 'gotchas' });

    expect(embedding.generateEmbedding).toHaveBeenCalledWith('Test.');
    expect(storage.createLearning).toHaveBeenCalledWith(
      expect.objectContaining({ embedding: mockEmbedding })
    );
  });

  it('stores null embedding when provider is "none"', async () => {
    embedding.generateEmbedding = vi.fn().mockResolvedValue(null);

    await service.storeLearning({ content: 'Test.', category: 'gotchas' });

    expect(storage.createLearning).toHaveBeenCalledWith(
      expect.objectContaining({ embedding: null })
    );
  });

  it('throws ValidationError for content > 500 chars (AC-6)', async () => {
    await expect(
      service.storeLearning({ content: 'x'.repeat(501), category: 'debugging' })
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError for invalid category (AC-13)', async () => {
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      service.storeLearning({ content: 'Valid content.', category: 'invalid' as any })
    ).rejects.toThrow(ValidationError);
  });

  it('uses default source "agent" when not provided (AC-28)', async () => {
    await service.storeLearning({ content: 'Test.', category: 'decisions' });
    expect(storage.createLearning).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent' })
    );
  });

  it('stores global learning when repository is null (AC-7)', async () => {
    await service.storeLearning({
      content: 'Global tip.',
      category: 'conventions',
      repository: null,
    });
    expect(storage.createLearning).toHaveBeenCalledWith(
      expect.objectContaining({ repository: null })
    );
  });

  it('passes group_id when provided (AC-15)', async () => {
    await service.storeLearning({
      content: 'Part of a group.',
      category: 'architecture',
      group_id: VALID_UUID,
    });
    expect(storage.createLearning).toHaveBeenCalledWith(
      expect.objectContaining({ group_id: VALID_UUID })
    );
  });

  it('passes tags when provided (AC-14)', async () => {
    await service.storeLearning({
      content: 'Tagged learning.',
      category: 'dependencies',
      tags: ['node', 'npm'],
    });
    expect(storage.createLearning).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ['node', 'npm'] })
    );
  });
});

// ---------------------------------------------------------------------------
// searchLearnings tests
// ---------------------------------------------------------------------------
describe('LearningService.searchLearnings', () => {
  let storage: StorageAdapter;
  let embedding: EmbeddingService;
  let service: LearningService;
  const mockResults = [{ ...makeLearning(), score: 0.9 }];

  beforeEach(() => {
    storage = makeMockStorage({
      searchByVector: vi.fn().mockResolvedValue(mockResults),
      searchByText: vi.fn().mockResolvedValue(mockResults),
    });
    embedding = makeMockEmbedding();
    service = new LearningService(storage, embedding);
  });

  it('uses vector search when embedding is available (AC-9)', async () => {
    embedding.generateEmbedding = vi.fn().mockResolvedValue([0.1, 0.2]);
    const results = await service.searchLearnings({ query: 'test' });
    expect(storage.searchByVector).toHaveBeenCalledOnce();
    expect(storage.searchByText).not.toHaveBeenCalled();
    // Results are annotated with scope (WS-AC-14); check core fields match
    expect(results).toHaveLength(mockResults.length);
    expect(results[0]).toMatchObject({ id: mockResults[0]!.id, score: mockResults[0]!.score });
    expect(results[0]).toHaveProperty('scope');
  });

  it('falls back to FTS when embedding returns null (AC-9 fallback)', async () => {
    embedding.generateEmbedding = vi.fn().mockResolvedValue(null);
    const results = await service.searchLearnings({ query: 'test' });
    expect(storage.searchByText).toHaveBeenCalledOnce();
    expect(storage.searchByVector).not.toHaveBeenCalled();
    // Results are annotated with scope (WS-AC-14); check core fields match
    expect(results).toHaveLength(mockResults.length);
    expect(results[0]).toMatchObject({ id: mockResults[0]!.id, score: mockResults[0]!.score });
    expect(results[0]).toHaveProperty('scope');
  });

  it('throws ValidationError for empty query', async () => {
    await expect(service.searchLearnings({ query: '' })).rejects.toThrow(ValidationError);
  });

  it('passes limit to storage (AC-11)', async () => {
    embedding.generateEmbedding = vi.fn().mockResolvedValue(null);
    await service.searchLearnings({ query: 'test', limit: 25 });
    expect(storage.searchByText).toHaveBeenCalledWith('test', expect.objectContaining({ limit: 25 }));
  });

  it('applies default limit of 10 (AC-11)', async () => {
    embedding.generateEmbedding = vi.fn().mockResolvedValue(null);
    await service.searchLearnings({ query: 'test' });
    expect(storage.searchByText).toHaveBeenCalledWith('test', expect.objectContaining({ limit: 10 }));
  });

  it('passes include_deprecated flag (AC-29)', async () => {
    embedding.generateEmbedding = vi.fn().mockResolvedValue(null);
    await service.searchLearnings({ query: 'test', include_deprecated: true });
    expect(storage.searchByText).toHaveBeenCalledWith(
      'test',
      expect.objectContaining({ include_deprecated: true })
    );
  });

  it('passes filters to storage (AC-10)', async () => {
    embedding.generateEmbedding = vi.fn().mockResolvedValue(null);
    await service.searchLearnings({
      query: 'test',
      repository: '/repo/x',
      category: 'debugging',
      tags: ['bug'],
    });
    expect(storage.searchByText).toHaveBeenCalledWith(
      'test',
      expect.objectContaining({
        repository: '/repo/x',
        category: 'debugging',
        tags: ['bug'],
      })
    );
  });
});

// ---------------------------------------------------------------------------
// updateLearning tests
// ---------------------------------------------------------------------------
describe('LearningService.updateLearning', () => {
  let storage: StorageAdapter;
  let embedding: EmbeddingService;
  let service: LearningService;
  let existing: Learning;

  beforeEach(() => {
    existing = makeLearning({ id: VALID_UUID, content: 'Original content.' });
    storage = makeMockStorage({
      getLearning: vi.fn().mockResolvedValue(existing),
      updateLearning: vi.fn().mockImplementation(async (_id, updates) =>
        makeLearning({ ...existing, ...updates })
      ),
    });
    embedding = makeMockEmbedding();
    service = new LearningService(storage, embedding);
  });

  it('throws NotFoundError when learning does not exist (AC-3)', async () => {
    storage.getLearning = vi.fn().mockResolvedValue(null);
    await expect(
      service.updateLearning({ id: VALID_UUID, content: 'New.' })
    ).rejects.toThrow(NotFoundError);
  });

  it('re-embeds when content changes (AC-9)', async () => {
    embedding.generateEmbedding = vi.fn().mockResolvedValue([0.5, 0.6]);
    await service.updateLearning({ id: VALID_UUID, content: 'New content.' });
    expect(embedding.generateEmbedding).toHaveBeenCalledWith('New content.');
  });

  it('does not re-embed when content does not change', async () => {
    await service.updateLearning({ id: VALID_UUID, category: 'debugging' });
    expect(embedding.generateEmbedding).not.toHaveBeenCalled();
  });

  it('throws ValidationError for invalid UUID', async () => {
    await expect(
      service.updateLearning({ id: 'not-a-uuid' })
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError for content > 500 chars (AC-6)', async () => {
    await expect(
      service.updateLearning({ id: VALID_UUID, content: 'x'.repeat(501) })
    ).rejects.toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// deprecateLearning tests
// ---------------------------------------------------------------------------
describe('LearningService.deprecateLearning', () => {
  let storage: StorageAdapter;
  let service: LearningService;
  let existing: Learning;

  beforeEach(() => {
    existing = makeLearning({ id: VALID_UUID });
    storage = makeMockStorage({
      getLearning: vi.fn().mockResolvedValue(existing),
      updateLearning: vi.fn().mockImplementation(async (_id, updates) =>
        makeLearning({ ...existing, ...updates })
      ),
    });
    service = new LearningService(storage, makeMockEmbedding());
  });

  it('sets status to "deprecated" (AC-4)', async () => {
    await service.deprecateLearning({ id: VALID_UUID });
    expect(storage.updateLearning).toHaveBeenCalledWith(
      VALID_UUID,
      expect.objectContaining({ status: 'deprecated' })
    );
  });

  it('throws NotFoundError when learning does not exist', async () => {
    storage.getLearning = vi.fn().mockResolvedValue(null);
    await expect(service.deprecateLearning({ id: VALID_UUID })).rejects.toThrow(NotFoundError);
  });

  it('throws ValidationError for invalid UUID', async () => {
    await expect(service.deprecateLearning({ id: 'bad' })).rejects.toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// deleteLearning tests
// ---------------------------------------------------------------------------
describe('LearningService.deleteLearning', () => {
  let storage: StorageAdapter;
  let service: LearningService;

  beforeEach(() => {
    storage = makeMockStorage({
      deleteLearning: vi.fn().mockResolvedValue(true),
    });
    service = new LearningService(storage, makeMockEmbedding());
  });

  it('deletes a learning and returns success (AC-5)', async () => {
    const result = await service.deleteLearning({ id: VALID_UUID });
    expect(result.success).toBe(true);
    expect(result.id).toBe(VALID_UUID);
  });

  it('throws NotFoundError when learning does not exist (AC-5)', async () => {
    storage.deleteLearning = vi.fn().mockResolvedValue(false);
    await expect(service.deleteLearning({ id: VALID_UUID })).rejects.toThrow(NotFoundError);
  });

  it('throws ValidationError for invalid UUID', async () => {
    await expect(service.deleteLearning({ id: 'not-uuid' })).rejects.toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// flagStale tests
// ---------------------------------------------------------------------------
describe('LearningService.flagStale', () => {
  let storage: StorageAdapter;
  let service: LearningService;
  let existing: Learning;

  beforeEach(() => {
    existing = makeLearning({ id: VALID_UUID, stale_flag: false });
    storage = makeMockStorage({
      getLearning: vi.fn().mockResolvedValue(existing),
      updateLearning: vi.fn().mockImplementation(async (_id, updates) =>
        makeLearning({ ...existing, ...updates })
      ),
    });
    service = new LearningService(storage, makeMockEmbedding());
  });

  it('sets stale_flag to true (AC-30)', async () => {
    const result = await service.flagStale({ id: VALID_UUID });
    expect(result.stale_flag).toBe(true);
    expect(storage.updateLearning).toHaveBeenCalledWith(
      VALID_UUID,
      expect.objectContaining({ stale_flag: true })
    );
  });

  it('throws NotFoundError when learning does not exist (AC-30)', async () => {
    storage.getLearning = vi.fn().mockResolvedValue(null);
    await expect(service.flagStale({ id: VALID_UUID })).rejects.toThrow(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// listRepositories tests
// ---------------------------------------------------------------------------
describe('LearningService.listRepositories', () => {
  it('delegates to storage.listRepositories', async () => {
    const repos = [{ path: '/repo/a', learning_count: 5 }];
    const storage = makeMockStorage({
      listRepositories: vi.fn().mockResolvedValue(repos),
    });
    const service = new LearningService(storage, makeMockEmbedding());
    const result = await service.listRepositories();
    expect(result).toEqual(repos);
    expect(storage.listRepositories).toHaveBeenCalledOnce();
  });
});
