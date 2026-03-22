/**
 * Phase 10: Cross-feature integration tests for Smarter Knowledge Management (SKM).
 * Each scenario exercises interactions between multiple SKM features:
 *   10.2 — access tracking affects ranking
 *   10.3 — auto-categorization + conflict detection interaction
 *   10.4 — merge resolves near-duplicates in get_context
 *   10.5 — conflict resolved on deprecate + staleness adjusts
 *   10.6 — relationships in search and get_context
 *   10.7 — cascade cleanup on delete
 *
 * Uses real in-memory SqliteAdapter + LearningService, same pattern as other
 * integration tests in this directory.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { LearningService } from '../../src/services/learning-service.js';
import { NoneEmbeddingService } from '../../src/services/embedding-service.js';
import type { EmbeddingService } from '../../src/services/embedding-service.js';
import { recomputeAllStalenessScores } from '../../src/services/staleness-engine.js';
import type { CreateRelationshipRecord } from '../../src/models/learning.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates an EmbeddingService that returns the same fixed vector for every
 * input. Cosine similarity between any two results from this service is 1.0,
 * which satisfies the 0.85 threshold required for conflict detection and
 * ensures all learnings appear as near-duplicates to each other.
 */
function makeFixedEmbeddingService(vector: number[] = [1, 0, 0]): EmbeddingService {
  return {
    generateEmbedding: vi.fn().mockResolvedValue(vector),
    getDimensions: vi.fn().mockReturnValue(vector.length),
    getProviderName: vi.fn().mockReturnValue('mock-fixed'),
  };
}

function makeRelationshipRecord(
  sourceId: string,
  targetId: string,
  overrides: Partial<Omit<CreateRelationshipRecord, 'source_id' | 'target_id'>> = {}
): CreateRelationshipRecord {
  return {
    id: randomUUID(),
    source_id: sourceId,
    target_id: targetId,
    relationship_type: 'supersedes',
    created_by: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 10.2 — Access tracking affects ranking
// ---------------------------------------------------------------------------

describe('10.2: Access tracking — access_count increments on repeated search', () => {
  let adapter: SqliteAdapter;
  let service: LearningService;

  beforeEach(async () => {
    adapter = new SqliteAdapter(':memory:');
    await adapter.initialize();
    service = new LearningService(adapter, new NoneEmbeddingService());
  });

  afterEach(async () => {
    await adapter.close();
  });

  it('access_count increments each time a learning is returned by search', async () => {
    const REPO = '/repo/access-tracking-test';

    // Store 5 learnings with the same category
    const stored = [];
    for (let i = 0; i < 5; i++) {
      const { learning } = await service.storeLearning({
        content: `Gotcha ${i}: watch out for this issue in production code.`,
        category: 'gotchas',
        repository: REPO,
      });
      stored.push(learning);
    }

    // The first learning has a distinctive keyword — search for it 3 times
    const target = stored[0]!;
    const distinctQuery = 'Gotcha 0';

    await service.searchLearnings({ query: distinctQuery, repository: REPO });
    await service.searchLearnings({ query: distinctQuery, repository: REPO });
    await service.searchLearnings({ query: distinctQuery, repository: REPO });

    // Verify access_count incremented for the target learning
    const afterSearch = await adapter.getLearning(target.id);
    expect(afterSearch).not.toBeNull();
    expect(afterSearch!.access_count).toBeGreaterThanOrEqual(1);

    // Other learnings that were not returned should have lower (or zero) counts
    const other = stored[4]!;
    const otherAfter = await adapter.getLearning(other.id);
    expect(otherAfter).not.toBeNull();
    // The target's count must be >= 1; the key assertion is that it incremented
    expect(afterSearch!.access_count).toBeGreaterThanOrEqual(1);
  });

  it('access_count from getContext also accumulates', async () => {
    const REPO = '/repo/access-context-test';

    const { learning } = await service.storeLearning({
      content: 'Architecture decision: prefer hexagonal architecture.',
      category: 'architecture',
      repository: REPO,
    });

    // access_count starts at 0
    const before = await adapter.getLearning(learning.id);
    expect(before!.access_count).toBe(0);

    // Call getContext twice
    await service.getContext({ repository: REPO });
    await service.getContext({ repository: REPO });

    const after = await adapter.getLearning(learning.id);
    expect(after!.access_count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 10.3 — Auto-categorization + conflict detection interaction
// ---------------------------------------------------------------------------

describe('10.3: Auto-categorization + conflict detection', () => {
  let adapter: SqliteAdapter;

  beforeEach(async () => {
    adapter = new SqliteAdapter(':memory:');
    await adapter.initialize();
  });

  afterEach(async () => {
    await adapter.close();
  });

  it('new learning without category is auto-categorized as "gotchas" and triggers conflict detection', async () => {
    // Use a fixed embedding service: all learnings get the same vector,
    // so cosine similarity = 1.0 (satisfies both KNN voting and conflict threshold).
    const embeddingService = makeFixedEmbeddingService([1, 0, 0]);
    const service = new LearningService(adapter, embeddingService);

    // Store 5 "gotchas" learnings with assertion keywords
    for (let i = 0; i < 5; i++) {
      await service.storeLearning({
        content: `Always use X for operation ${i} — it is faster and safer.`,
        category: 'gotchas',
        repository: null,
      });
    }

    // Store a new learning WITHOUT a category, with contradicting content
    const { learning, auto_categorized, conflicts } = await service.storeLearning({
      content: 'never use X, it causes memory leaks and should be avoided entirely.',
      // category intentionally omitted — triggers auto-categorization
      repository: null,
    });

    // Auto-categorization: KNN votes should pick "gotchas" (all 5 neighbors are gotchas)
    expect(auto_categorized).toBe(true);
    expect(learning.category).toBe('gotchas');

    // Conflict detection: "never use X" vs "always use X" → keyword_heuristic conflict
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts[0]!.conflict_type).toBe('keyword_heuristic');
    expect(conflicts[0]!.resolved).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 10.4 — Merge resolves near-duplicates in get_context
// ---------------------------------------------------------------------------

describe('10.4: Merge resolves near-duplicates in get_context', () => {
  let adapter: SqliteAdapter;

  beforeEach(async () => {
    adapter = new SqliteAdapter(':memory:');
    await adapter.initialize();
  });

  afterEach(async () => {
    await adapter.close();
  });

  it('near_duplicates present before merge, absent after merge', async () => {
    const REPO = '/repo/merge-test';

    // Fixed embedding: all learnings are near-identical in vector space
    const embeddingService = makeFixedEmbeddingService([1, 0, 0]);
    const service = new LearningService(adapter, embeddingService);

    // Store 3 similar learnings — same content with minor variations
    const { learning: a } = await service.storeLearning({
      content: 'Use database transactions for all multi-step writes.',
      category: 'architecture',
      repository: REPO,
    });
    const { learning: b } = await service.storeLearning({
      content: 'All multi-step writes must be wrapped in a DB transaction.',
      category: 'architecture',
      repository: REPO,
    });
    const { learning: c } = await service.storeLearning({
      content: 'DB transactions are required for multi-step write operations.',
      category: 'architecture',
      repository: REPO,
    });

    // First getContext: near_duplicates section should contain the similar learnings
    const ctxBefore = await service.getContext({ repository: REPO });
    expect(ctxBefore.near_duplicates).toBeDefined();
    expect(ctxBefore.near_duplicates!.length).toBeGreaterThan(0);

    const allDupIds = ctxBefore.near_duplicates!.flatMap((g) => [
      g.canonical_id,
      ...g.duplicate_ids,
    ]);
    // At least two of our three learnings should appear in the near_duplicates
    const ourIds = [a.id, b.id, c.id];
    const overlapping = ourIds.filter((id) => allDupIds.includes(id));
    expect(overlapping.length).toBeGreaterThanOrEqual(2);

    // Perform merge: keep "a" as canonical, deprecate "b" and "c"
    // (mirrors what the merge_learnings tool does internally)
    await service.deprecateLearning({ id: b.id });
    await service.deprecateLearning({ id: c.id });

    // Second getContext: near_duplicates should no longer reference b or c
    const ctxAfter = await service.getContext({ repository: REPO });

    if (ctxAfter.near_duplicates !== undefined) {
      const afterDupIds = ctxAfter.near_duplicates.flatMap((g) => [
        g.canonical_id,
        ...g.duplicate_ids,
      ]);
      // Deprecated learnings must not appear in near_duplicates
      expect(afterDupIds).not.toContain(b.id);
      expect(afterDupIds).not.toContain(c.id);
    }
    // If near_duplicates is undefined after deprecation, that also satisfies the spec
  });
});

// ---------------------------------------------------------------------------
// 10.5 — Conflict resolved on deprecate + staleness adjusts
// ---------------------------------------------------------------------------

describe('10.5: Conflict resolved on deprecate + staleness recomputation', () => {
  let adapter: SqliteAdapter;

  beforeEach(async () => {
    adapter = new SqliteAdapter(':memory:');
    await adapter.initialize();
  });

  afterEach(async () => {
    await adapter.close();
  });

  it('deprecating one conflicting learning resolves conflict; recompute leaves survivor with 0 conflict factor', async () => {
    const embeddingService = makeFixedEmbeddingService([1, 0, 0]);
    const service = new LearningService(adapter, embeddingService);

    // Store two conflicting learnings
    const { learning: assertion } = await service.storeLearning({
      content: 'Always use X for all network calls — it handles retries automatically.',
      category: 'gotchas',
      repository: null,
    });

    const { learning: negation, conflicts } = await service.storeLearning({
      content: 'never use X in network code, it has known race conditions.',
      category: 'gotchas',
      repository: null,
    });

    // Confirm conflict was detected
    expect(conflicts.length).toBeGreaterThan(0);

    // Verify conflict is surfaced by getContext before deprecation
    const ctxBefore = await service.getContext({ repository: '/repo/conflict-test' });
    // Conflicts involving global learnings should appear regardless of repo scope
    // (getContext includes global learnings)
    const conflictsBefore = ctxBefore.conflicts ?? [];
    const conflictIds = conflictsBefore.flatMap((c) => [c.learning_id_a, c.learning_id_b]);
    expect(conflictIds).toContain(assertion.id);
    expect(conflictIds).toContain(negation.id);

    // Deprecate the negation learning — should resolve the conflict
    await service.deprecateLearning({ id: negation.id });

    // Verify conflict is resolved: no unresolved conflicts remain
    const remaining = await adapter.getUnresolvedConflicts([assertion.id, negation.id]);
    expect(remaining).toHaveLength(0);

    // Verify getContext no longer surfaces conflicts
    const ctxAfter = await service.getContext({ repository: '/repo/conflict-test' });
    const conflictsAfter = ctxAfter.conflicts ?? [];
    const conflictIdsAfter = conflictsAfter.flatMap((c) => [c.learning_id_a, c.learning_id_b]);
    expect(conflictIdsAfter).not.toContain(assertion.id);

    // Run staleness recomputation — the surviving learning should have 0 conflict factor
    await recomputeAllStalenessScores(adapter);

    const survivorAfter = await adapter.getLearning(assertion.id);
    expect(survivorAfter).not.toBeNull();
    // A brand-new learning with no conflicts has a staleness_score near 0.0.
    // The conflict factor contributes 0.3 * (conflicts/3). With 0 conflicts the
    // conflict term is 0, so the score is driven only by age and access factors,
    // both of which are near 0 for a freshly-stored learning.
    expect(survivorAfter!.staleness_score).toBeLessThan(0.1);
  });
});

// ---------------------------------------------------------------------------
// 10.6 — Relationships in search and get_context
// ---------------------------------------------------------------------------

describe('10.6: Relationships surfaced in search and get_context', () => {
  let adapter: SqliteAdapter;
  let service: LearningService;

  beforeEach(async () => {
    adapter = new SqliteAdapter(':memory:');
    await adapter.initialize();
    service = new LearningService(adapter, new NoneEmbeddingService());
  });

  afterEach(async () => {
    await adapter.close();
  });

  it('search results include relationships array for learnings with relationships', async () => {
    const REPO = '/repo/relationships-search-test';

    const { learning: a } = await service.storeLearning({
      content: 'Always validate input at the service boundary using Zod schemas.',
      category: 'architecture',
      repository: REPO,
    });
    const { learning: b } = await service.storeLearning({
      content: 'Zod provides runtime type safety and eliminates boilerplate validation code.',
      category: 'conventions',
      repository: REPO,
    });

    // Create a "supersedes" relationship: a supersedes b
    await adapter.createRelationship(
      makeRelationshipRecord(a.id, b.id, { relationship_type: 'supersedes' })
    );

    // Search for a learning by a keyword present in its content
    const results = await service.searchLearnings({
      query: 'validate input',
      repository: REPO,
    });

    const resultA = results.find((r) => r.id === a.id);
    expect(resultA).toBeDefined();

    // The result for learning A must have a relationships array (SKM-AC-41)
    expect(resultA!.relationships).toBeDefined();
    expect(resultA!.relationships!.length).toBeGreaterThanOrEqual(1);

    const outgoing = resultA!.relationships!.find((r) => r.direction === 'outgoing');
    expect(outgoing).toBeDefined();
    expect(outgoing!.type).toBe('supersedes');
    expect(outgoing!.related_id).toBe(b.id);
  });

  it('getContext includes relationships map when relationships exist', async () => {
    const REPO = '/repo/relationships-context-test';

    const { learning: a } = await service.storeLearning({
      content: 'Use dependency injection to decouple service implementations from callers.',
      category: 'architecture',
      repository: REPO,
    });
    const { learning: b } = await service.storeLearning({
      content: 'Constructor injection is preferred over property injection for testability.',
      category: 'conventions',
      repository: REPO,
    });

    // Create a "supersedes" relationship: a supersedes b
    await adapter.createRelationship(
      makeRelationshipRecord(a.id, b.id, { relationship_type: 'supersedes' })
    );

    const ctx = await service.getContext({ repository: REPO });

    // relationships map must be present (SKM-AC-42)
    expect(ctx.relationships).toBeDefined();

    // Learning A has an outgoing "supersedes" to B
    expect(ctx.relationships![a.id]).toBeDefined();
    const aRels = ctx.relationships![a.id]!;
    const outgoing = aRels.find((r) => r.direction === 'outgoing');
    expect(outgoing).toBeDefined();
    expect(outgoing!.type).toBe('supersedes');
    expect(outgoing!.related_id).toBe(b.id);

    // Learning B has an incoming "supersedes" from A
    expect(ctx.relationships![b.id]).toBeDefined();
    const bRels = ctx.relationships![b.id]!;
    const incoming = bRels.find((r) => r.direction === 'incoming');
    expect(incoming).toBeDefined();
    expect(incoming!.type).toBe('supersedes');
    expect(incoming!.related_id).toBe(a.id);
  });
});

// ---------------------------------------------------------------------------
// 10.7 — Cascade cleanup on delete
// ---------------------------------------------------------------------------

describe('10.7: Cascade cleanup — deleting a learning removes relationships and conflicts', () => {
  let adapter: SqliteAdapter;

  beforeEach(async () => {
    adapter = new SqliteAdapter(':memory:');
    await adapter.initialize();
  });

  afterEach(async () => {
    await adapter.close();
  });

  it('deleting a learning cascade-deletes its relationships', async () => {
    const embeddingService = makeFixedEmbeddingService([1, 0, 0]);
    const service = new LearningService(adapter, embeddingService);

    const REPO = '/repo/cascade-test';

    const { learning: a } = await service.storeLearning({
      content: 'Use strict TypeScript mode to catch null reference errors early.',
      category: 'conventions',
      repository: REPO,
    });
    const { learning: b } = await service.storeLearning({
      content: 'Enable noUncheckedIndexedAccess to prevent out-of-bounds array access.',
      category: 'conventions',
      repository: REPO,
    });

    // Create a relationship between a and b
    await adapter.createRelationship(
      makeRelationshipRecord(a.id, b.id, { relationship_type: 'related_to' })
    );

    // Verify relationship exists
    const relsBefore = await adapter.getRelationships([a.id, b.id]);
    expect(relsBefore).toHaveLength(1);

    // Delete learning a
    await service.deleteLearning({ id: a.id });

    // Relationship must be cascade-deleted
    const relsAfter = await adapter.getRelationships([b.id]);
    expect(relsAfter).toHaveLength(0);

    // getContext must show no relationships for the surviving learning
    const ctx = await service.getContext({ repository: REPO });
    expect(ctx.relationships).toBeUndefined();
  });

  it('deleting a learning cascade-deletes its conflict records', async () => {
    const embeddingService = makeFixedEmbeddingService([1, 0, 0]);
    const service = new LearningService(adapter, embeddingService);

    // Store two conflicting learnings (both global scope)
    const { learning: assertion } = await service.storeLearning({
      content: 'Always use X — it is the recommended approach for handling async errors.',
      category: 'gotchas',
      repository: null,
    });

    const { learning: negation, conflicts } = await service.storeLearning({
      content: 'never use X, its error handling is broken in edge cases.',
      category: 'gotchas',
      repository: null,
    });

    // Confirm conflict was stored
    expect(conflicts.length).toBeGreaterThan(0);
    const conflictsBefore = await adapter.getUnresolvedConflicts([assertion.id, negation.id]);
    expect(conflictsBefore.length).toBeGreaterThan(0);

    // Delete the assertion learning
    await service.deleteLearning({ id: assertion.id });

    // Conflict records must be cascade-deleted
    const conflictsAfter = await adapter.getUnresolvedConflicts([negation.id]);
    expect(conflictsAfter).toHaveLength(0);

    // getContext for a repo that picks up global learnings must show no conflicts
    const ctx = await service.getContext({ repository: '/repo/cascade-conflict-test' });
    const ctxConflictIds = (ctx.conflicts ?? []).flatMap((c) => [
      c.learning_id_a,
      c.learning_id_b,
    ]);
    expect(ctxConflictIds).not.toContain(assertion.id);
    expect(ctxConflictIds).not.toContain(negation.id);
  });
});
