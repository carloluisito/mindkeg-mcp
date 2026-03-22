/**
 * StorageAdapter interface: the contract that all storage backends must implement.
 * This abstraction allows the business logic layer to remain backend-agnostic.
 * Traces to AC-24, AC-25, AC-26.
 */
import type { Learning, LearningWithScore, RelationshipRecord, CreateRelationshipRecord, ConflictRecord, CreateConflictRecord } from '../models/learning.js';
import type { Repository } from '../models/repository.js';

/**
 * Filters for get_context queries. Traces to GC-AC-4.
 */
export interface GetContextFilters {
  /** The current repository path (normalized). */
  repository: string;
  /** Workspace path (derived or provided). Null means no workspace scoping. */
  workspace: string | null;
  /** When false, stale learnings are excluded from main scope arrays. */
  include_stale: boolean;
}

/**
 * Data returned by getContextLearnings — learnings pre-partitioned by scope.
 * Traces to GC-AC-4, GC-AC-5.
 */
export interface GetContextData {
  /** Learnings where repository matches filter. */
  repo: Learning[];
  /** Learnings where workspace matches filter and repository is null. */
  workspace: Learning[];
  /** Learnings where both repository and workspace are null. */
  global: Learning[];
  /** Stale-flagged learnings across all matched scopes. */
  stale: Learning[];
  summary: {
    total_repo: number;
    total_workspace: number;
    total_global: number;
    stale_count: number;
    /** Most recent updated_at across all matched learnings. Empty string if no learnings. */
    last_updated: string;
  };
}

/**
 * A pre-computed near-duplicate pair in the duplicate_candidates table.
 * Traces to GC-AC-24, GC-AC-26.
 */
export interface DuplicateCandidate {
  id: string;
  learning_id_a: string;
  learning_id_b: string;
  similarity: number;
  scope: 'repo' | 'workspace' | 'global';
  scope_value: string | null;
  created_at: string;
}

/** Input for creating a new learning in storage (already validated by LearningService). */
export interface CreateLearningRecord {
  id: string;
  content: string;
  category: string;
  tags: string[];
  repository: string | null;
  workspace: string | null;   // WS-AC-4
  group_id: string | null;
  source: string;
  embedding: number[] | null;
  /** Per-learning TTL in days. Null means no expiration (ESH-AC-15). */
  ttl_days?: number | null;
  /** Free-form provenance string (ESH-AC-25). */
  source_agent?: string | null;
  /** SHA-256 integrity hash (ESH-AC-26). */
  integrity_hash?: string | null;
  /** Access count override (SKM-AC-8). Defaults to 0 on insert. */
  access_count?: number;
  /** Last accessed timestamp override (SKM-AC-8). Defaults to NULL on insert. */
  last_accessed_at?: string | null;
  /** Staleness score override (SKM-AC-30). Defaults to 0.0 on insert. */
  staleness_score?: number;
}

/** Input for updating a learning in storage. */
export interface UpdateLearningRecord {
  content?: string;
  category?: string;
  tags?: string[];
  group_id?: string | null;
  status?: string;
  stale_flag?: boolean;
  embedding?: number[] | null;
  workspace?: string | null;    // WS-AC-8
  repository?: string | null;   // WS-AC-8
  /** Per-learning TTL in days. Null clears the TTL (ESH-AC-15). */
  ttl_days?: number | null;
  /** Free-form provenance string (ESH-AC-25). */
  source_agent?: string | null;
  /** SHA-256 integrity hash (ESH-AC-26). */
  integrity_hash?: string | null;
  /** Access count to set (SKM-AC-8). */
  access_count?: number;
  /** Last accessed timestamp to set (SKM-AC-8). */
  last_accessed_at?: string | null;
  /** Staleness score to set (SKM-AC-30). */
  staleness_score?: number;
}

/** Filters for searching learnings. */
export interface SearchFilters {
  repository?: string | null;
  workspace?: string | null;    // WS-AC-12
  category?: string;
  tags?: string[];
  limit: number;
  include_deprecated: boolean;
}

/**
 * Filters for listing all learnings (no text search).
 * Used by the export command and similar bulk-read operations.
 */
export interface ListAllFilters {
  repository?: string;
  category?: string;
  tags?: string[];
  include_deprecated?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Filters for bulk-purge operations (ESH-AC-18).
 * All fields are optional; at least one must be set (enforced by purge-service).
 */
export interface PurgeByFilterOptions {
  /** Purge learnings older than this many days (anchored on updated_at). */
  olderThanDays?: number;
  /** Purge all learnings for this repository path. */
  repository?: string;
  /** Purge all learnings for this workspace path. */
  workspace?: string;
  /** Purge ALL learnings (requires explicit confirmation by caller). */
  all?: boolean;
}

/** Input for creating an API key record in storage. */
export interface CreateApiKeyRecord {
  id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  repositories: string[];
}

/** An API key record as stored in the database. */
export interface ApiKeyRecord {
  id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  repositories: string[];
  created_at: string;
  last_used_at: string | null;
  revoked: boolean;
}

/**
 * The storage adapter interface.
 * All methods are async for interface consistency.
 * SQLite implementations wrap synchronous calls in resolved promises.
 */
export interface StorageAdapter {
  // --- Lifecycle ---

  /** Initialize the adapter (run migrations, create tables). Call once at startup. */
  initialize(): Promise<void>;

  /** Close the database connection. */
  close(): Promise<void>;

  // --- Learning CRUD ---

  /** Create a new learning. Returns the created learning. (AC-1) */
  createLearning(record: CreateLearningRecord): Promise<Learning>;

  /** Get a learning by ID. Returns null if not found. (AC-2) */
  getLearning(id: string): Promise<Learning | null>;

  /** Update an existing learning. Returns the updated learning or null if not found. (AC-3) */
  updateLearning(id: string, updates: UpdateLearningRecord): Promise<Learning | null>;

  /** Permanently delete a learning. Returns true if deleted, false if not found. (AC-5) */
  deleteLearning(id: string): Promise<boolean>;

  // --- Search ---

  /**
   * List all learnings without text search, optionally filtered.
   * Used by the export command to retrieve all learnings reliably.
   * Unlike searchByText, this method issues a plain SELECT and is not
   * subject to FTS5 query-parse restrictions.
   */
  listAll(filters?: ListAllFilters): Promise<Learning[]>;

  /**
   * Search learnings by keyword using FTS5.
   * Used as the fallback when no embedding provider is configured.
   * Traces to AC-9 (FTS fallback), AC-8, AC-10, AC-11.
   */
  searchByText(query: string, filters: SearchFilters): Promise<LearningWithScore[]>;

  /**
   * Search learnings by vector similarity (cosine distance).
   * Traces to AC-9 (semantic search), AC-8, AC-10, AC-11, AC-12.
   *
   * NOTE — embedding field on returned Learning objects: implementations MAY
   * return embedding: null even when a vector is stored (v1 implementation
   * detail). Callers must not assume the embedding vector is populated in
   * search results. Use getLearning() if the raw vector is needed.
   */
  searchByVector(queryEmbedding: number[], filters: SearchFilters): Promise<LearningWithScore[]>;

  // --- Repositories ---

  /** List all distinct repositories with their learning counts. (AC-16 / list_repositories tool) */
  listRepositories(): Promise<Repository[]>;

  /** List all distinct workspaces with their learning counts. (WS-AC-16 / list_workspaces tool) */
  listWorkspaces(): Promise<Array<{ workspace: string; learning_count: number }>>;

  // --- API Keys ---

  /** Create a new API key record. (AC-20) */
  createApiKey(record: CreateApiKeyRecord): Promise<ApiKeyRecord>;

  /** Look up an API key by its SHA-256 hash. Returns null if not found. (AC-21) */
  getApiKeyByHash(keyHash: string): Promise<ApiKeyRecord | null>;

  /** List all API keys (not the keys themselves — only metadata). (AC-20) */
  listApiKeys(): Promise<ApiKeyRecord[]>;

  /** Revoke an API key by its prefix. Returns true if found and revoked. (AC-20) */
  revokeApiKey(keyPrefix: string): Promise<boolean>;

  /** Update last_used_at timestamp on an API key. */
  touchApiKey(id: string): Promise<void>;

  // --- Purge (ESH-AC-17, ESH-AC-18) ---

  /**
   * Purge learnings that have exceeded their TTL.
   * A learning is expired when: ttl_days IS NOT NULL AND
   *   (julianday('now') - julianday(updated_at)) > ttl_days
   *
   * When defaultTtlDays is provided, learnings with ttl_days = NULL are also
   * evaluated against the global default TTL.
   *
   * IMPORTANT: This method is synchronous (returns number, not Promise<number>)
   * to match the node:sqlite DatabaseSync pattern.
   *
   * @param defaultTtlDays - Global default TTL in days. Null means only per-learning TTLs are evaluated.
   * @returns Number of learnings purged.
   */
  purgeExpired(defaultTtlDays: number | null): number;

  /**
   * Purge learnings matching the given filter criteria.
   * Used by the `mindkeg purge` CLI command and by purge-service (ESH-AC-18).
   *
   * IMPORTANT: This method is synchronous (returns number, not Promise<number>)
   * to match the node:sqlite DatabaseSync pattern.
   *
   * @param options - At least one filter field must be set.
   * @returns Number of learnings purged.
   */
  purgeByFilter(options: PurgeByFilterOptions): number;

  // --- Stats ---

  /** Get aggregate statistics about the learnings database. */
  getStats(): Promise<LearningStats>;

  // --- Context (get_context tool) ---

  /**
   * Fetch all active learnings partitioned by scope (repo, workspace, global) with summary counts.
   * Used exclusively by the get_context tool. Traces to GC-AC-4, GC-AC-5.
   */
  getContextLearnings(filters: GetContextFilters): Promise<GetContextData>;

  /**
   * Fetch duplicate candidate rows involving any of the given learning IDs.
   * Used by get_context to populate the near_duplicates section. Traces to GC-AC-26.
   */
  getDuplicateCandidates(learningIds: string[]): Promise<DuplicateCandidate[]>;

  /**
   * Compare a learning against others in the same scope and store pairs above the
   * DUPLICATE_SIMILARITY_THRESHOLD. Called after store/update when content changes.
   * Traces to GC-AC-25.
   */
  checkAndStoreDuplicates(
    learningId: string,
    embedding: number[],
    scope: { repository: string | null; workspace: string | null }
  ): Promise<void>;

  /**
   * Remove all duplicate_candidates rows that reference the given learning ID.
   * Called on deprecate and delete. Traces to GC-AC-27.
   */
  cleanupDuplicateCandidates(learningId: string): Promise<void>;

  /**
   * Find all same-scope active learnings with embeddings, compute cosine similarity
   * against the given embedding, and return those above the minimum threshold.
   * Returns lightweight records sorted by similarity descending.
   * Used by: duplicate detection, conflict detection, auto-categorization (SKM).
   *
   * Unlike checkAndStoreDuplicates, this method does NOT exclude any particular
   * learning ID — it scans the full same-scope active set.
   *
   * Traces to SKM-AC-18, SKM-AC-22.
   */
  findScopedNeighbors(
    embedding: number[],
    scope: { repository: string | null; workspace: string | null },
    minSimilarity: number
  ): Promise<Array<{ id: string; content: string; category: string; embedding: number[]; similarity: number }>>;

  /**
   * Batch-increment access_count and set last_accessed_at for the given learning IDs.
   * Implementation is synchronous (node:sqlite DatabaseSync) but interface uses Promise
   * for consistency with all other StorageAdapter methods.
   * No-op when learningIds is empty.
   * SKM-AC-9, SKM-AC-10.
   */
  recordAccess(learningIds: string[]): Promise<void>;

  // --- Learning Relationships (SKM-AC-38, SKM-AC-39) ---

  /**
   * Create a typed relationship between two learnings.
   * Returns the created relationship record (SKM-AC-46).
   * Throws StorageError if a duplicate relationship exists (SKM-AC-40).
   */
  createRelationship(record: CreateRelationshipRecord): Promise<RelationshipRecord>;

  /**
   * Get all relationships for the given learning IDs (both as source and target).
   * Returns an empty array if learningIds is empty.
   * Used to attach relationship data to search results (SKM-AC-41) and get_context (SKM-AC-42).
   */
  getRelationships(learningIds: string[]): Promise<RelationshipRecord[]>;

  // --- Conflict detection (SKM-AC-25, SKM-AC-27, SKM-AC-28) ---

  /**
   * Store a conflict pair. Enforces pair ordering (learning_id_a < learning_id_b).
   * Uses INSERT OR IGNORE to handle the unique pair constraint gracefully.
   * Traces to SKM-AC-25.
   */
  storeConflict(record: CreateConflictRecord): Promise<void>;

  /**
   * Get all unresolved conflicts involving any of the given learning IDs.
   * Returns empty array if learningIds is empty. Traces to SKM-AC-27.
   */
  getUnresolvedConflicts(learningIds: string[]): Promise<ConflictRecord[]>;

  /**
   * Mark all unresolved conflicts involving the given learning ID as resolved.
   * Sets resolved=true and resolved_by to the provided value.
   * Returns the number of conflicts resolved. Traces to SKM-AC-28.
   */
  resolveConflicts(learningId: string, resolvedBy: string): Promise<number>;
}

// Re-export relationship types for consumers that import from storage-adapter
export type { RelationshipRecord, CreateRelationshipRecord };
// Re-export conflict types for consumers that import from storage-adapter
export type { ConflictRecord, CreateConflictRecord };

/** Aggregate statistics about the learnings database. */
export interface LearningStats {
  total: number;
  active: number;
  deprecated: number;
  stale: number;
  withEmbeddings: number;
  byCategory: Array<{ category: string; count: number }>;
  byRepository: Array<{ repository: string | null; count: number }>;
  byWorkspace: Array<{ workspace: string | null; count: number }>;
  oldestAt: string | null;
  newestAt: string | null;
  /** Sum of access_count across all learnings (SKM-AC-16). */
  totalAccesses: number;
  /** Average access_count per learning, rounded to two decimal places (SKM-AC-16). */
  avgAccessCount: number;
  /** Count of learnings with access_count = 0 (never accessed) (SKM-AC-16). */
  neverAccessedCount: number;
}
