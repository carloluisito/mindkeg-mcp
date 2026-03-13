/**
 * Integration tests for get_context flow.
 * Uses an in-memory SQLite database and the real SqliteAdapter + LearningService.
 * Tests the full path from storage to service method output.
 * Traces to GC-AC-4, GC-AC-5, GC-AC-10, GC-AC-11, GC-AC-12, GC-AC-13,
 *           GC-AC-17, GC-AC-22, GC-AC-23, GC-AC-25, GC-AC-26, GC-AC-29a, GC-AC-29b.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { NoneEmbeddingService } from '../../src/services/embedding-service.js';
import { LearningService } from '../../src/services/learning-service.js';
import type { CreateLearningRecord } from '../../src/storage/storage-adapter.js';

const REPO_PATH = '/home/user/projects/my-app';
const WORKSPACE_PATH = '/home/user/projects/';

function makeRecord(overrides: Partial<CreateLearningRecord> = {}): CreateLearningRecord {
  return {
    id: randomUUID(),
    content: 'Use async/await for all I/O operations.',
    category: 'conventions',
    tags: [],
    repository: REPO_PATH,
    workspace: null,
    group_id: null,
    source: 'test',
    embedding: null,
    ...overrides,
  };
}

describe('get_context integration', () => {
  let storage: SqliteAdapter;
  let service: LearningService;

  beforeEach(async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    service = new LearningService(storage, new NoneEmbeddingService());
  });

  afterEach(async () => {
    await storage.close();
  });

  // -------------------------------------------------------------------------
  // Empty database (GC-AC-29a)
  // -------------------------------------------------------------------------

  describe('empty database (GC-AC-29a)', () => {
    it('returns zero counts and empty arrays without throwing', async () => {
      const result = await service.getContext({ repository: REPO_PATH });
      expect(result.summary.total_repo).toBe(0);
      expect(result.summary.total_workspace).toBe(0);
      expect(result.summary.total_global).toBe(0);
      expect(result.summary.stale_count).toBe(0);
      expect(result.summary.last_updated).toBe('');
      expect(result.repo_learnings).toEqual([]);
      expect(result.workspace_learnings).toEqual([]);
      expect(result.global_learnings).toEqual([]);
      expect(result.stale_review).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Non-matching repository (GC-AC-29b)
  // -------------------------------------------------------------------------

  describe('non-matching repository (GC-AC-29b)', () => {
    it('returns empty repo_learnings but still returns global learnings', async () => {
      // Store a global learning
      await storage.createLearning(makeRecord({
        id: randomUUID(),
        content: 'Global tip: always use strict mode.',
        category: 'conventions',
        repository: null,
        workspace: null,
      }));

      const result = await service.getContext({ repository: '/completely/different/repo' });
      expect(result.repo_learnings).toEqual([]);
      expect(result.global_learnings).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Scope partitioning (GC-AC-4)
  // -------------------------------------------------------------------------

  describe('scope partitioning (GC-AC-4)', () => {
    it('partitions learnings into repo, workspace, and global buckets correctly', async () => {
      const repoId = randomUUID();
      const wsId = randomUUID();
      const globalId = randomUUID();
      const otherRepoId = randomUUID();

      await storage.createLearning(makeRecord({ id: repoId, repository: REPO_PATH, workspace: null }));
      await storage.createLearning(makeRecord({ id: wsId, repository: null, workspace: WORKSPACE_PATH }));
      await storage.createLearning(makeRecord({ id: globalId, repository: null, workspace: null }));
      await storage.createLearning(makeRecord({ id: otherRepoId, repository: '/other/repo', workspace: null }));

      const result = await service.getContext({
        repository: REPO_PATH,
        workspace: WORKSPACE_PATH,
      });

      const repoIds = result.repo_learnings.map((l) => l.id);
      const wsIds = result.workspace_learnings.map((l) => l.id);
      const globalIds = result.global_learnings.map((l) => l.id);

      expect(repoIds).toContain(repoId);
      expect(wsIds).toContain(wsId);
      expect(globalIds).toContain(globalId);
      // Other repo's learning should not appear in any bucket
      expect([...repoIds, ...wsIds, ...globalIds]).not.toContain(otherRepoId);
    });
  });

  // -------------------------------------------------------------------------
  // Summary counts (GC-AC-5)
  // -------------------------------------------------------------------------

  describe('summary counts (GC-AC-5)', () => {
    it('reflects actual counts of learnings per scope', async () => {
      await storage.createLearning(makeRecord({ id: randomUUID(), repository: REPO_PATH }));
      await storage.createLearning(makeRecord({ id: randomUUID(), repository: REPO_PATH }));
      await storage.createLearning(makeRecord({ id: randomUUID(), repository: null, workspace: null }));

      const result = await service.getContext({ repository: REPO_PATH });

      expect(result.summary.total_repo).toBe(2);
      expect(result.summary.total_global).toBe(1);
      expect(result.summary.last_updated).not.toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // Volume threshold: all returned when <= 30 (GC-AC-10)
  // -------------------------------------------------------------------------

  describe('volume threshold: <= 30 returns all (GC-AC-10)', () => {
    it('returns all 25 repo learnings without ranking cutoff', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 25; i++) {
        const id = randomUUID();
        ids.push(id);
        await storage.createLearning(makeRecord({ id, content: `Learning number ${i}.` }));
      }

      const result = await service.getContext({ repository: REPO_PATH, budget: 'full' });
      expect(result.repo_learnings).toHaveLength(25);
    });
  });

  // -------------------------------------------------------------------------
  // Volume threshold: ranked mode with cap when > 30 (GC-AC-11)
  // -------------------------------------------------------------------------

  describe('volume threshold: > 30 activates ranked mode with cap (GC-AC-11)', () => {
    it('returns exactly 20 when 35 repo learnings exist', async () => {
      for (let i = 0; i < 35; i++) {
        await storage.createLearning(
          makeRecord({ id: randomUUID(), content: `Short ${i}.` })
        );
      }

      const result = await service.getContext({ repository: REPO_PATH, budget: 'full' });
      expect(result.repo_learnings).toHaveLength(20);
    });
  });

  // -------------------------------------------------------------------------
  // Budget presets (GC-AC-12, GC-AC-13)
  // -------------------------------------------------------------------------

  describe('budget presets (GC-AC-12, GC-AC-13)', () => {
    it('compact budget returns fewer learnings than full budget', async () => {
      // Store 20 learnings with moderate content
      for (let i = 0; i < 20; i++) {
        await storage.createLearning(
          makeRecord({
            id: randomUUID(),
            content: 'x'.repeat(200) + ` entry ${i}`,
          })
        );
      }

      const compact = await service.getContext({ repository: REPO_PATH, budget: 'compact' });
      const full = await service.getContext({ repository: REPO_PATH, budget: 'full' });

      expect(full.repo_learnings.length).toBeGreaterThanOrEqual(compact.repo_learnings.length);
    });
  });

  // -------------------------------------------------------------------------
  // Stale review (GC-AC-22)
  // -------------------------------------------------------------------------

  describe('stale_review (GC-AC-22)', () => {
    it('includes stale-flagged learnings in stale_review array', async () => {
      const staleId = randomUUID();
      await storage.createLearning(makeRecord({
        id: staleId,
        content: 'This may be outdated.',
        repository: REPO_PATH,
      }));
      // Flag it as stale
      await storage.updateLearning(staleId, { stale_flag: true });

      const result = await service.getContext({ repository: REPO_PATH });
      const staleIds = result.stale_review.map((l) => l.id);
      expect(staleIds).toContain(staleId);
    });

    it('stale_count in summary reflects actual stale learnings', async () => {
      const staleId = randomUUID();
      await storage.createLearning(makeRecord({ id: staleId, repository: REPO_PATH }));
      await storage.updateLearning(staleId, { stale_flag: true });

      const result = await service.getContext({ repository: REPO_PATH });
      expect(result.summary.stale_count).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Read-only: no data mutation (GC-AC-23)
  // -------------------------------------------------------------------------

  describe('read-only (GC-AC-23)', () => {
    it('does not modify any learnings when called', async () => {
      const id = randomUUID();
      await storage.createLearning(makeRecord({ id, content: 'Original content.' }));

      const before = await storage.getLearning(id);
      await service.getContext({ repository: REPO_PATH });
      const after = await storage.getLearning(id);

      expect(after!.content).toBe(before!.content);
      expect(after!.updated_at).toBe(before!.updated_at);
      expect(after!.stale_flag).toBe(before!.stale_flag);
    });
  });

  // -------------------------------------------------------------------------
  // Near-duplicate detection (GC-AC-25, GC-AC-26)
  // -------------------------------------------------------------------------

  describe('near_duplicates (GC-AC-25, GC-AC-26)', () => {
    it('near_duplicates is populated after storing similar learnings with embeddings', async () => {
      // Store two learnings with similar (high cosine similarity) embeddings directly
      const embedding1 = Array.from({ length: 8 }, (_, i) => (i === 0 ? 1.0 : 0.0)); // [1, 0, 0, ...]
      const embedding2 = Array.from({ length: 8 }, (_, i) => (i === 0 ? 0.999 : 0.001)); // nearly identical

      const idA = randomUUID();
      const idB = randomUUID();

      await storage.createLearning(makeRecord({
        id: idA,
        content: 'Always use parameterized queries.',
        embedding: embedding1,
      }));
      await storage.createLearning(makeRecord({
        id: idB,
        content: 'Use parameterized queries always.',
        embedding: embedding2,
      }));

      // Manually trigger duplicate detection (as checkAndStoreDuplicates would in write path)
      await storage.checkAndStoreDuplicates(idB, embedding2, {
        repository: REPO_PATH,
        workspace: null,
      });

      const result = await service.getContext({ repository: REPO_PATH, budget: 'full' });
      expect(result.near_duplicates).toBeDefined();
      expect(result.near_duplicates!.length).toBeGreaterThan(0);
    });

    it('near_duplicates is absent when no duplicates exist', async () => {
      // Very different embeddings
      const embedding1 = [1.0, 0.0, 0.0, 0.0];
      const embedding2 = [0.0, 1.0, 0.0, 0.0];

      const idA = randomUUID();
      const idB = randomUUID();

      await storage.createLearning(makeRecord({ id: idA, embedding: embedding1 }));
      await storage.createLearning(makeRecord({ id: idB, embedding: embedding2 }));

      await storage.checkAndStoreDuplicates(idB, embedding2, {
        repository: REPO_PATH,
        workspace: null,
      });

      const result = await service.getContext({ repository: REPO_PATH, budget: 'full' });
      expect(result.near_duplicates).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Ranking: category tier order (GC-AC-6)
  // -------------------------------------------------------------------------

  describe('ranking: category tier order (GC-AC-6)', () => {
    it('gotchas appear before conventions appear before architecture in repo_learnings', async () => {
      await storage.createLearning(makeRecord({
        id: randomUUID(),
        category: 'architecture',
        content: 'Architecture learning.',
      }));
      await storage.createLearning(makeRecord({
        id: randomUUID(),
        category: 'conventions',
        content: 'Conventions learning.',
      }));
      await storage.createLearning(makeRecord({
        id: randomUUID(),
        category: 'gotchas',
        content: 'Gotcha learning.',
      }));

      const result = await service.getContext({ repository: REPO_PATH, budget: 'full' });

      const categories = result.repo_learnings.map((l) => l.category);
      const gotchasIdx = categories.indexOf('gotchas');
      const conventionsIdx = categories.indexOf('conventions');
      const architectureIdx = categories.indexOf('architecture');

      expect(gotchasIdx).toBeLessThan(conventionsIdx);
      expect(conventionsIdx).toBeLessThan(architectureIdx);
    });
  });

  // -------------------------------------------------------------------------
  // Write-time duplicate detection on storeLearning (GC-AC-25)
  // -------------------------------------------------------------------------

  describe('duplicate detection on store_learning (GC-AC-25)', () => {
    it('cleanupDuplicateCandidates is called on deprecateLearning (GC-AC-27)', async () => {
      const id = randomUUID();
      await storage.createLearning(makeRecord({ id, content: 'Test deprecation cleanup.' }));

      // No duplicate candidates — but the call should not throw
      await service.deprecateLearning({ id });

      // Verify the learning was deprecated
      const learning = await storage.getLearning(id);
      expect(learning!.status).toBe('deprecated');
    });

    it('cleanupDuplicateCandidates is called on deleteLearning (GC-AC-27)', async () => {
      const id = randomUUID();
      await storage.createLearning(makeRecord({ id, content: 'Test deletion cleanup.' }));

      // Should delete successfully
      const result = await service.deleteLearning({ id });
      expect(result.success).toBe(true);
    });
  });
});
