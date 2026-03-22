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
    ttl_days: null,
    source_agent: null,
    integrity_hash: null,
    access_count: 0,
    last_accessed_at: null,
    staleness_score: 0.0,
    ...overrides,
  };
}

function makeMockStorage(overrides: Partial<StorageAdapter> = {}): StorageAdapter {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    createLearning: vi.fn().mockImplementation(async (record) => makeLearning({ id: record.id, category: record.category ?? 'architecture' })),
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
    findScopedNeighbors: vi.fn().mockResolvedValue([]),
    recordAccess: vi.fn().mockResolvedValue(undefined),
    createRelationship: vi.fn().mockResolvedValue({}),
    getRelationships: vi.fn().mockResolvedValue([]),
    purgeExpired: vi.fn().mockReturnValue(0),
    purgeByFilter: vi.fn().mockReturnValue(0),
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
    expect(result.learning.id).toBeTruthy();
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
// autoCategorize (via storeLearning) tests (SKM-AC-17 through SKM-AC-21)
// ---------------------------------------------------------------------------
describe('LearningService autoCategorize behavior', () => {
  let storage: StorageAdapter;
  let embedding: EmbeddingService;
  let service: LearningService;

  const mockEmbeddingVector = [0.1, 0.2, 0.3];

  beforeEach(() => {
    embedding = makeMockEmbedding({
      generateEmbedding: vi.fn().mockResolvedValue(mockEmbeddingVector),
    });
  });

  it('SKM-AC-21: explicit category skips auto-categorization, auto_categorized=false', async () => {
    storage = makeMockStorage();
    service = new LearningService(storage, embedding);

    const result = await service.storeLearning({
      content: 'Use transactions.',
      category: 'architecture',
    });

    expect(result.auto_categorized).toBe(false);
    expect(result.learning.category).toBe('architecture');
    // findScopedNeighbors should NOT be called when category is explicit
    expect(storage.findScopedNeighbors).not.toHaveBeenCalled();
  });

  it('SKM-AC-17, SKM-AC-20: omitting category triggers auto-categorization, auto_categorized=true', async () => {
    // 5 neighbors all voting "gotchas" — clear majority
    const neighbors = [
      { id: 'a', content: 'gotcha 1', category: 'gotchas', embedding: [0.1, 0.2, 0.3], similarity: 0.9 },
      { id: 'b', content: 'gotcha 2', category: 'gotchas', embedding: [0.1, 0.2, 0.3], similarity: 0.85 },
      { id: 'c', content: 'gotcha 3', category: 'gotchas', embedding: [0.1, 0.2, 0.3], similarity: 0.8 },
    ];
    storage = makeMockStorage({
      findScopedNeighbors: vi.fn().mockResolvedValue(neighbors),
    });
    service = new LearningService(storage, embedding);

    const result = await service.storeLearning({
      content: 'Another tricky gotcha.',
      // no category
    });

    expect(result.auto_categorized).toBe(true);
    expect(result.learning.category).toBe('gotchas');
    expect(storage.findScopedNeighbors).toHaveBeenCalledOnce();
  });

  it('SKM-AC-17: null category triggers auto-categorization', async () => {
    const neighbors = [
      { id: 'a', content: 'dep 1', category: 'dependencies', embedding: [0.1, 0.2, 0.3], similarity: 0.9 },
      { id: 'b', content: 'dep 2', category: 'dependencies', embedding: [0.1, 0.2, 0.3], similarity: 0.85 },
      { id: 'c', content: 'dep 3', category: 'dependencies', embedding: [0.1, 0.2, 0.3], similarity: 0.8 },
    ];
    storage = makeMockStorage({
      findScopedNeighbors: vi.fn().mockResolvedValue(neighbors),
    });
    service = new LearningService(storage, embedding);

    const result = await service.storeLearning({
      content: 'Install using npm.',
      category: null,
    });

    expect(result.auto_categorized).toBe(true);
    expect(result.learning.category).toBe('dependencies');
  });

  it('SKM-AC-18: KNN voting selects majority category among top-5 neighbors', async () => {
    // 3 votes "gotchas", 2 votes "architecture" among top 5
    const neighbors = [
      { id: 'a', content: 'g1', category: 'gotchas', embedding: [0.1], similarity: 0.95 },
      { id: 'b', content: 'g2', category: 'gotchas', embedding: [0.1], similarity: 0.90 },
      { id: 'c', content: 'a1', category: 'architecture', embedding: [0.1], similarity: 0.88 },
      { id: 'd', content: 'g3', category: 'gotchas', embedding: [0.1], similarity: 0.85 },
      { id: 'e', content: 'a2', category: 'architecture', embedding: [0.1], similarity: 0.80 },
      // 6th neighbor — should be ignored (only top 5 used)
      { id: 'f', content: 'arch3', category: 'architecture', embedding: [0.1], similarity: 0.70 },
    ];
    storage = makeMockStorage({
      findScopedNeighbors: vi.fn().mockResolvedValue(neighbors),
    });
    service = new LearningService(storage, embedding);

    const result = await service.storeLearning({ content: 'A tricky edge case.', category: null });

    expect(result.auto_categorized).toBe(true);
    expect(result.learning.category).toBe('gotchas');
  });

  it('SKM-AC-18: tie-breaking uses highest average similarity', async () => {
    // 2 votes "gotchas" (avg sim=0.9), 2 votes "conventions" (avg sim=0.7), 1 vote "debugging"
    // Tie between gotchas and conventions by count; gotchas wins on avg sim
    const neighbors = [
      { id: 'a', content: 'g1', category: 'gotchas', embedding: [0.1], similarity: 0.95 },
      { id: 'b', content: 'g2', category: 'gotchas', embedding: [0.1], similarity: 0.85 },
      { id: 'c', content: 'c1', category: 'conventions', embedding: [0.1], similarity: 0.75 },
      { id: 'd', content: 'c2', category: 'conventions', embedding: [0.1], similarity: 0.65 },
      { id: 'e', content: 'd1', category: 'debugging', embedding: [0.1], similarity: 0.60 },
    ];
    storage = makeMockStorage({
      findScopedNeighbors: vi.fn().mockResolvedValue(neighbors),
    });
    service = new LearningService(storage, embedding);

    const result = await service.storeLearning({ content: 'Tie scenario.', category: null });

    expect(result.auto_categorized).toBe(true);
    // gotchas avg sim = (0.95 + 0.85) / 2 = 0.90; conventions avg = (0.75 + 0.65) / 2 = 0.70
    expect(result.learning.category).toBe('gotchas');
  });

  it('SKM-AC-19: fewer than 3 neighbors throws ValidationError', async () => {
    // Only 2 neighbors — insufficient
    const neighbors = [
      { id: 'a', content: 'g1', category: 'gotchas', embedding: [0.1], similarity: 0.9 },
      { id: 'b', content: 'g2', category: 'gotchas', embedding: [0.1], similarity: 0.85 },
    ];
    storage = makeMockStorage({
      findScopedNeighbors: vi.fn().mockResolvedValue(neighbors),
    });
    service = new LearningService(storage, embedding);

    await expect(
      service.storeLearning({ content: 'Too sparse.', category: null })
    ).rejects.toThrow(ValidationError);
  });

  it('SKM-AC-19: zero neighbors throws ValidationError', async () => {
    storage = makeMockStorage({
      findScopedNeighbors: vi.fn().mockResolvedValue([]),
    });
    service = new LearningService(storage, embedding);

    await expect(
      service.storeLearning({ content: 'Empty scope.', category: undefined })
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError when no embedding provider and category omitted', async () => {
    // Provider returns null (provider=none)
    embedding = makeMockEmbedding({
      generateEmbedding: vi.fn().mockResolvedValue(null),
    });
    storage = makeMockStorage();
    service = new LearningService(storage, embedding);

    await expect(
      service.storeLearning({ content: 'No embedding, no category.', category: null })
    ).rejects.toThrow(ValidationError);

    // findScopedNeighbors should never be called when embedding is null
    expect(storage.findScopedNeighbors).not.toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// searchLearnings: verify_integrity (ESH-AC-27)
// ---------------------------------------------------------------------------
describe('LearningService.searchLearnings — verify_integrity (ESH-AC-27)', () => {
  let storage: StorageAdapter;
  let service: LearningService;

  beforeEach(() => {
    storage = makeMockStorage();
    service = new LearningService(storage, makeMockEmbedding());
  });

  it('does not annotate integrity_valid when verify_integrity is false (default)', async () => {
    const learning = makeLearning({ integrity_hash: null });
    storage.searchByText = vi.fn().mockResolvedValue([{ ...learning, score: 1 }]);
    const results = await service.searchLearnings({ query: 'test' });
    expect(results[0]).not.toHaveProperty('integrity_valid');
  });

  it('annotates integrity_valid: null for legacy learnings with null integrity_hash', async () => {
    const learning = makeLearning({ integrity_hash: null });
    storage.searchByText = vi.fn().mockResolvedValue([{ ...learning, score: 1 }]);
    const results = await service.searchLearnings({ query: 'test', verify_integrity: true });
    expect(results[0]).toHaveProperty('integrity_valid', null);
  });

  it('annotates integrity_valid: true when hash matches', async () => {
    const { computeIntegrityHash } = await import('../../src/security/integrity.js');
    const learning = makeLearning({ repository: '/repo/test', tags: ['node'] });
    const hash = computeIntegrityHash({
      content: learning.content,
      category: learning.category,
      tags: learning.tags,
      repository: learning.repository,
      workspace: learning.workspace,
    });
    const learningWithHash = { ...learning, integrity_hash: hash };
    storage.searchByText = vi.fn().mockResolvedValue([{ ...learningWithHash, score: 1 }]);
    const results = await service.searchLearnings({ query: 'test', verify_integrity: true });
    expect(results[0]).toHaveProperty('integrity_valid', true);
  });

  it('annotates integrity_valid: false when content was tampered', async () => {
    const learning = makeLearning({ repository: '/repo/test', tags: [] });
    // Store a hash computed from different content
    const { computeIntegrityHash } = await import('../../src/security/integrity.js');
    const originalHash = computeIntegrityHash({
      content: 'original content',
      category: learning.category,
      tags: learning.tags,
      repository: learning.repository,
      workspace: learning.workspace,
    });
    // Return a learning where content differs from what the hash was computed from
    const tampered = { ...learning, content: 'tampered content', integrity_hash: originalHash };
    storage.searchByText = vi.fn().mockResolvedValue([{ ...tampered, score: 1 }]);
    const results = await service.searchLearnings({ query: 'test', verify_integrity: true });
    expect(results[0]).toHaveProperty('integrity_valid', false);
  });
});
