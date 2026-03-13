/**
 * Unit tests for LearningService.getContext.
 * Uses mock storage and embedding service.
 * Traces to GC-AC-1 through GC-AC-30.
 */
import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { LearningService } from '../../src/services/learning-service.js';
import { ValidationError } from '../../src/utils/errors.js';
import type { StorageAdapter, GetContextData } from '../../src/storage/storage-adapter.js';
import type { EmbeddingService } from '../../src/services/embedding-service.js';
import type { Learning } from '../../src/models/learning.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeLearning(overrides: Partial<Learning> = {}): Learning {
  return {
    id: randomUUID(),
    content: 'Use transactions for all writes.',
    category: 'architecture',
    tags: [],
    repository: '/repo/test',
    workspace: null,
    group_id: null,
    source: 'test-agent',
    status: 'active',
    stale_flag: false,
    embedding: null,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeContextData(overrides: Partial<GetContextData> = {}): GetContextData {
  return {
    repo: [],
    workspace: [],
    global: [],
    stale: [],
    summary: {
      total_repo: 0,
      total_workspace: 0,
      total_global: 0,
      stale_count: 0,
      last_updated: '',
    },
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
    getContextLearnings: vi.fn().mockResolvedValue(makeContextData()),
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
// Validation (GC-AC-2)
// ---------------------------------------------------------------------------

describe('LearningService.getContext: validation', () => {
  it('throws ValidationError when repository is empty string (GC-AC-2)', async () => {
    const service = new LearningService(makeMockStorage(), makeMockEmbedding());
    await expect(service.getContext({ repository: '' })).rejects.toThrow(ValidationError);
  });

  it('accepts valid repository and returns structured result (GC-AC-2)', async () => {
    const service = new LearningService(makeMockStorage(), makeMockEmbedding());
    const result = await service.getContext({ repository: '/repo/test' });
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('repo_learnings');
    expect(result).toHaveProperty('workspace_learnings');
    expect(result).toHaveProperty('global_learnings');
    expect(result).toHaveProperty('stale_review');
  });
});

// ---------------------------------------------------------------------------
// Workspace auto-derivation (GC-AC-3)
// ---------------------------------------------------------------------------

describe('LearningService.getContext: workspace auto-derivation (GC-AC-3)', () => {
  it('auto-derives workspace from repository parent directory when not provided', async () => {
    let capturedFilters: Parameters<StorageAdapter['getContextLearnings']>[0] | null = null;
    const storage = makeMockStorage({
      getContextLearnings: vi.fn().mockImplementation(async (filters) => {
        capturedFilters = filters;
        return makeContextData();
      }),
    });
    const service = new LearningService(storage, makeMockEmbedding());
    await service.getContext({ repository: '/home/user/repos/my-app' });
    expect(capturedFilters!.workspace).toBe('/home/user/repos/');
  });

  it('uses provided workspace when explicitly set', async () => {
    let capturedFilters: Parameters<StorageAdapter['getContextLearnings']>[0] | null = null;
    const storage = makeMockStorage({
      getContextLearnings: vi.fn().mockImplementation(async (filters) => {
        capturedFilters = filters;
        return makeContextData();
      }),
    });
    const service = new LearningService(storage, makeMockEmbedding());
    await service.getContext({
      repository: '/repo/test',
      workspace: '/custom/workspace',
    });
    expect(capturedFilters!.workspace).toBe('/custom/workspace/');
  });
});

// ---------------------------------------------------------------------------
// Scope partitioning (GC-AC-4)
// ---------------------------------------------------------------------------

describe('LearningService.getContext: scope partitioning (GC-AC-4)', () => {
  it('returns repo, workspace, and global learnings in separate buckets', async () => {
    const repoLearning = makeLearning({ repository: '/repo/test' });
    const wsLearning = makeLearning({ repository: null, workspace: '/home/user/repos/' });
    const globalLearning = makeLearning({ repository: null, workspace: null });

    const storage = makeMockStorage({
      getContextLearnings: vi.fn().mockResolvedValue(makeContextData({
        repo: [repoLearning],
        workspace: [wsLearning],
        global: [globalLearning],
      })),
    });

    const service = new LearningService(storage, makeMockEmbedding());
    const result = await service.getContext({ repository: '/repo/test' });

    expect(result.repo_learnings).toHaveLength(1);
    expect(result.workspace_learnings).toHaveLength(1);
    expect(result.global_learnings).toHaveLength(1);
    expect(result.repo_learnings[0]!.id).toBe(repoLearning.id);
    expect(result.workspace_learnings[0]!.id).toBe(wsLearning.id);
    expect(result.global_learnings[0]!.id).toBe(globalLearning.id);
  });
});

// ---------------------------------------------------------------------------
// Summary object (GC-AC-5)
// ---------------------------------------------------------------------------

describe('LearningService.getContext: summary (GC-AC-5)', () => {
  it('passes through summary counts from storage', async () => {
    const storage = makeMockStorage({
      getContextLearnings: vi.fn().mockResolvedValue(makeContextData({
        summary: {
          total_repo: 5,
          total_workspace: 3,
          total_global: 2,
          stale_count: 1,
          last_updated: '2024-06-01T00:00:00.000Z',
        },
      })),
    });
    const service = new LearningService(storage, makeMockEmbedding());
    const result = await service.getContext({ repository: '/repo/test' });
    expect(result.summary.total_repo).toBe(5);
    expect(result.summary.total_workspace).toBe(3);
    expect(result.summary.total_global).toBe(2);
    expect(result.summary.stale_count).toBe(1);
    expect(result.summary.last_updated).toBe('2024-06-01T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// Volume thresholds (GC-AC-10, GC-AC-11)
// ---------------------------------------------------------------------------

describe('LearningService.getContext: volume thresholds (GC-AC-10, GC-AC-11)', () => {
  it('returns all learnings when count <= 30 (GC-AC-10)', async () => {
    const learnings = Array.from({ length: 25 }, () => makeLearning());
    const storage = makeMockStorage({
      getContextLearnings: vi.fn().mockResolvedValue(makeContextData({
        repo: learnings,
        summary: { total_repo: 25, total_workspace: 0, total_global: 0, stale_count: 0, last_updated: '' },
      })),
    });
    const service = new LearningService(storage, makeMockEmbedding());
    const result = await service.getContext({ repository: '/repo/test', budget: 'full' });
    // All 25 should fit within budget (small content) and be returned
    expect(result.repo_learnings.length).toBe(25);
  });

  it('caps at 20 when count > 30 and ranked mode activates (GC-AC-11)', async () => {
    const learnings = Array.from({ length: 35 }, () =>
      makeLearning({ content: 'x'.repeat(10) }) // very small, so all 20 fit in budget
    );
    const storage = makeMockStorage({
      getContextLearnings: vi.fn().mockResolvedValue(makeContextData({
        repo: learnings,
        summary: { total_repo: 35, total_workspace: 0, total_global: 0, stale_count: 0, last_updated: '' },
      })),
    });
    const service = new LearningService(storage, makeMockEmbedding());
    const result = await service.getContext({ repository: '/repo/test', budget: 'full' });
    expect(result.repo_learnings.length).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// Budget parameter (GC-AC-12)
// ---------------------------------------------------------------------------

describe('LearningService.getContext: budget parameter (GC-AC-12)', () => {
  it('defaults budget to standard when not provided', async () => {
    // With standard budget (5000 chars), large sections get trimmed
    const largeContent = 'x'.repeat(400);
    const learnings = Array.from({ length: 30 }, () => makeLearning({ content: largeContent }));
    const storage = makeMockStorage({
      getContextLearnings: vi.fn().mockResolvedValue(makeContextData({
        repo: learnings,
        summary: { total_repo: 30, total_workspace: 0, total_global: 0, stale_count: 0, last_updated: '' },
      })),
    });
    const service = new LearningService(storage, makeMockEmbedding());
    const result = await service.getContext({ repository: '/repo/test' });
    // Should be fewer than 30 due to budget trimming (400 chars * 30 > 5000)
    expect(result.repo_learnings.length).toBeLessThan(30);
  });

  it('full budget returns more learnings than compact', async () => {
    const learnings = Array.from({ length: 30 }, () =>
      makeLearning({ content: 'x'.repeat(100) })
    );
    const contextData = makeContextData({
      repo: learnings,
      summary: { total_repo: 30, total_workspace: 0, total_global: 0, stale_count: 0, last_updated: '' },
    });
    const storage = makeMockStorage({
      getContextLearnings: vi.fn().mockResolvedValue(contextData),
    });
    const service = new LearningService(storage, makeMockEmbedding());

    const compact = await service.getContext({ repository: '/repo/test', budget: 'compact' });
    const full = await service.getContext({ repository: '/repo/test', budget: 'full' });

    expect(full.repo_learnings.length).toBeGreaterThanOrEqual(compact.repo_learnings.length);
  });
});

// ---------------------------------------------------------------------------
// Stale review (GC-AC-21, GC-AC-22, GC-AC-23)
// ---------------------------------------------------------------------------

describe('LearningService.getContext: stale review (GC-AC-21, GC-AC-22)', () => {
  it('returns stale learnings in stale_review array (GC-AC-22)', async () => {
    const staleLearning = makeLearning({ stale_flag: true });
    const storage = makeMockStorage({
      getContextLearnings: vi.fn().mockResolvedValue(makeContextData({
        stale: [staleLearning],
        summary: { total_repo: 0, total_workspace: 0, total_global: 0, stale_count: 1, last_updated: '' },
      })),
    });
    const service = new LearningService(storage, makeMockEmbedding());
    const result = await service.getContext({ repository: '/repo/test' });
    expect(result.stale_review).toHaveLength(1);
    expect(result.stale_review[0]!.id).toBe(staleLearning.id);
  });

  it('does not modify any data (GC-AC-23 — read-only)', async () => {
    const storage = makeMockStorage();
    const service = new LearningService(storage, makeMockEmbedding());
    await service.getContext({ repository: '/repo/test' });
    // No write methods should be called
    expect(storage.createLearning).not.toHaveBeenCalled();
    expect(storage.updateLearning).not.toHaveBeenCalled();
    expect(storage.deleteLearning).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Near duplicates (GC-AC-26)
// ---------------------------------------------------------------------------

describe('LearningService.getContext: near_duplicates (GC-AC-26)', () => {
  it('returns near_duplicates when duplicate candidates exist', async () => {
    const learningA = makeLearning({ id: 'aaaa-bbbb-cccc', content: 'Short' });
    const learningB = makeLearning({ id: 'bbbb-cccc-dddd', content: 'Short' });

    const storage = makeMockStorage({
      getContextLearnings: vi.fn().mockResolvedValue(makeContextData({
        repo: [learningA, learningB],
      })),
      getDuplicateCandidates: vi.fn().mockResolvedValue([
        {
          id: randomUUID(),
          learning_id_a: 'aaaa-bbbb-cccc',
          learning_id_b: 'bbbb-cccc-dddd',
          similarity: 0.95,
          scope: 'repo',
          scope_value: '/repo/test',
          created_at: '2024-01-01T00:00:00.000Z',
        },
      ]),
    });

    const service = new LearningService(storage, makeMockEmbedding());
    const result = await service.getContext({ repository: '/repo/test', budget: 'full' });

    expect(result.near_duplicates).toBeDefined();
    expect(result.near_duplicates!.length).toBeGreaterThan(0);
    expect(result.near_duplicates![0]!.canonical_id).toBe('aaaa-bbbb-cccc');
    expect(result.near_duplicates![0]!.duplicate_ids).toContain('bbbb-cccc-dddd');
  });

  it('omits near_duplicates field when no duplicates exist', async () => {
    const storage = makeMockStorage({
      getDuplicateCandidates: vi.fn().mockResolvedValue([]),
    });
    const service = new LearningService(storage, makeMockEmbedding());
    const result = await service.getContext({ repository: '/repo/test' });
    expect(result.near_duplicates).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Embeddings stripped from output (architecture spec)
// ---------------------------------------------------------------------------

describe('LearningService.getContext: embedding stripped from output', () => {
  it('does not include embedding vector in returned learnings', async () => {
    const learning = makeLearning({ embedding: [0.1, 0.2, 0.3] });
    const storage = makeMockStorage({
      getContextLearnings: vi.fn().mockResolvedValue(makeContextData({
        repo: [learning],
      })),
    });
    const service = new LearningService(storage, makeMockEmbedding());
    const result = await service.getContext({ repository: '/repo/test', budget: 'full' });

    expect(result.repo_learnings.length).toBe(1);
    // RankedLearning should not have an 'embedding' property
    expect('embedding' in result.repo_learnings[0]!).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Empty database (GC-AC-29a)
// ---------------------------------------------------------------------------

describe('LearningService.getContext: empty database (GC-AC-29a)', () => {
  it('returns zero counts and empty arrays when database is empty', async () => {
    const service = new LearningService(makeMockStorage(), makeMockEmbedding());
    const result = await service.getContext({ repository: '/repo/test' });
    expect(result.summary.total_repo).toBe(0);
    expect(result.summary.total_workspace).toBe(0);
    expect(result.summary.total_global).toBe(0);
    expect(result.summary.stale_count).toBe(0);
    expect(result.repo_learnings).toEqual([]);
    expect(result.workspace_learnings).toEqual([]);
    expect(result.global_learnings).toEqual([]);
    expect(result.stale_review).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Non-matching repository (GC-AC-29b)
// ---------------------------------------------------------------------------

describe('LearningService.getContext: non-matching repository (GC-AC-29b)', () => {
  it('returns empty repo_learnings but still returns workspace and global', async () => {
    const globalLearning = makeLearning({ repository: null, workspace: null });
    const storage = makeMockStorage({
      getContextLearnings: vi.fn().mockResolvedValue(makeContextData({
        repo: [],
        global: [globalLearning],
        summary: { total_repo: 0, total_workspace: 0, total_global: 1, stale_count: 0, last_updated: '' },
      })),
    });
    const service = new LearningService(storage, makeMockEmbedding());
    const result = await service.getContext({ repository: '/nonexistent/repo' });
    expect(result.repo_learnings).toEqual([]);
    expect(result.global_learnings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Semantic boost (GC-AC-20) — with embedding provider
// ---------------------------------------------------------------------------

describe('LearningService.getContext: query semantic boost (GC-AC-20)', () => {
  it('generates query embedding when query is provided', async () => {
    const embedding = makeMockEmbedding({
      generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    });
    const service = new LearningService(makeMockStorage(), embedding);
    await service.getContext({ repository: '/repo/test', query: 'authentication' });
    expect(embedding.generateEmbedding).toHaveBeenCalledWith('authentication');
  });

  it('does not call generateEmbedding when query is not provided', async () => {
    const embedding = makeMockEmbedding({
      generateEmbedding: vi.fn().mockResolvedValue(null),
    });
    const service = new LearningService(makeMockStorage(), embedding);
    await service.getContext({ repository: '/repo/test' });
    expect(embedding.generateEmbedding).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// path_hint (GC-AC-16, GC-AC-18)
// ---------------------------------------------------------------------------

describe('LearningService.getContext: path_hint (GC-AC-16, GC-AC-18)', () => {
  it('does not forward path_hint to storage filters — handled at ranking layer (GC-AC-16)', async () => {
    let capturedFilters: Parameters<StorageAdapter['getContextLearnings']>[0] | null = null;
    const storage = makeMockStorage({
      getContextLearnings: vi.fn().mockImplementation(async (filters) => {
        capturedFilters = filters;
        return makeContextData();
      }),
    });
    const service = new LearningService(storage, makeMockEmbedding());
    await service.getContext({ repository: '/repo/test', path_hint: 'packages/api' });
    expect(capturedFilters).not.toBeNull();
    expect('path_hint' in capturedFilters!).toBe(false);
  });

  it('generates path_hint embedding when path_hint is provided (GC-AC-18)', async () => {
    const embedding = makeMockEmbedding({
      generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2]),
    });
    const service = new LearningService(makeMockStorage(), embedding);
    await service.getContext({ repository: '/repo/test', path_hint: 'packages/api' });
    expect(embedding.generateEmbedding).toHaveBeenCalledWith('packages/api');
  });
});
