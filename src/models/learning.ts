/**
 * Learning model: type definitions and Zod validation schemas.
 * The Learning is the core entity of Mind Keg — an atomic, categorized piece of developer knowledge.
 */
import { z } from 'zod';
import { stripControlChars } from '../security/sanitize.js';

/** The six allowed learning categories (AC-13). */
export const LEARNING_CATEGORIES = [
  'architecture',
  'conventions',
  'debugging',
  'gotchas',
  'dependencies',
  'decisions',
] as const;

export type LearningCategory = (typeof LEARNING_CATEGORIES)[number];

/** The two allowed learning statuses. */
export const LEARNING_STATUSES = ['active', 'deprecated'] as const;
export type LearningStatus = (typeof LEARNING_STATUSES)[number];

/** Full Learning entity as stored in and returned from the database. */
export interface Learning {
  id: string;
  content: string;
  category: LearningCategory;
  tags: string[];
  repository: string | null;
  workspace: string | null;  // WS-AC-4: nullable workspace column
  group_id: string | null;
  source: string;
  status: LearningStatus;
  stale_flag: boolean;
  embedding: number[] | null;
  created_at: string;
  updated_at: string;
  /** Per-learning TTL in days. Null means no expiration (ESH-AC-15). Anchors on updated_at. */
  ttl_days: number | null;
  /** Free-form provenance string — who created or last modified this learning (ESH-AC-25). */
  source_agent: string | null;
  /** SHA-256 integrity hash of canonical learning fields (ESH-AC-26). Null for legacy learnings. */
  integrity_hash: string | null;
  /** Number of times this learning has been returned in search or get_context results (SKM-AC-8). */
  access_count: number;
  /** ISO 8601 timestamp of last access via search or get_context. Null if never accessed (SKM-AC-8). */
  last_accessed_at: string | null;
  /** Continuous staleness score in [0.0, 1.0]. Higher = more stale (SKM-AC-30). */
  staleness_score: number;
}

/** A Learning augmented with a relevance score, returned from search results (AC-12). */
export interface LearningWithScore extends Learning {
  score: number;
  scope: 'repo' | 'workspace' | 'global';  // WS-AC-14: scope annotation
  /**
   * Present only when verify_integrity=true was passed to search_learnings or get_context.
   * True if the stored integrity_hash matches the computed hash; false if tampered or mismatched.
   * Null when no integrity_hash is stored (legacy learning). (ESH-AC-27)
   */
  integrity_valid?: boolean | null;
}

/** Zod schema for creating a new learning (AC-1, AC-6, AC-13, AC-14, AC-15). */
export const CreateLearningInputSchema = z
  .object({
    /**
     * The atomic learning text. Max 500 characters (AC-6).
     * Control characters are stripped and all-whitespace content is rejected (ESH-AC-24).
     */
    content: z
      .string()
      .min(1, 'Content must not be empty')
      .max(500, 'Content must not exceed 500 characters')
      .transform((val) => stripControlChars(val))
      .superRefine((val, ctx) => {
        if (val.trim().length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Content must not be entirely whitespace (ESH-AC-24)',
          });
        }
      }),

    /** Exactly one of the six allowed categories (AC-13). */
    category: z.enum(LEARNING_CATEGORIES),

    /** Free-form labels. Defaults to empty array (AC-14). */
    tags: z.array(z.string()).default([]),

    /** Repository path for scoping. Null means global (AC-7). */
    repository: z.string().nullable().default(null),

    /**
     * Workspace path for workspace-wide scoping (WS-AC-9).
     * Mutually exclusive with `repository` (WS-AC-8, WS-AC-10).
     */
    workspace: z.string().nullable().default(null),

    /** Optional UUID linking related learnings (AC-15). */
    group_id: z.string().uuid().nullable().default(null),

    /** Who or what created this learning (AC-28). Defaults to "agent". */
    source: z.string().default('agent'),

    /**
     * Per-learning TTL in days. Null means no expiration (ESH-AC-15).
     * TTL anchors on updated_at — refreshing a learning resets its retention clock.
     */
    ttl_days: z.number().int().positive().nullable().default(null),

    /**
     * Free-form provenance string identifying who created this learning (ESH-AC-25).
     * Not validated against a registry — free-form for v1.
     */
    source_agent: z.string().nullable().default(null),
  })
  .refine(
    (data) => !(data.repository && data.workspace),
    {
      message:
        'Cannot set both repository and workspace. Use repository for repo-specific, workspace for workspace-wide, or neither for global.',
    }
  );

export type CreateLearningInput = z.infer<typeof CreateLearningInputSchema>;

/** Zod schema for updating an existing learning (AC-3). All fields optional. */
export const UpdateLearningInputSchema = z
  .object({
    /** UUID of the learning to update. Required. */
    id: z.string().uuid(),

    /**
     * New content. If changed, embedding is regenerated.
     * Control characters are stripped and all-whitespace content is rejected (ESH-AC-24).
     */
    content: z
      .string()
      .min(1, 'Content must not be empty')
      .max(500, 'Content must not exceed 500 characters')
      .transform((val) => stripControlChars(val))
      .superRefine((val, ctx) => {
        if (val.trim().length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Content must not be entirely whitespace (ESH-AC-24)',
          });
        }
      })
      .optional(),

    /** New category. */
    category: z.enum(LEARNING_CATEGORIES).optional(),

    /** New tags. Replaces existing tags entirely. */
    tags: z.array(z.string()).optional(),

    /** New group_id. */
    group_id: z.string().uuid().nullable().optional(),

    /**
     * New workspace scope. Set to change scope to workspace-wide; null to clear (WS-AC-8).
     * Mutually exclusive with `repository` on the final state.
     */
    workspace: z.string().nullable().optional(),

    /**
     * New repository scope. Set to change scope to repo-specific; null to clear (WS-AC-8).
     * Mutually exclusive with `workspace` on the final state.
     */
    repository: z.string().nullable().optional(),

    /** Update per-learning TTL in days. Null clears the TTL (ESH-AC-15). */
    ttl_days: z.number().int().positive().nullable().optional(),

    /**
     * Update provenance string for who last modified this learning (ESH-AC-25).
     * Null clears the source_agent field.
     */
    source_agent: z.string().nullable().optional(),
  })
  .refine(
    (data) => !(data.repository && data.workspace),
    {
      message:
        'Cannot set both repository and workspace. Use repository for repo-specific, workspace for workspace-wide, or neither for global.',
    }
  );

export type UpdateLearningInput = z.infer<typeof UpdateLearningInputSchema>;

/** Zod schema for deprecating a learning (AC-4). */
export const DeprecateLearningInputSchema = z.object({
  /** UUID of the learning to deprecate. */
  id: z.string().uuid(),

  /** Optional human-readable reason for deprecation. */
  reason: z.string().optional(),
});

export type DeprecateLearningInput = z.infer<typeof DeprecateLearningInputSchema>;

/** Zod schema for deleting a learning (AC-5). */
export const DeleteLearningInputSchema = z.object({
  /** UUID of the learning to permanently delete. */
  id: z.string().uuid(),
});

export type DeleteLearningInput = z.infer<typeof DeleteLearningInputSchema>;

/** Zod schema for merging duplicate learnings into a canonical one (SKM-AC-1, SKM-AC-7). */
export const MergeLearningsInputSchema = z
  .object({
    /** UUID of the learning to keep as the canonical entry. */
    canonical_id: z.string().uuid(),

    /** UUIDs of the duplicate learnings to deprecate. Min 1, max 20. */
    duplicate_ids: z.array(z.string().uuid()).min(1).max(20),

    /**
     * Optional merged content. When provided, the canonical learning's content is
     * updated to this value and its embedding is regenerated (SKM-AC-2).
     * When omitted, the canonical learning is unchanged (SKM-AC-3).
     */
    merged_content: z.string().min(1).max(500).optional(),
  })
  .refine(
    (data) => !data.duplicate_ids.includes(data.canonical_id),
    { message: 'canonical_id must not appear in duplicate_ids' }
  );

export type MergeLearningsInput = z.infer<typeof MergeLearningsInputSchema>;

/** Zod schema for search parameters (AC-9, AC-10, AC-11). */
export const SearchLearningsInputSchema = z.object({
  /** Natural-language query for semantic/keyword search. */
  query: z.string().min(1, 'Query must not be empty'),

  /** Filter to this repository (also includes global learnings — AC-8). */
  repository: z.string().nullable().optional(),

  /**
   * Filter to this workspace (also includes global learnings — WS-AC-12).
   * When provided without a repository, returns workspace-scoped + global learnings.
   */
  workspace: z.string().nullable().optional(),

  /** Filter by category (AC-10). */
  category: z.enum(LEARNING_CATEGORIES).optional(),

  /** Filter by any matching tag (AC-10). */
  tags: z.array(z.string()).optional(),

  /** Max results returned. Default 10, max 50 (AC-11). */
  limit: z.number().int().min(1).max(50).default(10),

  /** Include deprecated learnings in results. Default false (AC-29). */
  include_deprecated: z.boolean().default(false),

  /**
   * When true, each result includes integrity_valid: boolean|null indicating
   * whether the stored integrity_hash matches the computed hash (ESH-AC-27).
   * Default false — opt-in to avoid overhead on every search.
   */
  verify_integrity: z.boolean().default(false),
});

export type SearchLearningsInput = z.infer<typeof SearchLearningsInputSchema>;

/** Zod schema for flagging a learning as stale (AC-30). */
export const FlagStaleLearningInputSchema = z.object({
  /** UUID of the learning to flag as stale. */
  id: z.string().uuid(),
});

export type FlagStaleLearningInput = z.infer<typeof FlagStaleLearningInputSchema>;

/**
 * Zod schema for get_context tool input.
 * Traces to GC-AC-2, GC-AC-3, GC-AC-12, GC-AC-16, GC-AC-19, GC-AC-21.
 */
export const GetContextInputSchema = z.object({
  /**
   * The current repository path. Required. Used for repo-scope lookup and
   * workspace auto-derivation (GC-AC-2, GC-AC-3).
   */
  repository: z.string().min(1, 'repository must not be empty'),

  /**
   * Workspace path override. When omitted, derived from repository's parent
   * directory via deriveWorkspace(). (GC-AC-3)
   */
  workspace: z.string().optional(),

  /**
   * Optional subdirectory hint for path-match boosting. (GC-AC-16)
   */
  path_hint: z.string().optional(),

  /**
   * Optional topic focus. When provided, its embedding is used as an additional
   * ranking signal (cosine similarity boost). (GC-AC-19)
   */
  query: z.string().optional(),

  /**
   * Budget preset controlling approximate character limits.
   * compact ~2000, standard ~5000, full ~12000. Default: 'standard'. (GC-AC-12)
   */
  budget: z.enum(['compact', 'standard', 'full']).default('standard'),

  /**
   * When true (default), stale-flagged learnings appear in both the main scope arrays
   * (repo/workspace/global) AND in the stale_review section.
   * When false, stale learnings are excluded from the main scope arrays but still
   * appear in the stale_review section. (GC-AC-21)
   */
  include_stale: z.boolean().default(true),

  /**
   * When true, each returned learning includes integrity_valid: boolean|null
   * indicating whether the stored hash matches the computed hash (ESH-AC-27).
   * Default false — opt-in to avoid overhead on every get_context call.
   */
  verify_integrity: z.boolean().default(false),
});

export type GetContextInput = z.infer<typeof GetContextInputSchema>;

/**
 * A learning as returned by get_context — identical to Learning but without
 * the embedding vector (not returned to clients). Traces to architecture spec.
 */
export interface RankedLearning {
  id: string;
  content: string;
  category: LearningCategory;
  tags: string[];
  repository: string | null;
  workspace: string | null;
  group_id: string | null;
  source: string;
  status: LearningStatus;
  stale_flag: boolean;
  created_at: string;
  updated_at: string;
  /** Per-learning TTL in days (ESH-AC-15). */
  ttl_days: number | null;
  /** Provenance tracking field (ESH-AC-25). */
  source_agent: string | null;
  /** SHA-256 integrity hash (ESH-AC-26). */
  integrity_hash: string | null;
  /**
   * Present only when verify_integrity=true was requested.
   * True = hash matches; false = tampered/mismatch; null = legacy learning (no stored hash).
   * (ESH-AC-27)
   */
  integrity_valid?: boolean | null;
  /** Number of times this learning has been returned in search or get_context results (SKM-AC-8). */
  access_count: number;
  /** ISO 8601 timestamp of last access via search or get_context. Null if never accessed (SKM-AC-8). */
  last_accessed_at: string | null;
  /** Continuous staleness score in [0.0, 1.0]. Higher = more stale (SKM-AC-30). */
  staleness_score: number;
}

/**
 * A group of near-duplicate learnings surfaced by get_context.
 * Traces to GC-AC-26.
 */
export interface DuplicateGroup {
  /** The older learning in the pair (by created_at). */
  canonical_id: string;
  /** Newer learnings that are near-duplicates of the canonical. */
  duplicate_ids: string[];
  /** Highest similarity score in the group. */
  similarity: number;
}

/**
 * The full response structure returned by the get_context tool.
 * Traces to GC-AC-4, GC-AC-5, GC-AC-22, GC-AC-26.
 */
export interface GetContextResult {
  summary: {
    total_repo: number;
    total_workspace: number;
    total_global: number;
    stale_count: number;
    /** Most recent updated_at across all matched learnings. Empty string if no learnings. */
    last_updated: string;
  };
  /** Repo-scoped learnings, ranked by actionability. */
  repo_learnings: RankedLearning[];
  /** Workspace-scoped learnings, ranked by actionability. */
  workspace_learnings: RankedLearning[];
  /** Global learnings, ranked by actionability. */
  global_learnings: RankedLearning[];
  /** Stale-flagged learnings for agent review (GC-AC-22). */
  stale_review: RankedLearning[];
  /** Near-duplicate groups, if any (GC-AC-26). */
  near_duplicates?: DuplicateGroup[];
}
