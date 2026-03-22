/**
 * Pure ranking function for get_context.
 * Sorts learnings by a tiered heuristic: actionability first, then staleness, then embedding,
 * then access recency, then access frequency, then recency. No side effects, no I/O.
 * Traces to GC-AC-6, GC-AC-7, GC-AC-8, GC-AC-9, SKM-AC-12, SKM-AC-13, SKM-AC-37.
 */
import type { Learning } from '../models/learning.js';

/**
 * Category tier assignment: lower tier = surfaces first.
 * Tier 0: gotchas + debugging  (prevent mistakes)
 * Tier 1: conventions          (shape code style)
 * Tier 2: decisions + architecture (context, less immediately actionable)
 * Tier 3: dependencies         (situational)
 * Traces to GC-AC-6.
 */
const CATEGORY_TIER: Record<Learning['category'], number> = {
  gotchas: 0,
  debugging: 0,
  conventions: 1,
  decisions: 2,
  architecture: 2,
  dependencies: 3,
};

/**
 * Options for the ranking function.
 * All fields are optional; when omitted, no boost is applied.
 */
export interface RankingOptions {
  /**
   * When provided, learnings whose `repository` or `content` contains this string
   * (case-insensitive substring) are boosted within their tier. Traces to GC-AC-17.
   */
  path_hint?: string;

  /**
   * Map of learning ID -> cosine similarity score from a query embedding.
   * Used as an additional tiebreaker boost. Traces to GC-AC-20.
   */
  query_scores?: Map<string, number>;

  /**
   * Map of learning ID -> cosine similarity score from a path_hint embedding.
   * Applied to workspace/global learnings for semantic path matching. Traces to GC-AC-18.
   */
  path_hint_scores?: Map<string, number>;

  /**
   * When true, sort for stale_review (higher staleness first). Default false.
   * Traces to SKM-AC-37.
   */
  stale_review_mode?: boolean;
}

/**
 * Rank learnings using a multi-key tiered sort.
 *
 * Sort key (ascending = better):
 *   1. path_hint substring match bonus (0 = matched, 1 = no match) — only when path_hint provided
 *   2. Category tier (0 = gotchas/debugging … 3 = dependencies)
 *   3. Staleness score — normal mode: lower is better (0.0 = fresh); stale_review_mode: higher is better (1.0 = most stale)
 *   4. Has embedding (0 = has embedding, 1 = no embedding)
 *   5. Access recency: days since last_accessed_at (or created_at if null) — lower = more recent = better
 *   6. Access frequency: higher access_count = better (negated for ascending sort)
 *   7. Semantic boost score (inverted — higher similarity ranks first)
 *   8. updated_at (descending — more recent first)
 *
 * The sort is stable in JS (ES2019+), so learnings with the same key maintain
 * their original order as a final tiebreaker.
 *
 * @param learnings - Array of Learning objects to sort (not mutated).
 * @param options   - Optional boosting parameters.
 * @returns New sorted array (original array is not mutated).
 * Traces to GC-AC-6, GC-AC-7, GC-AC-8, GC-AC-9, SKM-AC-12, SKM-AC-13, SKM-AC-37.
 */
export function rankLearnings(learnings: Learning[], options: RankingOptions = {}): Learning[] {
  const { path_hint, query_scores, path_hint_scores, stale_review_mode = false } = options;

  // Reference epoch in milliseconds for computing recency
  const nowMs = Date.now();

  // Precompute sort key for each learning to avoid repeated lookups in comparator
  const keyed = learnings.map((learning) => {
    const tier = CATEGORY_TIER[learning.category];

    // Path hint bonus: 0 if repository contains path_hint substring (case-insensitive), else 1
    let pathBonus = 1;
    if (path_hint) {
      const hint = path_hint.toLowerCase();
      const repo = (learning.repository ?? '').toLowerCase();
      const content = learning.content.toLowerCase();
      if (repo.includes(hint) || content.includes(hint)) {
        pathBonus = 0;
      }
    }

    // Staleness score sort key (GC-AC-7, SKM-AC-37):
    // - Normal mode: lower staleness_score is better (0.0 = fresh sorts first; use raw value)
    // - stale_review_mode: higher staleness_score is better (1.0 = most stale sorts first; invert)
    const stalenessKey = stale_review_mode
      ? 1.0 - learning.staleness_score  // invert: 1.0 becomes 0.0, sorts first
      : learning.staleness_score;       // normal: 0.0 sorts first

    // Embedding presence: learnings with embeddings rank above those without (GC-AC-9)
    const hasEmbedding = learning.embedding !== null ? 0 : 1;

    // Access recency (SKM-AC-13): days since last_accessed_at (or created_at if null).
    // Lower = more recently accessed = better.
    const accessAnchorMs = learning.last_accessed_at !== null
      ? new Date(learning.last_accessed_at).getTime()
      : new Date(learning.created_at).getTime();
    const accessRecency = (nowMs - accessAnchorMs) / (1000 * 60 * 60 * 24); // days (fractional)

    // Access frequency (SKM-AC-12): higher access_count = better.
    // Negate for ascending sort so higher count sorts lower (= better).
    const accessFrequency = -learning.access_count;

    // Semantic boost: combine query_scores and path_hint_scores additively (GC-AC-18, GC-AC-20)
    // Invert for ascending sort (higher score = lower sort key = ranks first)
    const queryScore = query_scores?.get(learning.id) ?? 0;
    const pathScore = path_hint_scores?.get(learning.id) ?? 0;
    const semanticBoost = -(queryScore + pathScore); // negative so higher similarity sorts lower

    // Recency: negate updated_at string for descending sort (GC-AC-8)
    // ISO strings compare lexicographically, so negation via prefix inversion is done via comparison
    const updatedAt = learning.updated_at;

    return {
      learning,
      tier,
      pathBonus,
      stalenessKey,
      hasEmbedding,
      accessRecency,
      accessFrequency,
      semanticBoost,
      updatedAt,
    };
  });

  keyed.sort((a, b) => {
    // 1. path_hint bonus (only meaningful when path_hint provided)
    if (a.pathBonus !== b.pathBonus) return a.pathBonus - b.pathBonus;

    // 2. Category tier (ascending: 0 first)
    if (a.tier !== b.tier) return a.tier - b.tier;

    // 3. Staleness score (normal: lower = fresher = better; stale_review_mode: inverted)
    if (a.stalenessKey !== b.stalenessKey) return a.stalenessKey - b.stalenessKey;

    // 4. Has embedding (has embedding = 0 sorts first)
    if (a.hasEmbedding !== b.hasEmbedding) return a.hasEmbedding - b.hasEmbedding;

    // 5. Access recency (fewer days since last access = better; lower sorts first)
    if (a.accessRecency !== b.accessRecency) return a.accessRecency - b.accessRecency;

    // 6. Access frequency (higher count = better; already negated, so lower sorts first)
    if (a.accessFrequency !== b.accessFrequency) return a.accessFrequency - b.accessFrequency;

    // 7. Semantic boost (lower semanticBoost = higher similarity = better; already negated)
    if (a.semanticBoost !== b.semanticBoost) return a.semanticBoost - b.semanticBoost;

    // 8. Recency (descending: more recent first — reverse string comparison)
    if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? -1 : 1;

    return 0;
  });

  return keyed.map((k) => k.learning);
}
