/**
 * Staleness Engine: computes continuous staleness scores for learnings.
 *
 * The score is a weighted sum of three signals:
 *   - Age factor: days since last update, normalized to [0,1] with a 365-day ceiling
 *   - Access factor: days since last access, normalized to [0,1] with a 180-day ceiling
 *   - Conflict factor: unresolved conflict count, normalized to [0,1] with a 3-conflict ceiling
 *
 * When the score reaches STALENESS_AUTO_FLAG_THRESHOLD (0.7), the boolean stale_flag
 * is automatically set to true for backward compatibility. The flag is never auto-cleared.
 *
 * Traces to SKM-AC-31, SKM-AC-32, SKM-AC-33, SKM-AC-34.
 */
import type { StorageAdapter } from '../storage/storage-adapter.js';
import { getLogger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Constants (SKM-AC-32)
// ---------------------------------------------------------------------------

/** Staleness score at or above which stale_flag is automatically set to true (SKM-AC-34). */
export const STALENESS_AUTO_FLAG_THRESHOLD = 0.7;

const AGE_WEIGHT = 0.3;
const ACCESS_WEIGHT = 0.4;
const CONFLICT_WEIGHT = 0.3;

/** Age ceiling in days: a learning not updated for 365+ days contributes maximum age factor. */
const AGE_CEILING_DAYS = 365;

/** Access ceiling in days: a learning not accessed for 180+ days contributes maximum access factor. */
const ACCESS_CEILING_DAYS = 180;

/** Conflict ceiling: 3+ unresolved conflicts contribute maximum conflict factor. */
const CONFLICT_CEILING = 3;

// ---------------------------------------------------------------------------
// Pure computation (SKM-AC-31, SKM-AC-32)
// ---------------------------------------------------------------------------

/**
 * Compute a staleness score in the range [0.0, 1.0] for a single learning.
 *
 * Pure function — no I/O. The optional `now` parameter is injectable for
 * deterministic testing; callers should omit it in production.
 *
 * @param learning - Learning fields required for the computation.
 * @param unresolvedConflictCount - Number of unresolved conflicts involving this learning.
 * @param now - Current time in milliseconds (defaults to Date.now()). Injectable for tests.
 * @returns A score in [0.0, 1.0] where higher means more stale.
 */
export function computeStalenessScore(
  learning: {
    updated_at: string;
    created_at: string;
    last_accessed_at: string | null;
  },
  unresolvedConflictCount: number,
  now?: number
): number {
  const nowMs = now ?? Date.now();
  const updatedAt = new Date(learning.updated_at).getTime();
  const lastAccessed = learning.last_accessed_at
    ? new Date(learning.last_accessed_at).getTime()
    : new Date(learning.created_at).getTime();

  // Age factor: days since last update, normalized [0,1] with AGE_CEILING_DAYS ceiling
  const ageDays = (nowMs - updatedAt) / (1000 * 60 * 60 * 24);
  const ageFactor = Math.min(1.0, ageDays / AGE_CEILING_DAYS);

  // Access factor: days since last access, normalized [0,1] with ACCESS_CEILING_DAYS ceiling
  const accessDays = (nowMs - lastAccessed) / (1000 * 60 * 60 * 24);
  const accessFactor = Math.min(1.0, accessDays / ACCESS_CEILING_DAYS);

  // Conflict factor: unresolved conflicts, normalized [0,1] with CONFLICT_CEILING ceiling
  const conflictFactor = Math.min(1.0, unresolvedConflictCount / CONFLICT_CEILING);

  return Math.min(
    1.0,
    AGE_WEIGHT * ageFactor + ACCESS_WEIGHT * accessFactor + CONFLICT_WEIGHT * conflictFactor
  );
}

// ---------------------------------------------------------------------------
// Batch recomputation (SKM-AC-33, SKM-AC-34)
// ---------------------------------------------------------------------------

/**
 * Recompute staleness scores for all active learnings and persist them.
 *
 * Runs on the same periodic interval as the TTL purge (SKM-AC-33). Also called
 * once at server startup. Non-fatal: errors are logged and swallowed so the
 * server continues running.
 *
 * Rules:
 * - stale_flag is set to true when score >= STALENESS_AUTO_FLAG_THRESHOLD (SKM-AC-34)
 * - stale_flag is NEVER cleared by this function — once set (manually or automatically),
 *   it remains true regardless of score changes (backward compatibility + manual flag preservation)
 *
 * @param storage - The StorageAdapter to use for reading and writing.
 */
export async function recomputeAllStalenessScores(storage: StorageAdapter): Promise<void> {
  const log = getLogger();

  const learnings = await storage.getActiveLearningsWithConflictCounts();
  if (learnings.length === 0) return;

  const updates = learnings.map((l) => {
    const score = computeStalenessScore(l, l.unresolved_conflict_count);
    return {
      id: l.id,
      staleness_score: score,
      // Never auto-unflag: preserve manual flags and only set when threshold reached
      stale_flag: l.stale_flag || score >= STALENESS_AUTO_FLAG_THRESHOLD,
    };
  });

  await storage.batchUpdateStaleness(updates);

  const autoFlagged = updates.filter((u) => u.stale_flag).length;
  log.debug(
    { total: learnings.length, auto_flagged: autoFlagged },
    'Staleness scores recomputed'
  );
}
