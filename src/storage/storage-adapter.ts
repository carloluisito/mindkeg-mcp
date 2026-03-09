/**
 * StorageAdapter interface: the contract that all storage backends must implement.
 * This abstraction allows the business logic layer to remain backend-agnostic.
 * Traces to AC-24, AC-25, AC-26.
 */
import type { Learning, LearningWithScore } from '../models/learning.js';
import type { Repository } from '../models/repository.js';

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

  // --- Stats ---

  /** Get aggregate statistics about the learnings database. */
  getStats(): Promise<LearningStats>;
}

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
}
