/**
 * Pure ranking function for get_context.
 * Sorts learnings by a tiered heuristic: actionability first, then stale, then embedding,
 * then recency. No side effects, no I/O.
 * Traces to GC-AC-6, GC-AC-7, GC-AC-8, GC-AC-9.
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
}

/**
 * Rank learnings using a multi-key tiered sort.
 *
 * Sort key (ascending = better):
 *   1. path_hint substring match bonus (0 = matched, 1 = no match) — only when path_hint provided
 *   2. Category tier (0 = gotchas/debugging … 3 = dependencies)
 *   3. Stale flag (0 = stale first, 1 = not stale)
 *   4. Has embedding (0 = has embedding, 1 = no embedding)
 *   5. Semantic boost score (inverted — higher similarity ranks first)
 *   6. updated_at (descending — more recent first)
 *
 * The sort is stable in JS (ES2019+), so learnings with the same key maintain
 * their original order as a final tiebreaker.
 *
 * @param learnings - Array of Learning objects to sort (not mutated).
 * @param options   - Optional boosting parameters.
 * @returns New sorted array (original array is not mutated).
 * Traces to GC-AC-6, GC-AC-7, GC-AC-8, GC-AC-9.
 */
export function rankLearnings(learnings: Learning[], options: RankingOptions = {}): Learning[] {
  const { path_hint, query_scores, path_hint_scores } = options;

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

    // Stale flag: stale learnings bubble to top within their tier (GC-AC-7)
    const staleKey = learning.stale_flag ? 0 : 1;

    // Embedding presence: learnings with embeddings rank above those without (GC-AC-9)
    const hasEmbedding = learning.embedding !== null ? 0 : 1;

    // Semantic boost: combine query_scores and path_hint_scores additively (GC-AC-18, GC-AC-20)
    // Invert for ascending sort (higher score = lower sort key = ranks first)
    const queryScore = query_scores?.get(learning.id) ?? 0;
    const pathScore = path_hint_scores?.get(learning.id) ?? 0;
    const semanticBoost = -(queryScore + pathScore); // negative so higher similarity sorts lower

    // Recency: negate updated_at string for descending sort (GC-AC-8)
    // ISO strings compare lexicographically, so negation via prefix inversion is done via comparison
    const updatedAt = learning.updated_at;

    return { learning, tier, pathBonus, staleKey, hasEmbedding, semanticBoost, updatedAt };
  });

  keyed.sort((a, b) => {
    // 1. path_hint bonus (only meaningful when path_hint provided)
    if (a.pathBonus !== b.pathBonus) return a.pathBonus - b.pathBonus;

    // 2. Category tier (ascending: 0 first)
    if (a.tier !== b.tier) return a.tier - b.tier;

    // 3. Stale flag (stale = 0 sorts first)
    if (a.staleKey !== b.staleKey) return a.staleKey - b.staleKey;

    // 4. Has embedding (has embedding = 0 sorts first)
    if (a.hasEmbedding !== b.hasEmbedding) return a.hasEmbedding - b.hasEmbedding;

    // 5. Semantic boost (lower semanticBoost = higher similarity = better; already negated)
    if (a.semanticBoost !== b.semanticBoost) return a.semanticBoost - b.semanticBoost;

    // 6. Recency (descending: more recent first — reverse string comparison)
    if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? -1 : 1;

    return 0;
  });

  return keyed.map((k) => k.learning);
}
