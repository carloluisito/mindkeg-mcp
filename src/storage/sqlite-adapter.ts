/**
 * SQLite storage adapter using Node.js 22+ built-in `node:sqlite` (DatabaseSync).
 * This adapter is the default backend for solo/local usage — zero external dependencies.
 * Traces to AC-24.
 *
 * node:sqlite is available in Node.js 22+ (experimental, enabled via --experimental-sqlite).
 * The API is synchronous — do NOT use await on database calls.
 *
 * We use a dynamic import via createRequire to load `node:sqlite` lazily so that build tools
 * (Vite/tsup) that scan imports at bundle time do not fail trying to resolve the built-in module.
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  StorageAdapter,
  CreateLearningRecord,
  UpdateLearningRecord,
  SearchFilters,
  ListAllFilters,
  CreateApiKeyRecord,
  ApiKeyRecord,
  LearningStats,
} from './storage-adapter.js';
import type { Learning, LearningWithScore } from '../models/learning.js';
import type { Repository } from '../models/repository.js';
import { StorageError } from '../utils/errors.js';
import { getLogger } from '../utils/logger.js';
import {
  upStatements as migration001Statements,
  version as migration001Version,
} from './migrations/001-initial.js';

// ---------------------------------------------------------------------------
// node:sqlite loader — lazy to avoid Vite/tsup resolution issues
// ---------------------------------------------------------------------------
interface NodeSqliteModule {
  DatabaseSync: new (path: string) => DatabaseSyncInstance;
}

interface DatabaseSyncInstance {
  exec(sql: string): void;
  prepare(sql: string): StatementInstance;
  close(): void;
}

interface StatementInstance {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

function loadSqlite(): NodeSqliteModule {
  // Use createRequire to load built-in modules without tripping Vite's resolver
  const require = createRequire(import.meta.url);
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('node:sqlite') as NodeSqliteModule;
  } catch (err) {
    // node:sqlite throws ERR_EXPERIMENTAL_FEATURE_NOT_ENABLED when the process
    // was started without --experimental-sqlite. Surface a clear, actionable
    // message instead of letting Node emit an opaque ERR_UNKNOWN_BUILTIN_MODULE.
    const msg = err instanceof Error ? err.message : String(err);
    const missingFlag =
      msg.includes('--experimental-sqlite') ||
      msg.includes('ERR_EXPERIMENTAL_FEATURE_NOT_ENABLED') ||
      msg.includes('ERR_UNKNOWN_BUILTIN_MODULE');
    if (missingFlag) {
      throw new StorageError(
        'node:sqlite requires the --experimental-sqlite Node.js flag. ' +
          'Start the server with: node --experimental-sqlite dist/cli/index.js serve, ' +
          'or use the npm scripts "serve:stdio" / "serve:http" which include the flag automatically.',
        err
      );
    }
    throw new StorageError(
      'Failed to load node:sqlite. Ensure you are running Node.js 22+ with --experimental-sqlite.',
      err
    );
  }
}

export class SqliteAdapter implements StorageAdapter {
  private db!: DatabaseSyncInstance;
  private readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  async initialize(): Promise<void> {
    const log = getLogger();
    try {
      if (this.dbPath !== ':memory:') {
        mkdirSync(dirname(this.dbPath), { recursive: true });
      }
      const { DatabaseSync } = loadSqlite();
      this.db = new DatabaseSync(this.dbPath);
      // Enable WAL mode for better concurrent read performance and reduced locking
      this.db.exec('PRAGMA journal_mode=WAL;');
      this.db.exec('PRAGMA foreign_keys=ON;');
      this.runMigrations();
      log.info({ dbPath: this.dbPath }, 'SQLite adapter initialized');
    } catch (err) {
      if (err instanceof StorageError) throw err;
      throw new StorageError(`Failed to initialize SQLite database: ${String(err)}`, err);
    }
  }

  async close(): Promise<void> {
    try {
      this.db.close();
    } catch (_err) {
      // Ignore close errors
    }
  }

  private runMigrations(): void {
    const log = getLogger();

    // Create schema_version table if it doesn't exist yet
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    const versionRow = this.db
      .prepare('SELECT MAX(version) as v FROM schema_version')
      .get() as { v: number | null } | undefined;
    const currentVersion = versionRow?.v ?? 0;

    if (currentVersion < migration001Version) {
      log.info({ migration: migration001Version }, 'Applying migration 001-initial');
      // Execute each SQL statement individually — DatabaseSync handles one statement at a time.
      // Using an array of statements avoids ambiguity when splitting by ';' (triggers have ; inside BEGIN...END).
      for (const stmt of migration001Statements) {
        try {
          this.db.exec(stmt + ';');
        } catch (err) {
          // Skip "already exists" errors (safe re-runs with IF NOT EXISTS)
          const msg = String(err);
          if (!msg.includes('already exists') && !msg.includes('duplicate')) {
            throw new StorageError(`Migration failed on statement: ${stmt}\n${msg}`, err);
          }
        }
      }
      this.db
        .prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)')
        .run(migration001Version);
      log.info({ migration: migration001Version }, 'Migration 001-initial applied');
    }
  }

  // ---------------------------------------------------------------------------
  // Learning CRUD (AC-1 through AC-5)
  // ---------------------------------------------------------------------------

  async createLearning(record: CreateLearningRecord): Promise<Learning> {
    const now = new Date().toISOString();
    const tagsJson = JSON.stringify(record.tags);
    const embeddingJson = record.embedding ? JSON.stringify(record.embedding) : null;

    try {
      this.db
        .prepare(
          `INSERT INTO learnings
           (id, content, category, tags, repository, workspace, group_id, source, status, stale_flag, embedding, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?)`
        )
        .run(
          record.id,
          record.content,
          record.category,
          tagsJson,
          record.repository ?? null,
          record.workspace ?? null,
          record.group_id ?? null,
          record.source,
          embeddingJson,
          now,
          now
        );

      const learning = this.getLearningSync(record.id);
      if (!learning) {
        throw new StorageError('Learning was not found immediately after insert');
      }
      return learning;
    } catch (err) {
      if (err instanceof StorageError) throw err;
      throw new StorageError(`Failed to create learning: ${String(err)}`, err);
    }
  }

  async getLearning(id: string): Promise<Learning | null> {
    try {
      return this.getLearningSync(id);
    } catch (err) {
      throw new StorageError(`Failed to get learning: ${String(err)}`, err);
    }
  }

  private getLearningSync(id: string): Learning | null {
    const row = this.db
      .prepare('SELECT * FROM learnings WHERE id = ?')
      .get(id) as RawLearningRow | undefined;
    return row ? rowToLearning(row) : null;
  }

  async updateLearning(id: string, updates: UpdateLearningRecord): Promise<Learning | null> {
    const existing = this.getLearningSync(id);
    if (!existing) return null;

    const setClauses: string[] = ['updated_at = ?'];
    const params: unknown[] = [new Date().toISOString()];

    if (updates.content !== undefined) {
      setClauses.push('content = ?');
      params.push(updates.content);
    }
    if (updates.category !== undefined) {
      setClauses.push('category = ?');
      params.push(updates.category);
    }
    if (updates.tags !== undefined) {
      setClauses.push('tags = ?');
      params.push(JSON.stringify(updates.tags));
    }
    if (updates.group_id !== undefined) {
      setClauses.push('group_id = ?');
      params.push(updates.group_id ?? null);
    }
    if (updates.status !== undefined) {
      setClauses.push('status = ?');
      params.push(updates.status);
    }
    if (updates.stale_flag !== undefined) {
      setClauses.push('stale_flag = ?');
      params.push(updates.stale_flag ? 1 : 0);
    }
    if (updates.embedding !== undefined) {
      setClauses.push('embedding = ?');
      params.push(updates.embedding !== null ? JSON.stringify(updates.embedding) : null);
    }
    if (updates.workspace !== undefined) {
      setClauses.push('workspace = ?');
      params.push(updates.workspace ?? null);
    }
    if (updates.repository !== undefined) {
      setClauses.push('repository = ?');
      params.push(updates.repository ?? null);
    }

    params.push(id);

    try {
      this.db
        .prepare(`UPDATE learnings SET ${setClauses.join(', ')} WHERE id = ?`)
        .run(...params);
      return this.getLearningSync(id);
    } catch (err) {
      throw new StorageError(`Failed to update learning: ${String(err)}`, err);
    }
  }

  async deleteLearning(id: string): Promise<boolean> {
    try {
      const result = this.db
        .prepare('DELETE FROM learnings WHERE id = ?')
        .run(id);
      return result.changes > 0;
    } catch (err) {
      throw new StorageError(`Failed to delete learning: ${String(err)}`, err);
    }
  }

  // ---------------------------------------------------------------------------
  // List all (export / bulk read)
  // ---------------------------------------------------------------------------

  async listAll(filters: ListAllFilters = {}): Promise<Learning[]> {
    try {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (!filters.include_deprecated) {
        conditions.push("status = 'active'");
      }
      if (filters.repository !== undefined) {
        conditions.push('(repository = ? OR repository IS NULL)');
        params.push(filters.repository);
      }
      if (filters.category) {
        conditions.push('category = ?');
        params.push(filters.category);
      }
      if (filters.tags && filters.tags.length > 0) {
        const tagConds = filters.tags
          .map(() => `EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)`)
          .join(' OR ');
        conditions.push(`(${tagConds})`);
        params.push(...filters.tags);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const limitClause = filters.limit !== undefined ? `LIMIT ?` : '';
      const offsetClause = filters.offset !== undefined ? `OFFSET ?` : '';
      if (filters.limit !== undefined) params.push(filters.limit);
      if (filters.offset !== undefined) params.push(filters.offset);

      const sql = `SELECT * FROM learnings ${whereClause} ORDER BY created_at ASC ${limitClause} ${offsetClause}`;
      const rows = this.db.prepare(sql).all(...params) as RawLearningRow[];
      return rows.map(rowToLearning);
    } catch (err) {
      throw new StorageError(`Failed to list all learnings: ${String(err)}`, err);
    }
  }

  // ---------------------------------------------------------------------------
  // Search (AC-9, AC-10, AC-11)
  // ---------------------------------------------------------------------------

  async searchByText(query: string, filters: SearchFilters): Promise<LearningWithScore[]> {
    try {
      const { whereClause, whereParams } = buildJoinWhereClause(filters);

      // FTS5 MATCH with BM25 ranking — smaller (more negative) score = more relevant
      const sql = `
        SELECT l.*, bm25(learnings_fts) AS fts_score
        FROM learnings_fts
        JOIN learnings l ON learnings_fts.rowid = l.rowid
        WHERE learnings_fts MATCH ?
        ${whereClause ? `AND ${whereClause}` : ''}
        ORDER BY fts_score ASC
        LIMIT ?
      `;
      const rows = this.db
        .prepare(sql)
        .all(ftsEscape(query), ...whereParams, filters.limit) as Array<
        RawLearningRow & { fts_score: number }
      >;

      return rows.map((row) => {
        const learning = rowToLearning(row);
        return {
          ...learning,
          score: normalizeBm25Score(row.fts_score),
          scope: annotateScope(learning),
        };
      });
    } catch (err) {
      // Return empty on FTS5 query parse errors rather than crashing
      const msg = String(err);
      if (msg.includes('fts5') || msg.includes('syntax error') || msg.includes('MATCH')) {
        return [];
      }
      throw new StorageError(`Text search failed: ${msg}`, err);
    }
  }

  async searchByVector(
    queryEmbedding: number[],
    filters: SearchFilters
  ): Promise<LearningWithScore[]> {
    try {
      const { whereClause, whereParams } = buildDirectWhereClause(filters);

      // Retrieve all candidates with embeddings, compute cosine similarity in JS.
      // Brute-force cosine similarity — acceptable for local SQLite usage.
      const sql = `
        SELECT * FROM learnings
        WHERE embedding IS NOT NULL
        ${whereClause ? `AND ${whereClause}` : ''}
      `;
      const rows = this.db.prepare(sql).all(...whereParams) as RawLearningRow[];

      const scored = rows
        .map((row) => {
          const embedding = row.embedding
            ? (JSON.parse(row.embedding) as number[])
            : null;
          if (!embedding) return null;
          const score = cosineSimilarity(queryEmbedding, embedding);
          const learning = rowToLearning(row);
          return { ...learning, score, scope: annotateScope(learning) };
        })
        .filter((r): r is LearningWithScore => r !== null)
        .sort((a, b) => b.score - a.score)
        .slice(0, filters.limit);

      return scored;
    } catch (err) {
      throw new StorageError(`Vector search failed: ${String(err)}`, err);
    }
  }

  // ---------------------------------------------------------------------------
  // Repositories
  // ---------------------------------------------------------------------------

  async listRepositories(): Promise<Repository[]> {
    try {
      const rows = this.db
        .prepare(
          `SELECT repository AS path, COUNT(*) AS learning_count
           FROM learnings
           GROUP BY repository
           ORDER BY learning_count DESC`
        )
        .all() as Array<{ path: string | null; learning_count: number }>;
      return rows;
    } catch (err) {
      throw new StorageError(`Failed to list repositories: ${String(err)}`, err);
    }
  }

  async listWorkspaces(): Promise<Array<{ workspace: string; learning_count: number }>> {
    try {
      const rows = this.db
        .prepare(
          `SELECT workspace, COUNT(*) AS learning_count
           FROM learnings
           WHERE workspace IS NOT NULL
           GROUP BY workspace
           ORDER BY learning_count DESC`
        )
        .all() as Array<{ workspace: string; learning_count: number }>;
      return rows;
    } catch (err) {
      throw new StorageError(`Failed to list workspaces: ${String(err)}`, err);
    }
  }

  // ---------------------------------------------------------------------------
  // API Keys (AC-20, AC-21, AC-22)
  // ---------------------------------------------------------------------------

  async createApiKey(record: CreateApiKeyRecord): Promise<ApiKeyRecord> {
    const now = new Date().toISOString();
    const reposJson = JSON.stringify(record.repositories);
    try {
      this.db
        .prepare(
          `INSERT INTO api_keys (id, name, key_hash, key_prefix, repositories, created_at, last_used_at, revoked)
           VALUES (?, ?, ?, ?, ?, ?, NULL, 0)`
        )
        .run(
          record.id,
          record.name,
          record.key_hash,
          record.key_prefix,
          reposJson,
          now
        );

      return {
        id: record.id,
        name: record.name,
        key_hash: record.key_hash,
        key_prefix: record.key_prefix,
        repositories: record.repositories,
        created_at: now,
        last_used_at: null,
        revoked: false,
      };
    } catch (err) {
      throw new StorageError(`Failed to create API key: ${String(err)}`, err);
    }
  }

  async getApiKeyByHash(keyHash: string): Promise<ApiKeyRecord | null> {
    try {
      const row = this.db
        .prepare('SELECT * FROM api_keys WHERE key_hash = ?')
        .get(keyHash) as RawApiKeyRow | undefined;
      return row ? rowToApiKey(row) : null;
    } catch (err) {
      throw new StorageError(`Failed to get API key: ${String(err)}`, err);
    }
  }

  async listApiKeys(): Promise<ApiKeyRecord[]> {
    try {
      const rows = this.db
        .prepare('SELECT * FROM api_keys ORDER BY created_at DESC')
        .all() as RawApiKeyRow[];
      return rows.map(rowToApiKey);
    } catch (err) {
      throw new StorageError(`Failed to list API keys: ${String(err)}`, err);
    }
  }

  async revokeApiKey(keyPrefix: string): Promise<boolean> {
    try {
      const result = this.db
        .prepare(
          "UPDATE api_keys SET revoked = 1 WHERE key_prefix = ? AND revoked = 0"
        )
        .run(keyPrefix);
      return result.changes > 0;
    } catch (err) {
      throw new StorageError(`Failed to revoke API key: ${String(err)}`, err);
    }
  }

  async touchApiKey(id: string): Promise<void> {
    try {
      this.db
        .prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?")
        .run(new Date().toISOString(), id);
    } catch (_err) {
      // Non-fatal — don't throw
    }
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  async getStats(): Promise<LearningStats> {
    try {
      const rawTotals = this.db.prepare(`
        SELECT
          COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS active,
          COALESCE(SUM(CASE WHEN status = 'deprecated' THEN 1 ELSE 0 END), 0) AS deprecated,
          COALESCE(SUM(CASE WHEN stale_flag = 1 THEN 1 ELSE 0 END), 0) AS stale,
          COALESCE(SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END), 0) AS with_embeddings,
          MIN(created_at) AS oldest_at,
          MAX(created_at) AS newest_at
        FROM learnings
      `).get() as {
        total: number;
        active: number;
        deprecated: number;
        stale: number;
        with_embeddings: number;
        oldest_at: string | null;
        newest_at: string | null;
      };
      const totals = rawTotals;

      const byCategory = this.db.prepare(`
        SELECT category, COUNT(*) AS count
        FROM learnings
        GROUP BY category
        ORDER BY count DESC
      `).all() as Array<{ category: string; count: number }>;

      const byRepository = this.db.prepare(`
        SELECT repository, COUNT(*) AS count
        FROM learnings
        GROUP BY repository
        ORDER BY count DESC
      `).all() as Array<{ repository: string | null; count: number }>;

      const byWorkspace = this.db.prepare(`
        SELECT workspace, COUNT(*) AS count
        FROM learnings
        GROUP BY workspace
        ORDER BY count DESC
      `).all() as Array<{ workspace: string | null; count: number }>;

      return {
        total: totals.total,
        active: totals.active,
        deprecated: totals.deprecated,
        stale: totals.stale,
        withEmbeddings: totals.with_embeddings,
        byCategory,
        byRepository,
        byWorkspace,
        oldestAt: totals.oldest_at,
        newestAt: totals.newest_at,
      };
    } catch (err) {
      throw new StorageError(`Failed to get stats: ${String(err)}`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Row type definitions (internal — not exported)
// ---------------------------------------------------------------------------

interface RawLearningRow {
  id: string;
  content: string;
  category: string;
  tags: string;
  repository: string | null;
  workspace: string | null;
  group_id: string | null;
  source: string;
  status: string;
  stale_flag: number;
  embedding: string | null;
  created_at: string;
  updated_at: string;
}

interface RawApiKeyRow {
  id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  repositories: string;
  created_at: string;
  last_used_at: string | null;
  revoked: number;
}

// ---------------------------------------------------------------------------
// Row mapping helpers
// ---------------------------------------------------------------------------

function rowToLearning(row: RawLearningRow): Learning {
  return {
    id: row.id,
    content: row.content,
    category: row.category as Learning['category'],
    tags: JSON.parse(row.tags) as string[],
    repository: row.repository,
    workspace: row.workspace ?? null,
    group_id: row.group_id,
    source: row.source,
    status: row.status as Learning['status'],
    stale_flag: row.stale_flag === 1,
    embedding: row.embedding ? (JSON.parse(row.embedding) as number[]) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Determine the scope of a learning based on its repository and workspace fields. */
function annotateScope(learning: Learning): 'repo' | 'workspace' | 'global' {
  if (learning.repository !== null) return 'repo';
  if (learning.workspace !== null) return 'workspace';
  return 'global';
}

function rowToApiKey(row: RawApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    name: row.name,
    key_hash: row.key_hash,
    key_prefix: row.key_prefix,
    repositories: JSON.parse(row.repositories) as string[],
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    revoked: row.revoked === 1,
  };
}

// ---------------------------------------------------------------------------
// WHERE clause builders
// ---------------------------------------------------------------------------

/**
 * Build a WHERE clause for SQLite search queries.
 *
 * Implements three-scope filtering (WS-AC-12, WS-AC-15):
 * - Both repository and workspace: matches repo-specific OR workspace-wide OR global
 * - Only workspace: matches workspace-wide OR global
 * - Only repository (legacy path): matches repo-specific OR global (two-scope, AC-8)
 * - Neither: matches global only (WS-AC-15)
 *
 * @param filters - Search filters (AC-4, AC-8, AC-10, AC-29, WS-AC-12, WS-AC-15)
 * @param tableAlias - Optional table alias prefix (e.g. 'l' produces 'l.column').
 *   Pass an empty string (default) for unaliased column names used in direct
 *   table scans. Pass 'l' for FTS5 JOIN queries where the learnings table is
 *   aliased as 'l'.
 */
function buildWhereClause(
  filters: SearchFilters,
  tableAlias: string = ''
): { whereClause: string; whereParams: unknown[] } {
  const prefix = tableAlias ? `${tableAlias}.` : '';
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (!filters.include_deprecated) {
    conditions.push(`${prefix}status = 'active'`);
  }

  const hasRepo = filters.repository !== undefined && filters.repository !== null;
  const hasWs = filters.workspace !== undefined && filters.workspace !== null;

  if (hasRepo && hasWs) {
    // Three-scope search: repo-specific OR workspace-wide OR global (WS-AC-12)
    conditions.push(
      `(${prefix}repository = ? OR ${prefix}workspace = ? OR (${prefix}repository IS NULL AND ${prefix}workspace IS NULL))`
    );
    params.push(filters.repository, filters.workspace);
  } else if (hasRepo) {
    // Legacy two-scope search: repo-specific OR global (AC-8 backward compat)
    conditions.push(`(${prefix}repository = ? OR ${prefix}repository IS NULL)`);
    params.push(filters.repository);
  } else if (hasWs) {
    // Workspace-wide OR global
    conditions.push(
      `(${prefix}workspace = ? OR (${prefix}repository IS NULL AND ${prefix}workspace IS NULL))`
    );
    params.push(filters.workspace);
  } else {
    // Global-only search (WS-AC-15)
    conditions.push(`(${prefix}repository IS NULL AND ${prefix}workspace IS NULL)`);
  }

  if (filters.category) {
    conditions.push(`${prefix}category = ?`);
    params.push(filters.category);
  }
  if (filters.tags && filters.tags.length > 0) {
    const tagConds = filters.tags
      .map(() => `EXISTS (SELECT 1 FROM json_each(${prefix}tags) WHERE value = ?)`)
      .join(' OR ');
    conditions.push(`(${tagConds})`);
    params.push(...filters.tags);
  }

  return {
    whereClause: conditions.join(' AND '),
    whereParams: params,
  };
}

/**
 * Build WHERE clause for FTS5 JOIN queries where the learnings table is
 * aliased as 'l'. Delegates to buildWhereClause with tableAlias='l'.
 */
function buildJoinWhereClause(filters: SearchFilters): {
  whereClause: string;
  whereParams: unknown[];
} {
  return buildWhereClause(filters, 'l');
}

/**
 * Build WHERE clause for direct table scans (no join, no alias).
 * Delegates to buildWhereClause with no alias.
 */
function buildDirectWhereClause(filters: SearchFilters): {
  whereClause: string;
  whereParams: unknown[];
} {
  return buildWhereClause(filters, '');
}

// ---------------------------------------------------------------------------
// Search utilities
// ---------------------------------------------------------------------------

/** Escape a query string for FTS5 MATCH syntax to prevent parse errors. */
function ftsEscape(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}

/**
 * Normalize a BM25 score (typically negative) to a [0, 1] relevance score.
 * BM25 returns more-negative values for more-relevant results.
 */
function normalizeBm25Score(bm25: number): number {
  // Map via sigmoid: 1 / (1 + exp(bm25)) — since bm25 is negative, result is in (0.5, 1)
  return Math.min(1, Math.max(0, 1 / (1 + Math.exp(bm25))));
}

/**
 * Compute cosine similarity between two float vectors.
 * Returns a value in [-1, 1] where 1.0 = identical direction.
 * Traces to AC-9 (ranking by cosine similarity) and AC-12 (relevance score).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
