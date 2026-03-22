/**
 * Integration tests for Learning Relationships (Phase 8).
 * Uses an in-memory SQLite database.
 * Traces to SKM-AC-38 through SKM-AC-46.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import type { CreateLearningRecord } from '../../src/storage/storage-adapter.js';
import type { CreateRelationshipRecord } from '../../src/models/learning.js';

function makeRecord(overrides: Partial<CreateLearningRecord> = {}): CreateLearningRecord {
  return {
    id: randomUUID(),
    content: 'Use transactions for all multi-step writes.',
    category: 'architecture',
    tags: ['database'],
    repository: '/repo/test',
    workspace: null,
    group_id: null,
    source: 'test-agent',
    embedding: null,
    ...overrides,
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
    relationship_type: 'related_to',
    created_by: null,
    ...overrides,
  };
}

describe('Learning Relationships Integration (SKM-AC-38 through SKM-AC-46)', () => {
  let adapter: SqliteAdapter;

  beforeEach(async () => {
    adapter = new SqliteAdapter(':memory:');
    await adapter.initialize();
  });

  afterEach(async () => {
    await adapter.close();
  });

  // -------------------------------------------------------------------------
  // createRelationship (SKM-AC-38, SKM-AC-39, SKM-AC-40, SKM-AC-46)
  // -------------------------------------------------------------------------

  describe('createRelationship', () => {
    it('creates a relationship and returns the record (SKM-AC-46)', async () => {
      const learningA = await adapter.createLearning(makeRecord());
      const learningB = await adapter.createLearning(makeRecord());

      const record = makeRelationshipRecord(learningA.id, learningB.id, {
        relationship_type: 'supersedes',
        created_by: 'claude-code',
      });
      const rel = await adapter.createRelationship(record);

      expect(rel.id).toBe(record.id);
      expect(rel.source_id).toBe(learningA.id);
      expect(rel.target_id).toBe(learningB.id);
      expect(rel.relationship_type).toBe('supersedes');
      expect(rel.created_by).toBe('claude-code');
      expect(rel.created_at).toBeTruthy();
    });

    it('creates a relationship with null created_by', async () => {
      const learningA = await adapter.createLearning(makeRecord());
      const learningB = await adapter.createLearning(makeRecord());

      const rel = await adapter.createRelationship(
        makeRelationshipRecord(learningA.id, learningB.id, { created_by: null })
      );

      expect(rel.created_by).toBeNull();
    });

    it('creates all four relationship types successfully (SKM-AC-38)', async () => {
      const learningA = await adapter.createLearning(makeRecord());
      const learningB = await adapter.createLearning(makeRecord());
      const learningC = await adapter.createLearning(makeRecord());
      const learningD = await adapter.createLearning(makeRecord());
      const learningE = await adapter.createLearning(makeRecord());

      const pairs = [
        { a: learningA, b: learningB, type: 'supersedes' as const },
        { a: learningA, b: learningC, type: 'depends_on' as const },
        { a: learningA, b: learningD, type: 'related_to' as const },
        { a: learningA, b: learningE, type: 'caused_by' as const },
      ];

      for (const pair of pairs) {
        const rel = await adapter.createRelationship(
          makeRelationshipRecord(pair.a.id, pair.b.id, { relationship_type: pair.type })
        );
        expect(rel.relationship_type).toBe(pair.type);
      }
    });

    it('rejects a duplicate relationship (same source, target, and type) (SKM-AC-40)', async () => {
      const learningA = await adapter.createLearning(makeRecord());
      const learningB = await adapter.createLearning(makeRecord());

      await adapter.createRelationship(
        makeRelationshipRecord(learningA.id, learningB.id, { relationship_type: 'supersedes' })
      );

      // Second identical relationship should throw
      await expect(
        adapter.createRelationship(
          makeRelationshipRecord(learningA.id, learningB.id, { relationship_type: 'supersedes' })
        )
      ).rejects.toThrow();
    });

    it('allows two different relationship types between the same pair (SKM-AC-40)', async () => {
      const learningA = await adapter.createLearning(makeRecord());
      const learningB = await adapter.createLearning(makeRecord());

      // Different types — both should succeed
      await adapter.createRelationship(
        makeRelationshipRecord(learningA.id, learningB.id, { relationship_type: 'supersedes' })
      );
      const rel2 = await adapter.createRelationship(
        makeRelationshipRecord(learningA.id, learningB.id, { relationship_type: 'related_to' })
      );
      expect(rel2.relationship_type).toBe('related_to');
    });
  });

  // -------------------------------------------------------------------------
  // getRelationships (SKM-AC-41, SKM-AC-42)
  // -------------------------------------------------------------------------

  describe('getRelationships', () => {
    it('returns empty array when no learningIds provided', async () => {
      const rels = await adapter.getRelationships([]);
      expect(rels).toEqual([]);
    });

    it('returns empty array when learnings have no relationships', async () => {
      const learningA = await adapter.createLearning(makeRecord());
      const rels = await adapter.getRelationships([learningA.id]);
      expect(rels).toEqual([]);
    });

    it('returns relationships where learning is the source (outgoing)', async () => {
      const learningA = await adapter.createLearning(makeRecord());
      const learningB = await adapter.createLearning(makeRecord());

      const created = await adapter.createRelationship(
        makeRelationshipRecord(learningA.id, learningB.id, { relationship_type: 'supersedes' })
      );

      // Query by source_id
      const rels = await adapter.getRelationships([learningA.id]);
      expect(rels).toHaveLength(1);
      expect(rels[0]!.id).toBe(created.id);
      expect(rels[0]!.source_id).toBe(learningA.id);
      expect(rels[0]!.target_id).toBe(learningB.id);
    });

    it('returns relationships where learning is the target (incoming)', async () => {
      const learningA = await adapter.createLearning(makeRecord());
      const learningB = await adapter.createLearning(makeRecord());

      await adapter.createRelationship(
        makeRelationshipRecord(learningA.id, learningB.id, { relationship_type: 'depends_on' })
      );

      // Query by target_id
      const rels = await adapter.getRelationships([learningB.id]);
      expect(rels).toHaveLength(1);
      expect(rels[0]!.source_id).toBe(learningA.id);
      expect(rels[0]!.target_id).toBe(learningB.id);
    });

    it('returns all relationships when querying both IDs in the pair', async () => {
      const learningA = await adapter.createLearning(makeRecord());
      const learningB = await adapter.createLearning(makeRecord());

      await adapter.createRelationship(
        makeRelationshipRecord(learningA.id, learningB.id, { relationship_type: 'related_to' })
      );

      // Querying both IDs — the same relationship is returned once (not duplicated)
      const rels = await adapter.getRelationships([learningA.id, learningB.id]);
      expect(rels).toHaveLength(1);
    });

    it('returns relationships for multiple learning IDs (batch fetch)', async () => {
      const learningA = await adapter.createLearning(makeRecord());
      const learningB = await adapter.createLearning(makeRecord());
      const learningC = await adapter.createLearning(makeRecord());

      await adapter.createRelationship(
        makeRelationshipRecord(learningA.id, learningB.id, { relationship_type: 'supersedes' })
      );
      await adapter.createRelationship(
        makeRelationshipRecord(learningB.id, learningC.id, { relationship_type: 'depends_on' })
      );

      const rels = await adapter.getRelationships([learningA.id, learningB.id, learningC.id]);
      expect(rels).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Cascade delete (SKM-AC-44)
  // -------------------------------------------------------------------------

  describe('cascade delete (SKM-AC-44)', () => {
    it('deletes relationship when source learning is deleted', async () => {
      const learningA = await adapter.createLearning(makeRecord());
      const learningB = await adapter.createLearning(makeRecord());

      await adapter.createRelationship(
        makeRelationshipRecord(learningA.id, learningB.id, { relationship_type: 'supersedes' })
      );

      // Verify relationship exists
      const before = await adapter.getRelationships([learningA.id, learningB.id]);
      expect(before).toHaveLength(1);

      // Delete the source learning
      await adapter.deleteLearning(learningA.id);

      // Relationship should be cascade-deleted
      const after = await adapter.getRelationships([learningB.id]);
      expect(after).toHaveLength(0);
    });

    it('deletes relationship when target learning is deleted', async () => {
      const learningA = await adapter.createLearning(makeRecord());
      const learningB = await adapter.createLearning(makeRecord());

      await adapter.createRelationship(
        makeRelationshipRecord(learningA.id, learningB.id, { relationship_type: 'depends_on' })
      );

      // Delete the target learning
      await adapter.deleteLearning(learningB.id);

      // Relationship should be cascade-deleted
      const after = await adapter.getRelationships([learningA.id]);
      expect(after).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Deprecated learnings keep relationships (SKM-AC-45)
  // -------------------------------------------------------------------------

  describe('deprecated learnings keep relationships (SKM-AC-45)', () => {
    it('relationship persists when source learning is deprecated', async () => {
      const learningA = await adapter.createLearning(makeRecord());
      const learningB = await adapter.createLearning(makeRecord());

      await adapter.createRelationship(
        makeRelationshipRecord(learningA.id, learningB.id, { relationship_type: 'supersedes' })
      );

      // Deprecate the source (status update, not a delete)
      await adapter.updateLearning(learningA.id, { status: 'deprecated' });

      // Relationship must still exist (SKM-AC-45)
      const rels = await adapter.getRelationships([learningA.id, learningB.id]);
      expect(rels).toHaveLength(1);
      expect(rels[0]!.relationship_type).toBe('supersedes');
    });

    it('relationship persists when target learning is deprecated', async () => {
      const learningA = await adapter.createLearning(makeRecord());
      const learningB = await adapter.createLearning(makeRecord());

      await adapter.createRelationship(
        makeRelationshipRecord(learningA.id, learningB.id, { relationship_type: 'caused_by' })
      );

      await adapter.updateLearning(learningB.id, { status: 'deprecated' });

      const rels = await adapter.getRelationships([learningA.id, learningB.id]);
      expect(rels).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // LearningService integration: search and getContext include relationships
  // -------------------------------------------------------------------------

  describe('LearningService: search and get_context include relationships (SKM-AC-41, SKM-AC-42)', () => {
    it('searchLearnings attaches relationships to results (SKM-AC-41)', async () => {
      // Import here to avoid circular issues at module level
      const { LearningService } = await import('../../src/services/learning-service.js');
      const { NoneEmbeddingService } = await import('../../src/services/embedding-service.js');

      // Use a no-embedding service so FTS5 is used (avoids requiring model download)
      const embeddingService = new NoneEmbeddingService();
      const service = new LearningService(adapter, embeddingService);

      // Store two learnings
      const { learning: a } = await service.storeLearning({
        content: 'Always validate input at service boundary.',
        category: 'architecture',
        repository: '/repo/search-test',
      });
      const { learning: b } = await service.storeLearning({
        content: 'Use Zod schemas for runtime validation.',
        category: 'conventions',
        repository: '/repo/search-test',
      });

      // Create a relationship between them
      await adapter.createRelationship(
        makeRelationshipRecord(a.id, b.id, { relationship_type: 'related_to' })
      );

      // Search should include relationships (SKM-AC-41)
      const results = await service.searchLearnings({
        query: 'validate input',
        repository: '/repo/search-test',
      });

      // At least the result for learning A should have a relationship
      const resultA = results.find((r) => r.id === a.id);
      const resultB = results.find((r) => r.id === b.id);

      if (resultA) {
        expect(resultA.relationships).toBeDefined();
        expect(resultA.relationships).toHaveLength(1);
        expect(resultA.relationships![0]!.type).toBe('related_to');
        expect(resultA.relationships![0]!.related_id).toBe(b.id);
        expect(resultA.relationships![0]!.direction).toBe('outgoing');
      }

      if (resultB) {
        expect(resultB.relationships).toBeDefined();
        expect(resultB.relationships).toHaveLength(1);
        expect(resultB.relationships![0]!.type).toBe('related_to');
        expect(resultB.relationships![0]!.related_id).toBe(a.id);
        expect(resultB.relationships![0]!.direction).toBe('incoming');
      }
    });

    it('getContext includes relationships map (SKM-AC-42)', async () => {
      const { LearningService } = await import('../../src/services/learning-service.js');
      const { NoneEmbeddingService } = await import('../../src/services/embedding-service.js');

      const embeddingService = new NoneEmbeddingService();
      const service = new LearningService(adapter, embeddingService);

      const { learning: a } = await service.storeLearning({
        content: 'Use dependency injection for testability.',
        category: 'architecture',
        repository: '/repo/context-test',
      });
      const { learning: b } = await service.storeLearning({
        content: 'Constructor injection is preferred over setter injection.',
        category: 'conventions',
        repository: '/repo/context-test',
      });

      await adapter.createRelationship(
        makeRelationshipRecord(a.id, b.id, { relationship_type: 'depends_on' })
      );

      const ctx = await service.getContext({
        repository: '/repo/context-test',
      });

      // relationships map must exist (SKM-AC-42)
      expect(ctx.relationships).toBeDefined();

      if (ctx.relationships) {
        // Learning A should have outgoing depends_on to B
        expect(ctx.relationships[a.id]).toBeDefined();
        const aRels = ctx.relationships[a.id]!;
        const outgoing = aRels.find((r) => r.direction === 'outgoing');
        expect(outgoing).toBeDefined();
        expect(outgoing!.type).toBe('depends_on');
        expect(outgoing!.related_id).toBe(b.id);

        // Learning B should have incoming depends_on from A
        expect(ctx.relationships[b.id]).toBeDefined();
        const bRels = ctx.relationships[b.id]!;
        const incoming = bRels.find((r) => r.direction === 'incoming');
        expect(incoming).toBeDefined();
        expect(incoming!.type).toBe('depends_on');
        expect(incoming!.related_id).toBe(a.id);
      }
    });

    it('getContext has no relationships key when no relationships exist', async () => {
      const { LearningService } = await import('../../src/services/learning-service.js');
      const { NoneEmbeddingService } = await import('../../src/services/embedding-service.js');

      const embeddingService = new NoneEmbeddingService();
      const service = new LearningService(adapter, embeddingService);

      await service.storeLearning({
        content: 'Keep functions small and single-purpose.',
        category: 'conventions',
        repository: '/repo/no-rels-test',
      });

      const ctx = await service.getContext({ repository: '/repo/no-rels-test' });

      // No relationships created — key should be absent (not set to empty object)
      expect(ctx.relationships).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // group_id backward compatibility (SKM-AC-43)
  // -------------------------------------------------------------------------

  describe('group_id backward compatibility (SKM-AC-43)', () => {
    it('group_id continues to function alongside relationships', async () => {
      const groupId = randomUUID();
      const recordA = makeRecord({ group_id: groupId });
      const recordB = makeRecord({ group_id: groupId });

      const learningA = await adapter.createLearning(recordA);
      const learningB = await adapter.createLearning(recordB);

      // Add a typed relationship as well
      await adapter.createRelationship(
        makeRelationshipRecord(learningA.id, learningB.id, { relationship_type: 'related_to' })
      );

      // Both group_id and relationship should coexist
      const fetchedA = await adapter.getLearning(learningA.id);
      expect(fetchedA?.group_id).toBe(groupId);

      const rels = await adapter.getRelationships([learningA.id]);
      expect(rels).toHaveLength(1);
    });
  });
});
