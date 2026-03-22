/**
 * Unit tests for the staleness engine.
 * Tests the pure computeStalenessScore function and the recomputeAllStalenessScores orchestrator.
 * Traces to SKM-AC-31, SKM-AC-32, SKM-AC-34, SKM-AC-36.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  computeStalenessScore,
  recomputeAllStalenessScores,
  STALENESS_AUTO_FLAG_THRESHOLD,
} from '../../src/services/staleness-engine.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/** Build a learning-like object with the three fields computeStalenessScore needs. */
function makeLearning(opts: {
  updatedDaysAgo: number;
  createdDaysAgo?: number;
  lastAccessedDaysAgo?: number | null;
}, now = Date.now()) {
  const updatedAt = new Date(now - opts.updatedDaysAgo * MS_PER_DAY).toISOString();
  const createdAt = new Date(now - (opts.createdDaysAgo ?? opts.updatedDaysAgo) * MS_PER_DAY).toISOString();
  const lastAccessedAt =
    opts.lastAccessedDaysAgo != null
      ? new Date(now - opts.lastAccessedDaysAgo * MS_PER_DAY).toISOString()
      : null;
  return { updated_at: updatedAt, created_at: createdAt, last_accessed_at: lastAccessedAt };
}

// ---------------------------------------------------------------------------
// computeStalenessScore — pure function tests (SKM-AC-31, SKM-AC-32)
// ---------------------------------------------------------------------------

describe('computeStalenessScore', () => {
  const NOW = Date.now();

  it('returns ~0 for a brand-new learning that has never been accessed and has no conflicts', () => {
    const learning = makeLearning({ updatedDaysAgo: 0, lastAccessedDaysAgo: null }, NOW);
    const score = computeStalenessScore(learning, 0, NOW);
    // Age and access are both 0 days → factors are 0 → score = 0
    expect(score).toBe(0);
  });

  it('returns a higher score for an old learning that was never accessed', () => {
    // 365 days old, never accessed (falls back to created_at, also 365 days ago), no conflicts
    // ageFactor = min(1, 365/365) = 1.0
    // accessFactor = min(1, 365/180) = 1.0
    // conflictFactor = 0
    // score = min(1, 0.3*1 + 0.4*1 + 0.3*0) = 0.7
    const learning = makeLearning({ updatedDaysAgo: 365, lastAccessedDaysAgo: null }, NOW);
    const score = computeStalenessScore(learning, 0, NOW);
    expect(score).toBeCloseTo(0.7, 5);
  });

  it('returns a lower score for a recently-accessed learning even if it is old', () => {
    // 365 days old but accessed yesterday
    // ageFactor = 1.0, accessFactor = min(1, 1/180) ≈ 0.0056
    // score = 0.3*1 + 0.4*0.0056 + 0 ≈ 0.302
    const learning = makeLearning({ updatedDaysAgo: 365, lastAccessedDaysAgo: 1 }, NOW);
    const score = computeStalenessScore(learning, 0, NOW);
    expect(score).toBeGreaterThan(0.3);
    expect(score).toBeLessThan(0.35);
  });

  it('boosts score when there are unresolved conflicts', () => {
    // Brand new learning, 3 unresolved conflicts
    // ageFactor = 0, accessFactor = 0, conflictFactor = min(1, 3/3) = 1.0
    // score = 0.3*0 + 0.4*0 + 0.3*1 = 0.3
    const learning = makeLearning({ updatedDaysAgo: 0, lastAccessedDaysAgo: 0 }, NOW);
    const score = computeStalenessScore(learning, 3, NOW);
    expect(score).toBeCloseTo(0.3, 5);
  });

  it('caps conflict factor at 1.0 when there are more than 3 conflicts', () => {
    const learning = makeLearning({ updatedDaysAgo: 0, lastAccessedDaysAgo: 0 }, NOW);
    const score3 = computeStalenessScore(learning, 3, NOW);
    const score10 = computeStalenessScore(learning, 10, NOW);
    expect(score3).toBe(score10);
  });

  it('caps age factor at 1.0 at and beyond 365 days', () => {
    const at365 = makeLearning({ updatedDaysAgo: 365, lastAccessedDaysAgo: 365 }, NOW);
    const at500 = makeLearning({ updatedDaysAgo: 500, lastAccessedDaysAgo: 500 }, NOW);
    expect(computeStalenessScore(at365, 0, NOW)).toBe(computeStalenessScore(at500, 0, NOW));
  });

  it('caps access factor at 1.0 at and beyond 180 days without access', () => {
    // Use a fresh learning (0 days old) to isolate the access factor
    const at180 = makeLearning({ updatedDaysAgo: 0, lastAccessedDaysAgo: 180 }, NOW);
    const at300 = makeLearning({ updatedDaysAgo: 0, lastAccessedDaysAgo: 300 }, NOW);
    expect(computeStalenessScore(at180, 0, NOW)).toBe(computeStalenessScore(at300, 0, NOW));
  });

  it('uses created_at as fallback when last_accessed_at is null', () => {
    const withNull = makeLearning({ updatedDaysAgo: 0, createdDaysAgo: 90, lastAccessedDaysAgo: null }, NOW);
    const withExplicit = makeLearning({ updatedDaysAgo: 0, lastAccessedDaysAgo: 90 }, NOW);
    expect(computeStalenessScore(withNull, 0, NOW)).toBeCloseTo(
      computeStalenessScore(withExplicit, 0, NOW),
      5
    );
  });

  it('never returns a score above 1.0', () => {
    // Maximize all signals: 365 days old, never accessed, 3 conflicts
    const learning = makeLearning({ updatedDaysAgo: 365, lastAccessedDaysAgo: null }, NOW);
    const score = computeStalenessScore(learning, 100, NOW);
    expect(score).toBeLessThanOrEqual(1.0);
  });

  it('returns exactly the weighted sum for known values', () => {
    // 182.5 days old → ageFactor = 0.5
    // last accessed 90 days ago → accessFactor = 0.5
    // 1 unresolved conflict → conflictFactor = 1/3
    // score = 0.3*0.5 + 0.4*0.5 + 0.3*(1/3) = 0.15 + 0.20 + 0.10 = 0.45
    const learning = makeLearning({ updatedDaysAgo: 182.5, lastAccessedDaysAgo: 90 }, NOW);
    const score = computeStalenessScore(learning, 1, NOW);
    expect(score).toBeCloseTo(0.45, 4);
  });
});

// ---------------------------------------------------------------------------
// STALENESS_AUTO_FLAG_THRESHOLD (SKM-AC-34)
// ---------------------------------------------------------------------------

describe('STALENESS_AUTO_FLAG_THRESHOLD', () => {
  it('is 0.7', () => {
    expect(STALENESS_AUTO_FLAG_THRESHOLD).toBe(0.7);
  });

  it('the score from a 365-day-old never-accessed learning equals the threshold', () => {
    const NOW = Date.now();
    const learning = makeLearning({ updatedDaysAgo: 365, lastAccessedDaysAgo: null }, NOW);
    const score = computeStalenessScore(learning, 0, NOW);
    expect(score).toBeCloseTo(STALENESS_AUTO_FLAG_THRESHOLD, 5);
  });
});

// ---------------------------------------------------------------------------
// recomputeAllStalenessScores — orchestrator tests (SKM-AC-33, SKM-AC-34)
// ---------------------------------------------------------------------------

describe('recomputeAllStalenessScores', () => {
  const NOW = Date.now();

  /** Build a mock StorageAdapter with only the two methods the engine calls. */
  function makeStorage(learnings: Array<{
    id: string;
    updated_at: string;
    created_at: string;
    last_accessed_at: string | null;
    access_count: number;
    stale_flag: boolean;
    staleness_score: number;
    unresolved_conflict_count: number;
  }>) {
    const batchUpdateStaleness = vi.fn().mockResolvedValue(undefined);
    const getActiveLearningsWithConflictCounts = vi.fn().mockResolvedValue(learnings);
    return {
      batchUpdateStaleness,
      getActiveLearningsWithConflictCounts,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is a no-op when there are no active learnings', async () => {
    const storage = makeStorage([]);
    await recomputeAllStalenessScores(storage as never);
    expect(storage.batchUpdateStaleness).not.toHaveBeenCalled();
  });

  it('calls batchUpdateStaleness with computed scores', async () => {
    const learning = makeLearning({ updatedDaysAgo: 365, lastAccessedDaysAgo: null }, NOW);
    const storage = makeStorage([
      {
        id: 'abc',
        ...learning,
        access_count: 0,
        stale_flag: false,
        staleness_score: 0.0,
        unresolved_conflict_count: 0,
      },
    ]);

    await recomputeAllStalenessScores(storage as never);

    expect(storage.batchUpdateStaleness).toHaveBeenCalledOnce();
    const [updates] = storage.batchUpdateStaleness.mock.calls[0] as [
      Array<{ id: string; staleness_score: number; stale_flag: boolean }>
    ];
    expect(updates).toHaveLength(1);
    expect(updates[0]!.id).toBe('abc');
    // 365-day-old never-accessed learning should hit the threshold
    expect(updates[0]!.staleness_score).toBeCloseTo(0.7, 4);
    expect(updates[0]!.stale_flag).toBe(true);
  });

  it('auto-flags when score >= STALENESS_AUTO_FLAG_THRESHOLD (SKM-AC-34)', async () => {
    // Exactly at threshold
    const learning = makeLearning({ updatedDaysAgo: 365, lastAccessedDaysAgo: null }, NOW);
    const storage = makeStorage([
      {
        id: 'x',
        ...learning,
        access_count: 0,
        stale_flag: false,
        staleness_score: 0.0,
        unresolved_conflict_count: 0,
      },
    ]);
    await recomputeAllStalenessScores(storage as never);
    const [updates] = storage.batchUpdateStaleness.mock.calls[0] as [
      Array<{ id: string; staleness_score: number; stale_flag: boolean }>
    ];
    expect(updates[0]!.stale_flag).toBe(true);
  });

  it('does NOT auto-unflag a manually-flagged learning even if score drops below threshold', async () => {
    // Brand new learning (score ≈ 0) but already manually flagged
    const learning = makeLearning({ updatedDaysAgo: 0, lastAccessedDaysAgo: 0 }, NOW);
    const storage = makeStorage([
      {
        id: 'y',
        ...learning,
        access_count: 100,
        stale_flag: true, // manually flagged
        staleness_score: 1.0,
        unresolved_conflict_count: 0,
      },
    ]);
    await recomputeAllStalenessScores(storage as never);
    const [updates] = storage.batchUpdateStaleness.mock.calls[0] as [
      Array<{ id: string; staleness_score: number; stale_flag: boolean }>
    ];
    // Score should be near 0, but stale_flag must remain true (never auto-unflag)
    expect(updates[0]!.staleness_score).toBeLessThan(STALENESS_AUTO_FLAG_THRESHOLD);
    expect(updates[0]!.stale_flag).toBe(true);
  });

  it('processes multiple learnings and passes all updates in one call', async () => {
    const fresh = makeLearning({ updatedDaysAgo: 0, lastAccessedDaysAgo: 0 }, NOW);
    const old = makeLearning({ updatedDaysAgo: 365, lastAccessedDaysAgo: null }, NOW);
    const storage = makeStorage([
      { id: 'fresh', ...fresh, access_count: 5, stale_flag: false, staleness_score: 0, unresolved_conflict_count: 0 },
      { id: 'old', ...old, access_count: 0, stale_flag: false, staleness_score: 0, unresolved_conflict_count: 0 },
    ]);
    await recomputeAllStalenessScores(storage as never);
    const [updates] = storage.batchUpdateStaleness.mock.calls[0] as [
      Array<{ id: string; staleness_score: number; stale_flag: boolean }>
    ];
    expect(updates).toHaveLength(2);
    const freshUpdate = updates.find((u) => u.id === 'fresh')!;
    const oldUpdate = updates.find((u) => u.id === 'old')!;
    expect(freshUpdate.staleness_score).toBeLessThan(oldUpdate.staleness_score);
    expect(freshUpdate.stale_flag).toBe(false);
    expect(oldUpdate.stale_flag).toBe(true);
  });

  it('includes conflict factor in score computation', async () => {
    const learning = makeLearning({ updatedDaysAgo: 0, lastAccessedDaysAgo: 0 }, NOW);
    const noConflict = makeStorage([
      { id: 'nc', ...learning, access_count: 0, stale_flag: false, staleness_score: 0, unresolved_conflict_count: 0 },
    ]);
    const withConflict = makeStorage([
      { id: 'wc', ...learning, access_count: 0, stale_flag: false, staleness_score: 0, unresolved_conflict_count: 3 },
    ]);

    await recomputeAllStalenessScores(noConflict as never);
    await recomputeAllStalenessScores(withConflict as never);

    const [ncUpdates] = noConflict.batchUpdateStaleness.mock.calls[0] as [Array<{ staleness_score: number }>];
    const [wcUpdates] = withConflict.batchUpdateStaleness.mock.calls[0] as [Array<{ staleness_score: number }>];

    expect(wcUpdates[0]!.staleness_score).toBeGreaterThan(ncUpdates[0]!.staleness_score);
  });
});
