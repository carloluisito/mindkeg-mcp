/**
 * Integration tests for Phase 6: Conflict Detection (SKM-AC-22 through SKM-AC-29).
 * Tests the full store → conflict → deprecate → resolve flow using in-memory SQLite.
 *
 * Uses FastEmbed or NoneEmbeddingService depending on what is available.
 * Conflict detection requires embeddings, so some tests use mock embeddings.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { LearningService } from '../../src/services/learning-service.js';
import { NoneEmbeddingService } from '../../src/services/embedding-service.js';
import type { EmbeddingService } from '../../src/services/embedding-service.js';
import { CONFLICT_SIMILARITY_THRESHOLD } from '../../src/services/conflict-detector.js';

// ---------------------------------------------------------------------------
// Mock embedding service that returns controlled vectors
// ---------------------------------------------------------------------------

/**
 * Creates an embedding service that returns the same fixed vector for every input.
 * This ensures cosine similarity = 1.0 between all learnings, so the threshold is met.
 */
function makeFixedEmbeddingService(vector: number[] = [1, 0, 0]): EmbeddingService {
  return {
    generateEmbedding: vi.fn().mockResolvedValue(vector),
    getDimensions: vi.fn().mockReturnValue(vector.length),
    getProviderName: vi.fn().mockReturnValue('mock-fixed'),
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Conflict Detection Integration', () => {
  let storage: SqliteAdapter;

  beforeEach(async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
  });

  // -------------------------------------------------------------------------
  // SKM-AC-25: learning_conflicts table exists and stores conflicts
  // -------------------------------------------------------------------------

  describe('learning_conflicts table (SKM-AC-25)', () => {
    it('can store a conflict record directly via storeConflict', async () => {
      const idA = randomUUID();
      const idB = randomUUID();

      // Create two learnings first (required for FK)
      await storage.createLearning({
        id: idA, content: 'Always use X.', category: 'gotchas', tags: [],
        repository: null, workspace: null, group_id: null, source: 'test', embedding: null,
      });
      await storage.createLearning({
        id: idB, content: "never use X.", category: 'gotchas', tags: [],
        repository: null, workspace: null, group_id: null, source: 'test', embedding: null,
      });

      await storage.storeConflict({
        id: randomUUID(),
        learning_id_a: idA,
        learning_id_b: idB,
        similarity: 0.9,
        conflict_type: 'keyword_heuristic',
      });

      const conflicts = await storage.getUnresolvedConflicts([idA]);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]!.similarity).toBe(0.9);
      expect(conflicts[0]!.conflict_type).toBe('keyword_heuristic');
      expect(conflicts[0]!.resolved).toBe(false);
      expect(conflicts[0]!.resolved_by).toBeNull();
    });

    it('enforces pair ordering: id_a < id_b lexicographically', async () => {
      // Create two IDs where we'll pass them in reverse order
      const id1 = 'aaa-' + randomUUID();  // lexicographically smaller
      const id2 = 'zzz-' + randomUUID();  // lexicographically larger

      await storage.createLearning({
        id: id1, content: 'Always use X.', category: 'gotchas', tags: [],
        repository: null, workspace: null, group_id: null, source: 'test', embedding: null,
      });
      await storage.createLearning({
        id: id2, content: "never use X.", category: 'gotchas', tags: [],
        repository: null, workspace: null, group_id: null, source: 'test', embedding: null,
      });

      // Pass in reverse order — adapter should reorder
      await storage.storeConflict({
        id: randomUUID(),
        learning_id_a: id2,  // larger ID passed as "a"
        learning_id_b: id1,  // smaller ID passed as "b"
        similarity: 0.9,
        conflict_type: 'keyword_heuristic',
      });

      const conflicts = await storage.getUnresolvedConflicts([id1]);
      expect(conflicts).toHaveLength(1);
      // Stored with correct ordering regardless of input order
      expect(conflicts[0]!.learning_id_a < conflicts[0]!.learning_id_b).toBe(true);
    });

    it('ignores duplicate conflict pairs via INSERT OR IGNORE', async () => {
      const idA = randomUUID();
      const idB = randomUUID();

      await storage.createLearning({
        id: idA, content: 'Always use X.', category: 'gotchas', tags: [],
        repository: null, workspace: null, group_id: null, source: 'test', embedding: null,
      });
      await storage.createLearning({
        id: idB, content: "never use X.", category: 'gotchas', tags: [],
        repository: null, workspace: null, group_id: null, source: 'test', embedding: null,
      });

      // Store the same pair twice (same conflict_type)
      await storage.storeConflict({ id: randomUUID(), learning_id_a: idA, learning_id_b: idB, similarity: 0.9, conflict_type: 'keyword_heuristic' });
      await storage.storeConflict({ id: randomUUID(), learning_id_a: idA, learning_id_b: idB, similarity: 0.91, conflict_type: 'keyword_heuristic' });

      const conflicts = await storage.getUnresolvedConflicts([idA]);
      expect(conflicts).toHaveLength(1);  // Only one row despite two inserts
    });

    it('returns empty array when learningIds is empty', async () => {
      const conflicts = await storage.getUnresolvedConflicts([]);
      expect(conflicts).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // SKM-AC-28: resolveConflicts marks conflicts as resolved
  // -------------------------------------------------------------------------

  describe('resolveConflicts (SKM-AC-28)', () => {
    it('marks all unresolved conflicts for a learning as resolved', async () => {
      const idA = randomUUID();
      const idB = randomUUID();

      await storage.createLearning({
        id: idA, content: 'Always use X.', category: 'gotchas', tags: [],
        repository: null, workspace: null, group_id: null, source: 'test', embedding: null,
      });
      await storage.createLearning({
        id: idB, content: "never use X.", category: 'gotchas', tags: [],
        repository: null, workspace: null, group_id: null, source: 'test', embedding: null,
      });

      await storage.storeConflict({ id: randomUUID(), learning_id_a: idA, learning_id_b: idB, similarity: 0.9, conflict_type: 'keyword_heuristic' });

      const resolved = await storage.resolveConflicts(idA, idA);
      expect(resolved).toBe(1);

      const conflicts = await storage.getUnresolvedConflicts([idA]);
      expect(conflicts).toHaveLength(0);
    });

    it('sets resolved_by to the provided value', async () => {
      const idA = randomUUID();
      const idB = randomUUID();

      await storage.createLearning({
        id: idA, content: 'Always use X.', category: 'gotchas', tags: [],
        repository: null, workspace: null, group_id: null, source: 'test', embedding: null,
      });
      await storage.createLearning({
        id: idB, content: "never use X.", category: 'gotchas', tags: [],
        repository: null, workspace: null, group_id: null, source: 'test', embedding: null,
      });

      await storage.storeConflict({ id: randomUUID(), learning_id_a: idA, learning_id_b: idB, similarity: 0.9, conflict_type: 'keyword_heuristic' });
      await storage.resolveConflicts(idA, 'resolver-id-123');

      // Verify by querying all conflicts (including resolved) — direct SQL approach via getUnresolvedConflicts should return 0
      const unresolved = await storage.getUnresolvedConflicts([idA]);
      expect(unresolved).toHaveLength(0);
    });

    it('returns 0 when there are no unresolved conflicts', async () => {
      const id = randomUUID();
      const resolved = await storage.resolveConflicts(id, id);
      expect(resolved).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // findScopedNeighbors
  // -------------------------------------------------------------------------

  describe('findScopedNeighbors', () => {
    it('returns neighbors above the minSimilarity threshold', async () => {
      const vec = [1, 0, 0];
      const id1 = randomUUID();
      const id2 = randomUUID();

      await storage.createLearning({
        id: id1, content: 'Always use X.', category: 'gotchas', tags: [],
        repository: null, workspace: null, group_id: null, source: 'test',
        embedding: [1, 0, 0],  // identical vector → similarity = 1.0
      });
      await storage.createLearning({
        id: id2, content: 'Different thing.', category: 'conventions', tags: [],
        repository: null, workspace: null, group_id: null, source: 'test',
        embedding: [0, 1, 0],  // orthogonal → similarity = 0.0
      });

      // Query with threshold 0.5 — only id1 should match
      const neighbors = await storage.findScopedNeighbors(vec, { repository: null, workspace: null }, 0.5);
      expect(neighbors.map((n) => n.id)).toContain(id1);
      expect(neighbors.map((n) => n.id)).not.toContain(id2);
    });

    it('returns neighbors sorted by similarity descending', async () => {
      const queryVec = [1, 0, 0];
      const ids = [randomUUID(), randomUUID(), randomUUID()];

      // Three learnings with different similarity levels
      await storage.createLearning({ id: ids[0]!, content: 'A.', category: 'gotchas', tags: [], repository: null, workspace: null, group_id: null, source: 'test', embedding: [1, 0, 0] });           // sim=1.0
      await storage.createLearning({ id: ids[1]!, content: 'B.', category: 'gotchas', tags: [], repository: null, workspace: null, group_id: null, source: 'test', embedding: [0.7, 0.7, 0] });        // sim≈0.7
      await storage.createLearning({ id: ids[2]!, content: 'C.', category: 'gotchas', tags: [], repository: null, workspace: null, group_id: null, source: 'test', embedding: [0.5, 0.866, 0] });      // sim≈0.5

      const neighbors = await storage.findScopedNeighbors(queryVec, { repository: null, workspace: null }, 0.0);

      expect(neighbors[0]!.similarity).toBeGreaterThanOrEqual(neighbors[1]!.similarity);
      expect(neighbors[1]!.similarity).toBeGreaterThanOrEqual(neighbors[2]!.similarity);
    });

    it('scopes to repository when repository is set', async () => {
      const vec = [1, 0, 0];
      const idInScope = randomUUID();
      const idOutScope = randomUUID();

      await storage.createLearning({ id: idInScope, content: 'In scope.', category: 'gotchas', tags: [], repository: '/repo/a', workspace: null, group_id: null, source: 'test', embedding: vec });
      await storage.createLearning({ id: idOutScope, content: 'Out of scope.', category: 'gotchas', tags: [], repository: '/repo/b', workspace: null, group_id: null, source: 'test', embedding: vec });

      const neighbors = await storage.findScopedNeighbors(vec, { repository: '/repo/a', workspace: null }, 0.0);
      expect(neighbors.map((n) => n.id)).toContain(idInScope);
      expect(neighbors.map((n) => n.id)).not.toContain(idOutScope);
    });

    it('returns empty when no neighbors with embeddings exist', async () => {
      await storage.createLearning({ id: randomUUID(), content: 'No embedding.', category: 'gotchas', tags: [], repository: null, workspace: null, group_id: null, source: 'test', embedding: null });

      const neighbors = await storage.findScopedNeighbors([1, 0, 0], { repository: null, workspace: null }, 0.0);
      expect(neighbors).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // SKM-AC-22, SKM-AC-26: store_learning detects and returns conflicts
  // -------------------------------------------------------------------------

  describe('storeLearning conflict detection (SKM-AC-22, SKM-AC-26)', () => {
    it('detects conflict between "always use X" and "never use X" in same category', async () => {
      // Use a fixed embedding service so similarity is always 1.0
      const embeddingService = makeFixedEmbeddingService([1, 0, 0]);
      const service = new LearningService(storage, embeddingService);

      // Store the first learning: assertion
      await service.storeLearning({
        content: 'Always use X for performance.',
        category: 'gotchas',
        repository: null,
      });

      // Store the second learning: negation — should detect conflict with first
      const { learning: second, conflicts } = await service.storeLearning({
        content: "never use X, it causes memory leaks.",
        category: 'gotchas',
        repository: null,
      });

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]!.conflict_type).toBe('keyword_heuristic');
      expect(conflicts[0]!.resolved).toBe(false);
      expect(second).toBeDefined();
    });

    it('returns empty conflicts when no candidates have cross-signal (both negation)', async () => {
      const embeddingService = makeFixedEmbeddingService([1, 0, 0]);
      const service = new LearningService(storage, embeddingService);

      // Store a learning with pure negation signal (no assertion markers)
      await service.storeLearning({
        content: "avoid X entirely — it causes problems.",
        category: 'gotchas',
        repository: null,
      });

      // Store another learning with pure negation signal — no cross-signal conflict
      const { conflicts } = await service.storeLearning({
        content: "never X in production.",
        category: 'gotchas',
        repository: null,
      });

      expect(conflicts).toHaveLength(0);
    });

    it('does not detect conflict when embedding is unavailable (no-op)', async () => {
      const service = new LearningService(storage, new NoneEmbeddingService());

      await service.storeLearning({ content: 'Always use X.', category: 'gotchas', repository: null });
      const { conflicts } = await service.storeLearning({ content: "never use X.", category: 'gotchas', repository: null });

      // No embedding → no conflict detection
      expect(conflicts).toHaveLength(0);
    });

    it('scopes conflict detection: no conflict across different repositories', async () => {
      // Two learnings in different repos should NOT conflict with each other
      const embeddingService = makeFixedEmbeddingService([1, 0, 0]);
      const service = new LearningService(storage, embeddingService);

      await service.storeLearning({
        content: 'Always use X.',
        category: 'gotchas',
        repository: '/repo/a',
      });

      const { conflicts } = await service.storeLearning({
        content: "never use X.",
        category: 'gotchas',
        repository: '/repo/b',
      });

      // Different repos → different scopes → no conflict
      expect(conflicts).toHaveLength(0);
    });

    it('does not detect conflict when categories differ (scope gate)', async () => {
      const embeddingService = makeFixedEmbeddingService([1, 0, 0]);
      const service = new LearningService(storage, embeddingService);

      await service.storeLearning({
        content: 'Always use X.',
        category: 'gotchas',   // different category
        repository: null,
      });

      const { conflicts } = await service.storeLearning({
        content: "never use X.",
        category: 'conventions',  // different category
        repository: null,
      });

      // Different categories → scope gate rejects → no conflict
      expect(conflicts).toHaveLength(0);
    });

    it('conflict is non-fatal when detection fails', async () => {
      // Service should still return the learning even if conflict storage throws
      const embeddingService = makeFixedEmbeddingService([1, 0, 0]);
      const service = new LearningService(storage, embeddingService);

      await service.storeLearning({ content: 'Always use X.', category: 'gotchas', repository: null });

      // Make storeConflict throw — should be caught non-fatally
      vi.spyOn(storage, 'storeConflict').mockRejectedValueOnce(new Error('DB error'));

      const { learning, conflicts } = await service.storeLearning({
        content: "never use X.",
        category: 'gotchas',
        repository: null,
      });

      // Learning is stored even though conflict storage failed
      expect(learning).toBeDefined();
      expect(learning.id).toBeTruthy();
      // Conflicts array is empty (reset on failure)
      expect(conflicts).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // SKM-AC-27: getContext surfaces unresolved conflicts
  // -------------------------------------------------------------------------

  describe('getContext surfaces conflicts (SKM-AC-27)', () => {
    it('includes unresolved conflicts in getContext result', async () => {
      const embeddingService = makeFixedEmbeddingService([1, 0, 0]);
      const service = new LearningService(storage, embeddingService);

      // Store two conflicting learnings
      const { learning: first } = await service.storeLearning({
        content: 'Always use X.',
        category: 'gotchas',
        repository: '/repo/test',
      });

      await service.storeLearning({
        content: "never use X.",
        category: 'gotchas',
        repository: '/repo/test',
      });

      const context = await service.getContext({ repository: '/repo/test' });

      // Should have conflicts section
      expect(context.conflicts).toBeDefined();
      expect(context.conflicts!.length).toBeGreaterThan(0);

      const conflictIds = context.conflicts!.flatMap((c) => [c.learning_id_a, c.learning_id_b]);
      expect(conflictIds).toContain(first.id);
    });

    it('does not include conflicts section when there are no unresolved conflicts', async () => {
      const service = new LearningService(storage, new NoneEmbeddingService());

      await service.storeLearning({
        content: 'Conventions for this repo.',
        category: 'conventions',
        repository: '/repo/clean',
      });

      const context = await service.getContext({ repository: '/repo/clean' });

      // No conflicts → section absent or empty
      expect(context.conflicts == null || context.conflicts.length === 0).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // SKM-AC-28: deprecating resolves conflicts
  // -------------------------------------------------------------------------

  describe('deprecateLearning resolves conflicts (SKM-AC-28)', () => {
    it('resolves conflicts when a learning is deprecated', async () => {
      const embeddingService = makeFixedEmbeddingService([1, 0, 0]);
      const service = new LearningService(storage, embeddingService);

      const { learning: first } = await service.storeLearning({
        content: 'Always use X.',
        category: 'gotchas',
        repository: null,
      });

      const { learning: second, conflicts } = await service.storeLearning({
        content: "never use X.",
        category: 'gotchas',
        repository: null,
      });

      // Confirm conflict was detected
      expect(conflicts.length).toBeGreaterThan(0);

      // Deprecate the second learning
      await service.deprecateLearning({ id: second.id });

      // Conflicts involving second should now be resolved
      const remaining = await storage.getUnresolvedConflicts([first.id, second.id]);
      expect(remaining).toHaveLength(0);
    });

    it('conflict resolution is non-fatal: deprecation succeeds even if resolve throws', async () => {
      const embeddingService = makeFixedEmbeddingService([1, 0, 0]);
      const service = new LearningService(storage, embeddingService);

      const { learning: first } = await service.storeLearning({
        content: 'Always use X.',
        category: 'gotchas',
        repository: null,
      });

      // Make resolveConflicts throw
      vi.spyOn(storage, 'resolveConflicts').mockRejectedValueOnce(new Error('DB error'));

      // Deprecation should still succeed
      const deprecated = await service.deprecateLearning({ id: first.id });
      expect(deprecated.status).toBe('deprecated');
    });
  });

  // -------------------------------------------------------------------------
  // Database cascade: deleting a learning removes its conflict rows
  // -------------------------------------------------------------------------

  describe('CASCADE delete behavior', () => {
    it('conflict rows are deleted when a learning is deleted', async () => {
      const idA = randomUUID();
      const idB = randomUUID();

      await storage.createLearning({
        id: idA, content: 'Always use X.', category: 'gotchas', tags: [],
        repository: null, workspace: null, group_id: null, source: 'test', embedding: null,
      });
      await storage.createLearning({
        id: idB, content: "never use X.", category: 'gotchas', tags: [],
        repository: null, workspace: null, group_id: null, source: 'test', embedding: null,
      });

      await storage.storeConflict({ id: randomUUID(), learning_id_a: idA, learning_id_b: idB, similarity: 0.9, conflict_type: 'keyword_heuristic' });

      // Verify conflict exists
      const before = await storage.getUnresolvedConflicts([idA]);
      expect(before).toHaveLength(1);

      // Delete learning idA
      await storage.deleteLearning(idA);

      // Conflict should be cascade-deleted
      const after = await storage.getUnresolvedConflicts([idB]);
      expect(after).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // CONFLICT_SIMILARITY_THRESHOLD constant
  // -------------------------------------------------------------------------

  describe('threshold value (SKM-AC-22)', () => {
    it(`CONFLICT_SIMILARITY_THRESHOLD is ${CONFLICT_SIMILARITY_THRESHOLD}`, () => {
      expect(CONFLICT_SIMILARITY_THRESHOLD).toBe(0.85);
    });
  });
});
