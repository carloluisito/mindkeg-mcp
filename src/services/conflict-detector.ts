/**
 * Conflict detector: keyword-heuristic based contradiction detection.
 * Detects when a new learning contradicts an existing one by checking for
 * cross-signal keyword patterns (negation vs assertion).
 *
 * This is a pure function module — no I/O, no storage interactions.
 * Traces to SKM-AC-22, SKM-AC-23, SKM-AC-24, SKM-AC-29.
 */

/**
 * Words that carry a negation/avoidance signal.
 * Traces to SKM-AC-23.
 */
export const NEGATION_MARKERS = [
  "don't",
  'dont',
  'avoid',
  'never',
  'stop',
  'remove',
  'disable',
  'not',
  "shouldn't",
  'shouldnt',
  "won't",
  'wont',
] as const;

/**
 * Words that carry an assertion/recommendation signal.
 * Traces to SKM-AC-23.
 */
export const ASSERTION_MARKERS = [
  'always',
  'must',
  'prefer',
  'use',
  'enable',
  'require',
  'ensure',
  'should',
  'recommend',
] as const;

/**
 * Cosine similarity threshold above which a neighbor is considered a conflict candidate.
 * Must be at or above this value AND pass the scope gate (same category) to be evaluated.
 * Traces to SKM-AC-22.
 */
export const CONFLICT_SIMILARITY_THRESHOLD = 0.85;

/**
 * A detected conflict between the new learning and an existing one.
 * Traces to SKM-AC-24, SKM-AC-26.
 */
export interface ConflictCandidate {
  /** ID of the existing learning that conflicts with the new one. */
  learning_id: string;
  /** Content of the existing conflicting learning. */
  content: string;
  /** Cosine similarity between the two learnings. */
  similarity: number;
  /** Detection method used. Always 'keyword_heuristic' in v1. */
  conflict_type: 'keyword_heuristic';
}

/**
 * Detect conflicts between new content and a set of candidate learnings.
 *
 * Pre-conditions:
 * - Candidates have already been filtered to similarity >= CONFLICT_SIMILARITY_THRESHOLD
 *   by the caller (from findScopedNeighbors results).
 *
 * Scope gate: a candidate must share the same category as the new learning.
 * (Tag-based gating is omitted in v1 because findScopedNeighbors does not return tags;
 * category-only gating is the safe, simple choice per the implementation note in the task.)
 *
 * Cross-signal detection: a conflict is detected when:
 * - New learning has negation markers AND candidate has assertion markers, OR
 * - New learning has assertion markers AND candidate has negation markers.
 *
 * Matching is case-insensitive and word-boundary aware (regex \b).
 *
 * Traces to SKM-AC-22, SKM-AC-23, SKM-AC-24, SKM-AC-29.
 *
 * @param newContent - Content of the learning being stored.
 * @param _newTags - Tags of the new learning (reserved for future tag-based gating).
 * @param newCategory - Category of the new learning (used for scope gate).
 * @param candidates - Pre-filtered neighbors (similarity >= threshold).
 * @returns Array of detected conflict candidates.
 */
export function detectConflicts(
  newContent: string,
  _newTags: string[],
  newCategory: string,
  candidates: Array<{ id: string; content: string; category: string; similarity: number }>
): ConflictCandidate[] {
  const newNegation = hasMarkers(newContent, NEGATION_MARKERS);
  const newAssertion = hasMarkers(newContent, ASSERTION_MARKERS);

  // If the new content has no signal at all, no conflict is possible.
  if (!newNegation && !newAssertion) return [];

  const conflicts: ConflictCandidate[] = [];

  for (const candidate of candidates) {
    // Scope gate: candidate must be in the same category (SKM-AC-29)
    if (candidate.category !== newCategory) continue;

    const candidateNegation = hasMarkers(candidate.content, NEGATION_MARKERS);
    const candidateAssertion = hasMarkers(candidate.content, ASSERTION_MARKERS);

    // Cross-signal check (SKM-AC-24):
    // new has negation + candidate has assertion, OR new has assertion + candidate has negation
    const crossSignal =
      (newNegation && candidateAssertion) || (newAssertion && candidateNegation);

    if (crossSignal) {
      conflicts.push({
        learning_id: candidate.id,
        content: candidate.content,
        similarity: candidate.similarity,
        conflict_type: 'keyword_heuristic',
      });
    }
  }

  return conflicts;
}

/**
 * Check whether a text contains any of the given markers using word-boundary matching.
 * Case-insensitive.
 *
 * @param text - The text to scan.
 * @param markers - The keyword list to check against.
 * @returns True if at least one marker is found as a whole word.
 */
function hasMarkers(text: string, markers: readonly string[]): boolean {
  const lower = text.toLowerCase();
  for (const marker of markers) {
    // Use word-boundary regex to avoid partial matches (e.g., "note" should not
    // match "not", "notch" should not match "not").
    const pattern = new RegExp(`\\b${escapeRegex(marker)}\\b`, 'i');
    if (pattern.test(lower)) return true;
  }
  return false;
}

/**
 * Escape special regex characters in a string so it can be used as a literal pattern.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
