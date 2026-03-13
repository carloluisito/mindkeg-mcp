/**
 * Learning model: type definitions and Zod validation schemas.
 * The Learning is the core entity of Mind Keg — an atomic, categorized piece of developer knowledge.
 */
import { z } from 'zod';

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
}

/** A Learning augmented with a relevance score, returned from search results (AC-12). */
export interface LearningWithScore extends Learning {
  score: number;
  scope: 'repo' | 'workspace' | 'global';  // WS-AC-14: scope annotation
}

/** Zod schema for creating a new learning (AC-1, AC-6, AC-13, AC-14, AC-15). */
export const CreateLearningInputSchema = z
  .object({
    /** The atomic learning text. Max 500 characters (AC-6). */
    content: z
      .string()
      .min(1, 'Content must not be empty')
      .max(500, 'Content must not exceed 500 characters'),

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

    /** New content. If changed, embedding is regenerated. */
    content: z
      .string()
      .min(1, 'Content must not be empty')
      .max(500, 'Content must not exceed 500 characters')
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
