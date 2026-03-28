/**
 * Unit tests for EntityService.
 * Tests storeDecision, supersedeDecision, storeFinding, resolveFinding,
 * storeGotcha (dedup logic), completeRun, getRelevantContext.
 * Traces to AMU-AC-6 through AMU-AC-18, AMU-AC-30, AMU-AC-31.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { EntityService } from '../../src/services/entity-service.js';
import { ValidationError, NotFoundError } from '../../src/utils/errors.js';
import type { StorageAdapter } from '../../src/storage/storage-adapter.js';
import type { EmbeddingService } from '../../src/services/embedding-service.js';
import type { Decision } from '../../src/models/decision.js';
import type { Finding } from '../../src/models/finding.js';
import type { Gotcha } from '../../src/models/gotcha.js';
import type { RunSummary } from '../../src/models/run-summary.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: randomUUID(),
    repository: '/repo/test',
    category: 'database',
    choice: 'Use SQLite',
    rationale: 'Zero dependencies',
    made_by: null,
    made_at: new Date().toISOString(),
    status: 'active',
    superseded_by: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: randomUUID(),
    repository: '/repo/test',
    file_path: 'src/auth.ts',
    severity: 'critical',
    issue: 'JWT secret hardcoded',
    suggestion: 'Move to env var',
    status: 'open',
    found_by: null,
    found_at: new Date().toISOString(),
    resolved_at: null,
    resolved_by: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeGotcha(overrides: Partial<Gotcha> = {}): Gotcha {
  return {
    id: randomUUID(),
    repository: '/repo/test',
    description: 'node:sqlite is synchronous',
    tags: ['sqlite'],
    technology: 'sqlite',
    embedding: null,
    times_encountered: 1,
    first_seen: new Date().toISOString(),
    last_seen: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeRunSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id: randomUUID(),
    repository: '/repo/test',
    summary: 'Implemented authentication',
    files_changed: [],
    started_at: new Date().toISOString(),
    duration_seconds: null,
    outcome: 'success',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeMockStorage(overrides: Partial<StorageAdapter> = {}): StorageAdapter {
  const decision = makeDecision();
  const finding = makeFinding();
  const gotcha = makeGotcha();
  const runSummary = makeRunSummary();

  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    createLearning: vi.fn().mockResolvedValue({}),
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
    getStats: vi.fn().mockResolvedValue({ total: 0, active: 0, deprecated: 0, stale: 0, withEmbeddings: 0, byCategory: [], byRepository: [], byWorkspace: [], oldestAt: null, newestAt: null, totalAccesses: 0, avgAccessCount: 0, neverAccessedCount: 0 }),
    getContextLearnings: vi.fn().mockResolvedValue({ repo: [], workspace: [], global: [], stale: [], summary: { total_repo: 0, total_workspace: 0, total_global: 0, stale_count: 0, last_updated: '' } }),
    getDuplicateCandidates: vi.fn().mockResolvedValue([]),
    checkAndStoreDuplicates: vi.fn().mockResolvedValue(undefined),
    cleanupDuplicateCandidates: vi.fn().mockResolvedValue(undefined),
    findScopedNeighbors: vi.fn().mockResolvedValue([]),
    recordAccess: vi.fn().mockResolvedValue(undefined),
    createRelationship: vi.fn().mockResolvedValue({}),
    getRelationships: vi.fn().mockResolvedValue([]),
    storeConflict: vi.fn().mockResolvedValue(undefined),
    getUnresolvedConflicts: vi.fn().mockResolvedValue([]),
    resolveConflicts: vi.fn().mockResolvedValue(0),
    getActiveLearningsWithConflictCounts: vi.fn().mockResolvedValue([]),
    batchUpdateStaleness: vi.fn().mockResolvedValue(undefined),
    purgeExpired: vi.fn().mockReturnValue(0),
    purgeByFilter: vi.fn().mockReturnValue(0),
    // AMU methods
    createDecision: vi.fn().mockResolvedValue(decision),
    getDecision: vi.fn().mockResolvedValue(decision),
    getDecisions: vi.fn().mockResolvedValue([decision]),
    updateDecision: vi.fn().mockResolvedValue(decision),
    createFinding: vi.fn().mockResolvedValue(finding),
    getFinding: vi.fn().mockResolvedValue(finding),
    getOpenFindings: vi.fn().mockResolvedValue([finding]),
    updateFinding: vi.fn().mockResolvedValue(finding),
    createGotcha: vi.fn().mockResolvedValue(gotcha),
    getGotcha: vi.fn().mockResolvedValue(gotcha),
    getGotchas: vi.fn().mockResolvedValue([gotcha]),
    updateGotcha: vi.fn().mockResolvedValue(gotcha),
    findSimilarGotcha: vi.fn().mockResolvedValue(null),
    createRunSummary: vi.fn().mockResolvedValue(runSummary),
    getRunHistory: vi.fn().mockResolvedValue([runSummary]),
    getRelevantDecisions: vi.fn().mockResolvedValue([decision]),
    getRelevantFindings: vi.fn().mockResolvedValue([finding]),
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
// storeDecision (AMU-AC-6)
// ---------------------------------------------------------------------------

describe('EntityService.storeDecision', () => {
  let service: EntityService;
  let storage: StorageAdapter;

  beforeEach(() => {
    storage = makeMockStorage();
    service = new EntityService(storage, makeMockEmbedding());
  });

  it('creates a decision with required fields', async () => {
    const result = await service.storeDecision({
      repository: '/repo/test',
      category: 'database',
      choice: 'Use SQLite',
      rationale: 'Zero dependencies',
    });
    expect(result).toBeDefined();
    expect(storage.createDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: '/repo/test',
        category: 'database',
        choice: 'Use SQLite',
        rationale: 'Zero dependencies',
      })
    );
  });

  it('generates a UUID for the decision id', async () => {
    await service.storeDecision({
      repository: '/repo/test',
      category: 'auth',
      choice: 'Use JWT',
      rationale: 'Stateless auth',
    });
    const call = vi.mocked(storage.createDecision).mock.calls[0];
    expect(call?.[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('throws ValidationError for invalid input', async () => {
    await expect(
      service.storeDecision({ repository: '', category: 'x', choice: 'y', rationale: 'z' })
    ).rejects.toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// supersedeDecision (AMU-AC-8)
// ---------------------------------------------------------------------------

describe('EntityService.supersedeDecision', () => {
  it('supersedes an active decision', async () => {
    const oldDecision = makeDecision({ status: 'active' });
    const newDecision = makeDecision({ status: 'active' });
    const supersededDecision = { ...oldDecision, status: 'superseded' as const, superseded_by: newDecision.id };

    const storage = makeMockStorage({
      getDecision: vi.fn()
        .mockResolvedValueOnce(oldDecision)  // first call: old
        .mockResolvedValueOnce(newDecision), // second call: new
      updateDecision: vi.fn().mockResolvedValue(supersededDecision),
    });
    const service = new EntityService(storage, makeMockEmbedding());

    const result = await service.supersedeDecision(oldDecision.id, newDecision.id);
    expect(result.old_decision.status).toBe('superseded');
    expect(result.new_decision.id).toBe(newDecision.id);
    expect(storage.updateDecision).toHaveBeenCalledWith(
      oldDecision.id,
      expect.objectContaining({ status: 'superseded', superseded_by: newDecision.id })
    );
  });

  it('throws NotFoundError when old decision not found', async () => {
    const storage = makeMockStorage({ getDecision: vi.fn().mockResolvedValue(null) });
    const service = new EntityService(storage, makeMockEmbedding());
    await expect(service.supersedeDecision('missing-id', 'new-id')).rejects.toThrow(NotFoundError);
  });

  it('throws ValidationError when old decision is not active', async () => {
    const superseded = makeDecision({ status: 'superseded' });
    const storage = makeMockStorage({ getDecision: vi.fn().mockResolvedValue(superseded) });
    const service = new EntityService(storage, makeMockEmbedding());
    await expect(service.supersedeDecision(superseded.id, 'new-id')).rejects.toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// storeFinding (AMU-AC-9)
// ---------------------------------------------------------------------------

describe('EntityService.storeFinding', () => {
  it('creates a finding with required fields', async () => {
    const storage = makeMockStorage();
    const service = new EntityService(storage, makeMockEmbedding());

    await service.storeFinding({
      repository: '/repo/test',
      file_path: 'src/auth.ts',
      severity: 'critical',
      issue: 'JWT secret hardcoded',
      suggestion: 'Move to env var',
    });

    expect(storage.createFinding).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'critical',
        file_path: 'src/auth.ts',
      })
    );
  });

  it('throws ValidationError for invalid severity', async () => {
    const storage = makeMockStorage();
    const service = new EntityService(storage, makeMockEmbedding());
    await expect(
      service.storeFinding({
        repository: '/repo/test',
        file_path: 'src/auth.ts',
        severity: 'blocker' as 'critical',
        issue: 'x',
        suggestion: 'y',
      })
    ).rejects.toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// resolveFinding (AMU-AC-10)
// ---------------------------------------------------------------------------

describe('EntityService.resolveFinding', () => {
  it('resolves a finding', async () => {
    const finding = makeFinding({ status: 'open' });
    const resolvedFinding = { ...finding, status: 'resolved' as const, resolved_at: new Date().toISOString() };

    const storage = makeMockStorage({
      getFinding: vi.fn().mockResolvedValue(finding),
      updateFinding: vi.fn().mockResolvedValue(resolvedFinding),
    });
    const service = new EntityService(storage, makeMockEmbedding());

    const result = await service.resolveFinding(finding.id, 'reviewer-agent');
    expect(result.status).toBe('resolved');
    expect(storage.updateFinding).toHaveBeenCalledWith(
      finding.id,
      expect.objectContaining({ status: 'resolved', resolved_by: 'reviewer-agent' })
    );
  });

  it('throws NotFoundError when finding not found', async () => {
    const storage = makeMockStorage({ getFinding: vi.fn().mockResolvedValue(null) });
    const service = new EntityService(storage, makeMockEmbedding());
    await expect(service.resolveFinding('missing-id')).rejects.toThrow(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// storeGotcha deduplication (AMU-AC-12, AMU-AC-30, AMU-AC-31)
// ---------------------------------------------------------------------------

describe('EntityService.storeGotcha — no embedding provider (exact match fallback)', () => {
  it('creates a new gotcha when no match exists (AMU-AC-31)', async () => {
    const storage = makeMockStorage({ getGotchas: vi.fn().mockResolvedValue([]) });
    const service = new EntityService(storage, makeMockEmbedding());

    const result = await service.storeGotcha({
      repository: '/repo/test',
      description: 'node:sqlite is synchronous',
      tags: ['sqlite'],
    });

    expect(result.incremented).toBe(false);
    expect(storage.createGotcha).toHaveBeenCalled();
  });

  it('increments existing gotcha on exact description match (AMU-AC-31)', async () => {
    const existingGotcha = makeGotcha({
      description: 'node:sqlite is synchronous',
      times_encountered: 2,
    });
    const updatedGotcha = { ...existingGotcha, times_encountered: 3 };

    const storage = makeMockStorage({
      getGotchas: vi.fn().mockResolvedValue([existingGotcha]),
      updateGotcha: vi.fn().mockResolvedValue(updatedGotcha),
    });
    const service = new EntityService(storage, makeMockEmbedding());

    const result = await service.storeGotcha({
      repository: '/repo/test',
      description: 'node:sqlite is synchronous', // exact match (case-insensitive)
      tags: ['sqlite'],
    });

    expect(result.incremented).toBe(true);
    expect(result.gotcha.times_encountered).toBe(3);
    expect(storage.createGotcha).not.toHaveBeenCalled();
    expect(storage.updateGotcha).toHaveBeenCalledWith(
      existingGotcha.id,
      expect.objectContaining({ times_encountered: 3 })
    );
  });

  it('case-insensitive exact match (AMU-AC-31)', async () => {
    const existingGotcha = makeGotcha({ description: 'NODE:SQLITE IS SYNCHRONOUS' });
    const storage = makeMockStorage({ getGotchas: vi.fn().mockResolvedValue([existingGotcha]) });
    const service = new EntityService(storage, makeMockEmbedding());

    const result = await service.storeGotcha({
      repository: '/repo/test',
      description: 'node:sqlite is synchronous',
      tags: [],
    });

    expect(result.incremented).toBe(true);
  });

  it('trims whitespace for exact match (AMU-AC-31)', async () => {
    const existingGotcha = makeGotcha({ description: '  node:sqlite is synchronous  ' });
    const storage = makeMockStorage({ getGotchas: vi.fn().mockResolvedValue([existingGotcha]) });
    const service = new EntityService(storage, makeMockEmbedding());

    const result = await service.storeGotcha({
      repository: '/repo/test',
      description: 'node:sqlite is synchronous',
      tags: [],
    });

    expect(result.incremented).toBe(true);
  });
});

describe('EntityService.storeGotcha — with embedding provider', () => {
  it('uses embedding similarity for deduplication when provider available (AMU-AC-30)', async () => {
    const embedding = new Array(384).fill(0.1);
    const existingGotcha = makeGotcha({ embedding });
    const updatedGotcha = { ...existingGotcha, times_encountered: 2 };

    const storage = makeMockStorage({
      findSimilarGotcha: vi.fn().mockResolvedValue(existingGotcha),
      updateGotcha: vi.fn().mockResolvedValue(updatedGotcha),
    });
    const embeddingService = makeMockEmbedding({
      generateEmbedding: vi.fn().mockResolvedValue(embedding),
      getProviderName: vi.fn().mockReturnValue('fastembed'),
    });
    const service = new EntityService(storage, embeddingService);

    const result = await service.storeGotcha({
      repository: '/repo/test',
      description: 'similar gotcha description',
      tags: [],
    });

    expect(result.incremented).toBe(true);
    expect(storage.findSimilarGotcha).toHaveBeenCalledWith('/repo/test', embedding, 0.85);
  });

  it('creates new gotcha when no similar found (AMU-AC-30)', async () => {
    const embedding = new Array(384).fill(0.1);
    const newGotcha = makeGotcha({ embedding });

    const storage = makeMockStorage({
      findSimilarGotcha: vi.fn().mockResolvedValue(null),
      createGotcha: vi.fn().mockResolvedValue(newGotcha),
    });
    const embeddingService = makeMockEmbedding({
      generateEmbedding: vi.fn().mockResolvedValue(embedding),
      getProviderName: vi.fn().mockReturnValue('fastembed'),
    });
    const service = new EntityService(storage, embeddingService);

    const result = await service.storeGotcha({
      repository: '/repo/test',
      description: 'unique gotcha',
      tags: [],
    });

    expect(result.incremented).toBe(false);
    expect(storage.createGotcha).toHaveBeenCalledWith(
      expect.objectContaining({ embedding })
    );
  });
});

// ---------------------------------------------------------------------------
// completeRun (AMU-AC-14)
// ---------------------------------------------------------------------------

describe('EntityService.completeRun', () => {
  it('creates a run summary with defaults', async () => {
    const storage = makeMockStorage();
    const service = new EntityService(storage, makeMockEmbedding());

    await service.completeRun({
      repository: '/repo/test',
      summary: 'Implemented auth',
    });

    expect(storage.createRunSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: '/repo/test',
        summary: 'Implemented auth',
        files_changed: [],
        outcome: 'success',
      })
    );
  });

  it('accepts custom outcome and files_changed', async () => {
    const storage = makeMockStorage();
    const service = new EntityService(storage, makeMockEmbedding());

    await service.completeRun({
      repository: '/repo/test',
      summary: 'Partial run',
      files_changed: ['src/auth.ts'],
      outcome: 'partial',
      duration_seconds: 60,
    });

    expect(storage.createRunSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'partial',
        files_changed: ['src/auth.ts'],
        duration_seconds: 60,
      })
    );
  });

  it('throws ValidationError for invalid input', async () => {
    const storage = makeMockStorage();
    const service = new EntityService(storage, makeMockEmbedding());
    await expect(
      service.completeRun({ repository: '', summary: 'x' })
    ).rejects.toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// getRunHistory limit clamping (AMU-AC-15)
// ---------------------------------------------------------------------------

describe('EntityService.getRunHistory', () => {
  it('clamps limit to max 50', async () => {
    const storage = makeMockStorage();
    const service = new EntityService(storage, makeMockEmbedding());

    await service.getRunHistory('/repo/test', 100);
    expect(storage.getRunHistory).toHaveBeenCalledWith('/repo/test', 50);
  });

  it('clamps limit to min 1', async () => {
    const storage = makeMockStorage();
    const service = new EntityService(storage, makeMockEmbedding());

    await service.getRunHistory('/repo/test', 0);
    expect(storage.getRunHistory).toHaveBeenCalledWith('/repo/test', 1);
  });

  it('defaults to 10 when not provided', async () => {
    const storage = makeMockStorage();
    const service = new EntityService(storage, makeMockEmbedding());

    await service.getRunHistory('/repo/test');
    expect(storage.getRunHistory).toHaveBeenCalledWith('/repo/test', 10);
  });
});

// ---------------------------------------------------------------------------
// getRelevantContext (AMU-AC-16, AMU-AC-17)
// ---------------------------------------------------------------------------

describe('EntityService.getRelevantContext', () => {
  it('returns structured result with all sections (AMU-AC-17)', async () => {
    const storage = makeMockStorage();
    const service = new EntityService(storage, makeMockEmbedding());

    const result = await service.getRelevantContext('/repo/test', 'implement authentication');

    expect(result).toHaveProperty('decisions');
    expect(result).toHaveProperty('open_findings');
    expect(result).toHaveProperty('gotchas');
    expect(result).toHaveProperty('recent_learnings');
    expect(result).toHaveProperty('recent_runs');
    expect(result).toHaveProperty('summary');
    expect(result.summary.repository).toBe('/repo/test');
    expect(typeof result.summary.total_items).toBe('number');
  });

  it('limits recent_runs to max 2 (AMU-AC-17)', async () => {
    const runs = [makeRunSummary(), makeRunSummary(), makeRunSummary()];
    const storage = makeMockStorage({ getRunHistory: vi.fn().mockResolvedValue(runs) });
    const service = new EntityService(storage, makeMockEmbedding());

    const result = await service.getRelevantContext('/repo/test', 'any task');
    expect(result.recent_runs.length).toBeLessThanOrEqual(2);
  });

  it('limits each section to max 3 items (AMU-AC-17)', async () => {
    const decisions = [makeDecision(), makeDecision(), makeDecision(), makeDecision()];
    const findings = [makeFinding(), makeFinding(), makeFinding(), makeFinding()];

    const storage = makeMockStorage({
      getRelevantDecisions: vi.fn().mockResolvedValue(decisions),
      getRelevantFindings: vi.fn().mockResolvedValue(findings),
    });
    const service = new EntityService(storage, makeMockEmbedding());

    const result = await service.getRelevantContext('/repo/test', 'any task');
    expect(result.decisions.length).toBeLessThanOrEqual(3);
    expect(result.open_findings.length).toBeLessThanOrEqual(3);
  });

  it('throws ValidationError for missing repository', async () => {
    const storage = makeMockStorage();
    const service = new EntityService(storage, makeMockEmbedding());
    await expect(service.getRelevantContext('', 'task')).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError for missing task_description', async () => {
    const storage = makeMockStorage();
    const service = new EntityService(storage, makeMockEmbedding());
    await expect(service.getRelevantContext('/repo/test', '')).rejects.toThrow(ValidationError);
  });

  it('total_items matches sum of all section lengths (AMU-AC-17)', async () => {
    const storage = makeMockStorage();
    const service = new EntityService(storage, makeMockEmbedding());

    const result = await service.getRelevantContext('/repo/test', 'auth task');
    const expectedTotal =
      result.decisions.length +
      result.open_findings.length +
      result.gotchas.length +
      result.recent_learnings.length +
      result.recent_runs.length;
    expect(result.summary.total_items).toBe(expectedTotal);
  });
});
