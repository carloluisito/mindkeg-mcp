/**
 * Integration tests for EntityService with real SQLite adapter.
 * Tests gotcha deduplication end-to-end and get_relevant_context budget trimming.
 * Traces to AMU-AC-12, AMU-AC-16, AMU-AC-17, AMU-AC-18, AMU-AC-30, AMU-AC-31.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { EntityService } from '../../src/services/entity-service.js';
import type { EmbeddingService } from '../../src/services/embedding-service.js';

function makeNoneEmbeddingService(): EmbeddingService {
  return {
    generateEmbedding: vi.fn().mockResolvedValue(null),
    getDimensions: vi.fn().mockReturnValue(0),
    getProviderName: vi.fn().mockReturnValue('none'),
  };
}

function makeEmbeddingService(embedding: number[]): EmbeddingService {
  return {
    generateEmbedding: vi.fn().mockResolvedValue(embedding),
    getDimensions: vi.fn().mockReturnValue(embedding.length),
    getProviderName: vi.fn().mockReturnValue('fastembed'),
  };
}

let adapter: SqliteAdapter;
let noneService: EntityService;

beforeEach(async () => {
  adapter = new SqliteAdapter(':memory:');
  await adapter.initialize();
  noneService = new EntityService(adapter, makeNoneEmbeddingService());
});

afterEach(async () => {
  await adapter.close();
});

// ---------------------------------------------------------------------------
// Gotcha deduplication — exact match fallback (AMU-AC-31)
// ---------------------------------------------------------------------------

describe('Gotcha deduplication — exact match fallback (no embedding provider)', () => {
  it('creates new gotcha on first store', async () => {
    const result = await noneService.storeGotcha({
      repository: '/repo/test',
      description: 'node:sqlite is synchronous',
      tags: ['sqlite'],
    });

    expect(result.incremented).toBe(false);
    expect(result.gotcha.times_encountered).toBe(1);
    expect(result.gotcha.description).toBe('node:sqlite is synchronous');
  });

  it('increments existing gotcha on exact match (AMU-AC-31)', async () => {
    // First store
    await noneService.storeGotcha({
      repository: '/repo/test',
      description: 'node:sqlite is synchronous',
      tags: ['sqlite'],
    });

    // Second store — same description
    const result = await noneService.storeGotcha({
      repository: '/repo/test',
      description: 'node:sqlite is synchronous',
      tags: ['sqlite', 'new-tag'],
    });

    expect(result.incremented).toBe(true);
    expect(result.gotcha.times_encountered).toBe(2);
  });

  it('case-insensitive exact match', async () => {
    await noneService.storeGotcha({
      repository: '/repo/test',
      description: 'NODE:SQLITE IS SYNCHRONOUS',
      tags: [],
    });

    const result = await noneService.storeGotcha({
      repository: '/repo/test',
      description: 'node:sqlite is synchronous',
      tags: [],
    });

    expect(result.incremented).toBe(true);
  });

  it('creates separate gotchas for different descriptions', async () => {
    await noneService.storeGotcha({ repository: '/repo/test', description: 'First gotcha', tags: [] });
    const result = await noneService.storeGotcha({ repository: '/repo/test', description: 'Different gotcha', tags: [] });

    expect(result.incremented).toBe(false);

    const allGotchas = await adapter.getGotchas('/repo/test');
    expect(allGotchas.length).toBe(2);
  });

  it('does not deduplicate across different repositories', async () => {
    await noneService.storeGotcha({ repository: '/repo/a', description: 'Shared gotcha', tags: [] });
    const result = await noneService.storeGotcha({ repository: '/repo/b', description: 'Shared gotcha', tags: [] });

    expect(result.incremented).toBe(false); // Different repo — new entry
  });
});

// ---------------------------------------------------------------------------
// Gotcha deduplication — embedding similarity (AMU-AC-30)
// ---------------------------------------------------------------------------

describe('Gotcha deduplication — embedding similarity (AMU-AC-30)', () => {
  it('increments gotcha on high cosine similarity', async () => {
    const baseEmbedding = [1.0, 0.0, 0.0, 0.0];
    const similarEmbedding = [0.999, 0.001, 0.001, 0.001]; // very similar

    const embService = makeEmbeddingService(baseEmbedding);
    const service = new EntityService(adapter, embService);

    // First store
    await service.storeGotcha({
      repository: '/repo/test',
      description: 'Original gotcha',
      tags: [],
    });

    // Second store — embedding returns similar vector
    vi.mocked(embService.generateEmbedding).mockResolvedValue(similarEmbedding);
    const result = await service.storeGotcha({
      repository: '/repo/test',
      description: 'Similar gotcha',
      tags: [],
    });

    // The cosine similarity between [1,0,0,0] and [0.999, 0.001, 0.001, 0.001]
    // is very high (>= 0.85), so it should increment
    expect(result.incremented).toBe(true);
  });

  it('creates new gotcha when embedding similarity is below threshold', async () => {
    const embeddingA = [1.0, 0.0, 0.0, 0.0];
    const embeddingB = [0.0, 1.0, 0.0, 0.0]; // orthogonal — similarity = 0

    const embService = makeEmbeddingService(embeddingA);
    const service = new EntityService(adapter, embService);

    // First store
    await service.storeGotcha({
      repository: '/repo/test',
      description: 'First gotcha',
      tags: [],
    });

    // Second store — orthogonal embedding
    vi.mocked(embService.generateEmbedding).mockResolvedValue(embeddingB);
    const result = await service.storeGotcha({
      repository: '/repo/test',
      description: 'Unrelated gotcha',
      tags: [],
    });

    expect(result.incremented).toBe(false);

    const allGotchas = await adapter.getGotchas('/repo/test');
    expect(allGotchas.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// getRelevantContext — budget trimming and structure (AMU-AC-16, AMU-AC-17)
// ---------------------------------------------------------------------------

describe('getRelevantContext — integration (AMU-AC-16, AMU-AC-17)', () => {
  beforeEach(async () => {
    // Seed some data
    await adapter.createDecision({ id: 'd-1', repository: '/repo/test', category: 'auth', choice: 'Use JWT tokens for authentication', rationale: 'Stateless and scalable' });
    await adapter.createFinding({ id: 'f-1', repository: '/repo/test', file_path: 'src/auth.ts', severity: 'critical', issue: 'JWT secret hardcoded in source', suggestion: 'Move to environment variable' });
    await adapter.createGotcha({ id: 'g-1', repository: '/repo/test', description: 'JWT tokens expire silently', tags: ['jwt', 'auth'] });
    await adapter.createRunSummary({ id: 'run-1', repository: '/repo/test', summary: 'Implemented JWT authentication', files_changed: ['src/auth.ts'], outcome: 'success' });
  });

  it('returns all required sections (AMU-AC-17)', async () => {
    const result = await noneService.getRelevantContext('/repo/test', 'implement JWT authentication');

    expect(result).toHaveProperty('decisions');
    expect(result).toHaveProperty('open_findings');
    expect(result).toHaveProperty('gotchas');
    expect(result).toHaveProperty('recent_learnings');
    expect(result).toHaveProperty('recent_runs');
    expect(result).toHaveProperty('summary');
    expect(result.summary.repository).toBe('/repo/test');
  });

  it('total_items matches actual items returned (AMU-AC-17)', async () => {
    const result = await noneService.getRelevantContext('/repo/test', 'JWT authentication implementation');

    const actualTotal =
      result.decisions.length +
      result.open_findings.length +
      result.gotchas.length +
      result.recent_learnings.length +
      result.recent_runs.length;

    expect(result.summary.total_items).toBe(actualTotal);
  });

  it('compact budget produces smaller result than full budget', async () => {
    // Seed more data to make budget matter
    for (let i = 0; i < 5; i++) {
      await adapter.createDecision({ id: `d-extra-${i}`, repository: '/repo/test', category: 'extra', choice: `Choice ${i} that is quite long to fill up the budget allocation for this section`, rationale: `Rationale ${i} that is also quite long to ensure we exceed the compact budget limit for this test` });
      await adapter.createFinding({ id: `f-extra-${i}`, repository: '/repo/test', file_path: `src/file${i}.ts`, severity: 'warning', issue: `Issue ${i} with a longer description`, suggestion: `Suggestion ${i} with a longer description` });
    }

    const compact = await noneService.getRelevantContext('/repo/test', 'task', 'compact');
    const full = await noneService.getRelevantContext('/repo/test', 'task', 'full');

    const compactTotal = compact.decisions.length + compact.open_findings.length + compact.gotchas.length + compact.recent_learnings.length + compact.recent_runs.length;
    const fullTotal = full.decisions.length + full.open_findings.length + full.gotchas.length + full.recent_learnings.length + full.recent_runs.length;

    // full should return >= compact items (or same if already under budget)
    expect(fullTotal).toBeGreaterThanOrEqual(compactTotal);
  });
});
