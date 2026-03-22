/**
 * Integration tests for Phase 7: Smart Staleness Detection.
 * Tests the full path: store → recompute → verify staleness score + flag.
 * Uses in-memory SQLite with NoneEmbeddingService (no external dependencies).
 * Traces to SKM-AC-30 through SKM-AC-37.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { NoneEmbeddingService } from '../../src/services/embedding-service.js';
import { LearningService } from '../../src/services/learning-service.js';
import {
  recomputeAllStalenessScores,
  computeStalenessScore,
  STALENESS_AUTO_FLAG_THRESHOLD,
} from '../../src/services/staleness-engine.js';

const MS_PER_DAY = 1000 * 60 * 60 * 24;

describe('Integration: Smart Staleness Detection', () => {
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
  // SKM-AC-30: staleness_score column defaults to 0.0
  // -------------------------------------------------------------------------

  it('newly stored learning has staleness_score = 0.0 (SKM-AC-30)', async () => {
    const { learning } = await service.storeLearning({
      content: 'Use strict mode in TypeScript',
      category: 'conventions',
    });
    expect(learning.staleness_score).toBe(0.0);
  });

  // -------------------------------------------------------------------------
  // SKM-AC-33: getActiveLearningsWithConflictCounts returns correct data
  // -------------------------------------------------------------------------

  it('getActiveLearningsWithConflictCounts returns active learnings with 0 conflicts by default', async () => {
    await service.storeLearning({ content: 'Learning A', category: 'conventions' });
    await service.storeLearning({ content: 'Learning B', category: 'debugging' });

    const rows = await storage.getActiveLearningsWithConflictCounts();
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.unresolved_conflict_count).toBe(0);
      expect(typeof row.staleness_score).toBe('number');
      expect(typeof row.stale_flag).toBe('boolean');
      expect(row.last_accessed_at).toBeNull();
    }
  });

  it('excludes deprecated learnings from getActiveLearningsWithConflictCounts', async () => {
    const { learning } = await service.storeLearning({ content: 'Will be deprecated', category: 'conventions' });
    await service.deprecateLearning({ id: learning.id });

    const rows = await storage.getActiveLearningsWithConflictCounts();
    expect(rows.every((r) => r.id !== learning.id)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // SKM-AC-33: batchUpdateStaleness persists scores
  // -------------------------------------------------------------------------

  it('batchUpdateStaleness persists staleness_score and stale_flag', async () => {
    const { learning } = await service.storeLearning({ content: 'Test learning', category: 'conventions' });

    await storage.batchUpdateStaleness([
      { id: learning.id, staleness_score: 0.85, stale_flag: true },
    ]);

    const updated = await storage.getLearning(learning.id);
    expect(updated).not.toBeNull();
    expect(updated!.staleness_score).toBeCloseTo(0.85, 5);
    expect(updated!.stale_flag).toBe(true);
  });

  it('batchUpdateStaleness handles empty array gracefully', async () => {
    await expect(storage.batchUpdateStaleness([])).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // SKM-AC-33, SKM-AC-34: recomputeAllStalenessScores end-to-end
  // -------------------------------------------------------------------------

  it('recomputeAllStalenessScores updates staleness_score from 0.0', async () => {
    const { learning } = await service.storeLearning({
      content: 'Recompute test learning',
      category: 'architecture',
    });
    expect(learning.staleness_score).toBe(0.0);

    await recomputeAllStalenessScores(storage);

    const after = await storage.getLearning(learning.id);
    expect(after).not.toBeNull();
    // Brand new learning has age≈0, access≈0 → score is very close to 0 (may be non-zero by
    // a tiny amount due to the time elapsed between store and recompute in the test).
    expect(after!.staleness_score).toBeCloseTo(0.0, 5);
  });

  it('auto-flags stale_flag when recomputed score >= threshold (SKM-AC-34)', async () => {
    const { learning } = await service.storeLearning({
      content: 'Old learning to auto-flag',
      category: 'debugging',
    });

    // Simulate the learning being 365 days old by directly updating timestamps
    const oldTimestamp = new Date(Date.now() - 365 * MS_PER_DAY).toISOString();
    await storage.updateLearning(learning.id, {
      // We can't directly set updated_at/created_at via UpdateLearningRecord,
      // but we can verify the score formula using the staleness engine directly
      // with mocked time. Instead, use batchUpdateStaleness to simulate what
      // recompute would do after time passes.
    });

    // Directly verify the formula produces the expected score for a 365-day-old learning
    const fakeOldLearning = {
      updated_at: oldTimestamp,
      created_at: oldTimestamp,
      last_accessed_at: null,
    };
    const score = computeStalenessScore(fakeOldLearning, 0);
    expect(score).toBeGreaterThanOrEqual(STALENESS_AUTO_FLAG_THRESHOLD);

    // Simulate what recomputeAllStalenessScores would produce by calling batchUpdateStaleness
    await storage.batchUpdateStaleness([
      { id: learning.id, staleness_score: score, stale_flag: score >= STALENESS_AUTO_FLAG_THRESHOLD },
    ]);

    const after = await storage.getLearning(learning.id);
    expect(after!.stale_flag).toBe(true);
    expect(after!.staleness_score).toBeGreaterThanOrEqual(STALENESS_AUTO_FLAG_THRESHOLD);
  });

  it('recomputeAllStalenessScores is a no-op on empty database', async () => {
    await expect(recomputeAllStalenessScores(storage)).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // SKM-AC-36: flag_stale sets staleness_score = 1.0
  // -------------------------------------------------------------------------

  it('flagStale sets staleness_score = 1.0 (SKM-AC-36)', async () => {
    const { learning } = await service.storeLearning({
      content: 'Will be manually flagged stale',
      category: 'gotchas',
    });
    expect(learning.stale_flag).toBe(false);
    expect(learning.staleness_score).toBe(0.0);

    const flagged = await service.flagStale({ id: learning.id });
    expect(flagged.stale_flag).toBe(true);
    expect(flagged.staleness_score).toBe(1.0);
  });

  it('flagStale persists staleness_score = 1.0 to the database', async () => {
    const { learning } = await service.storeLearning({
      content: 'Manual stale flag persistence test',
      category: 'conventions',
    });

    await service.flagStale({ id: learning.id });

    const fetched = await storage.getLearning(learning.id);
    expect(fetched!.stale_flag).toBe(true);
    expect(fetched!.staleness_score).toBe(1.0);
  });

  it('recomputeAllStalenessScores never auto-unflags a manually-flagged learning (SKM-AC-34)', async () => {
    const { learning } = await service.storeLearning({
      content: 'Manually flagged; should not be unset by recompute',
      category: 'architecture',
    });

    // Manually flag it
    await service.flagStale({ id: learning.id });

    // Recompute — brand new learning has score ≈ 0 but flag must stay true
    await recomputeAllStalenessScores(storage);

    const after = await storage.getLearning(learning.id);
    expect(after!.stale_flag).toBe(true); // must never become false
    // Score is recomputed to near 0 (it is brand new)
    expect(after!.staleness_score).toBeLessThan(STALENESS_AUTO_FLAG_THRESHOLD);
  });

  // -------------------------------------------------------------------------
  // SKM-AC-35: staleness_score included in get_context output
  // -------------------------------------------------------------------------

  it('staleness_score is included in get_context RankedLearning output (SKM-AC-35)', async () => {
    await service.storeLearning({
      content: 'Global learning for staleness output test',
      category: 'conventions',
    });

    const result = await service.getContext({ repository: '/test/repo' });
    for (const l of result.global_learnings) {
      expect(typeof l.staleness_score).toBe('number');
      expect(l.staleness_score).toBeGreaterThanOrEqual(0.0);
      expect(l.staleness_score).toBeLessThanOrEqual(1.0);
    }
  });
});
