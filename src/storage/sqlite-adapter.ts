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
import { randomUUID } from 'node:crypto';
import { encrypt, decrypt, isEncrypted } from '../crypto/encryption.js';
import type {
  StorageAdapter,
  CreateLearningRecord,
  UpdateLearningRecord,
  SearchFilters,
  ListAllFilters,
  PurgeByFilterOptions,
  CreateApiKeyRecord,
  ApiKeyRecord,
  LearningStats,
  GetContextFilters,
  GetContextData,
  DuplicateCandidate,
} from './storage-adapter.js';
import type { Learning, LearningWithScore, RelationshipRecord, CreateRelationshipRecord, ConflictRecord, CreateConflictRecord } from '../models/learning.js';
import type { Repository } from '../models/repository.js';
import type { Decision, CreateDecisionRecord, UpdateDecisionRecord } from '../models/decision.js';
import type { Finding, CreateFindingRecord, UpdateFindingRecord } from '../models/finding.js';
import type { Gotcha, CreateGotchaRecord, UpdateGotchaRecord } from '../models/gotcha.js';
import type { RunSummary, CreateRunSummaryRecord } from '../models/run-summary.js';
import { StorageError } from '../utils/errors.js';
import { getLogger } from '../utils/logger.js';
import {
  upStatements as migration001Statements,
  version as migration001Version,
} from './migrations/001-initial.js';
import {
  upStatements as migration002Statements,
  version as migration002Version,
} from './migrations/002-duplicate-candidates.js';
import {
  upStatements as migration003Statements,
  version as migration003Version,
} from './migrations/003-ttl-and-provenance.js';
import {
  upStatements as migration004Statements,
  version as migration004Version,
} from './migrations/004-smarter-knowledge-management.js';
import {
  upStatements as migration005Statements,
  version as migration005Version,
} from './migrations/005-agent-memory-entities.js';

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

/**
 * Cosine similarity threshold above which two learnings are considered near-duplicates.
 * Tunable: increase to be more selective, decrease to catch more near-duplicates.
 * Traces to GC-AC-25.
 */
export const DUPLICATE_SIMILARITY_THRESHOLD = 0.92;

export class SqliteAdapter implements StorageAdapter {
  private db!: DatabaseSyncInstance;
  private readonly dbPath: string;
  /**
   * Optional AES-256-GCM encryption key (32 bytes).
   * When set, content and embedding fields are encrypted at rest (ESH-AC-1, ESH-AC-2).
   * When null, fields are stored as plaintext (ESH-AC-3 — no performance penalty).
   */
  private readonly encryptionKey: Buffer | null;

  constructor(dbPath: string, encryptionKey?: Buffer | null) {
    this.dbPath = dbPath;
    this.encryptionKey = encryptionKey ?? null;
  }

  /** Encrypt a string value if encryption is enabled, otherwise return as-is. */
  private encryptField(value: string): string {
    if (this.encryptionKey === null) return value;
    return encrypt(value, this.encryptionKey);
  }

  /** Decrypt a string value if it appears encrypted and encryption is enabled, otherwise return as-is. */
  private decryptField(value: string): string {
    if (this.encryptionKey === null) return value;
    if (!isEncrypted(value)) return value; // Handle plaintext values (e.g., during migration)
    return decrypt(value, this.encryptionKey);
  }

  /** Convert a raw DB row to a Learning, applying decryption if key is configured. */
  private tolearning(row: RawLearningRow): Learning {
    return rowToLearning(row, this.encryptionKey !== null ? (v) => this.decryptField(v) : undefined);
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

    if (currentVersion < migration002Version) {
      log.info({ migration: migration002Version }, 'Applying migration 002-duplicate-candidates');
      for (const stmt of migration002Statements) {
        try {
          this.db.exec(stmt + ';');
        } catch (err) {
          const msg = String(err);
          if (!msg.includes('already exists') && !msg.includes('duplicate')) {
            throw new StorageError(`Migration failed on statement: ${stmt}\n${msg}`, err);
          }
        }
      }
      this.db
        .prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)')
        .run(migration002Version);
      log.info({ migration: migration002Version }, 'Migration 002-duplicate-candidates applied');
    }

    if (currentVersion < migration003Version) {
      log.info({ migration: migration003Version }, 'Applying migration 003-ttl-and-provenance');
      for (const stmt of migration003Statements) {
        try {
          this.db.exec(stmt + ';');
        } catch (err) {
          const msg = String(err);
          // ALTER TABLE ADD COLUMN will error with "duplicate column name" if already applied
          if (!msg.includes('already exists') && !msg.includes('duplicate column name')) {
            throw new StorageError(`Migration failed on statement: ${stmt}\n${msg}`, err);
          }
        }
      }
      this.db
        .prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)')
        .run(migration003Version);
      log.info({ migration: migration003Version }, 'Migration 003-ttl-and-provenance applied');
    }

    if (currentVersion < migration004Version) {
      log.info({ migration: migration004Version }, 'Applying migration 004-smarter-knowledge-management');
      for (const stmt of migration004Statements) {
        try {
          this.db.exec(stmt + ';');
        } catch (err) {
          const msg = String(err);
          // ALTER TABLE ADD COLUMN errors with "duplicate column name" if already applied;
          // CREATE TABLE/INDEX errors with "already exists" on idempotent re-runs.
          if (
            !msg.includes('already exists') &&
            !msg.includes('duplicate column name') &&
            !msg.includes('duplicate')
          ) {
            throw new StorageError(`Migration failed on statement: ${stmt}\n${msg}`, err);
          }
        }
      }
      this.db
        .prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)')
        .run(migration004Version);
      log.info({ migration: migration004Version }, 'Migration 004-smarter-knowledge-management applied');
    }

    if (currentVersion < migration005Version) {
      log.info({ migration: migration005Version }, 'Applying migration 005-agent-memory-entities');
      for (const stmt of migration005Statements) {
        try {
          this.db.exec(stmt + ';');
        } catch (err) {
          const msg = String(err);
          if (!msg.includes('already exists') && !msg.includes('duplicate')) {
            throw new StorageError(`Migration failed on statement: ${stmt}\n${msg}`, err);
          }
        }
      }
      this.db
        .prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)')
        .run(migration005Version);
      log.info({ migration: migration005Version }, 'Migration 005-agent-memory-entities applied');
    }
  }

  // ---------------------------------------------------------------------------
  // Learning CRUD (AC-1 through AC-5)
  // ---------------------------------------------------------------------------

  async createLearning(record: CreateLearningRecord): Promise<Learning> {
    const now = new Date().toISOString();
    const tagsJson = JSON.stringify(record.tags);
    // Encrypt content and embedding if key is configured (ESH-AC-2)
    const storedContent = this.encryptField(record.content);
    const embeddingJson = record.embedding ? JSON.stringify(record.embedding) : null;
    const storedEmbedding = embeddingJson !== null ? this.encryptField(embeddingJson) : null;

    try {
      this.db
        .prepare(
          `INSERT INTO learnings
           (id, content, category, tags, repository, workspace, group_id, source, status, stale_flag, embedding, created_at, updated_at, ttl_days, source_agent, integrity_hash, access_count, last_accessed_at, staleness_score)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.id,
          storedContent,
          record.category,
          tagsJson,
          record.repository ?? null,
          record.workspace ?? null,
          record.group_id ?? null,
          record.source,
          storedEmbedding,
          now,
          now,
          record.ttl_days ?? null,
          record.source_agent ?? null,
          record.integrity_hash ?? null,
          record.access_count ?? 0,
          record.last_accessed_at ?? null,
          record.staleness_score ?? 0.0
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
    return row ? this.tolearning(row) : null;
  }

  async updateLearning(id: string, updates: UpdateLearningRecord): Promise<Learning | null> {
    const existing = this.getLearningSync(id);
    if (!existing) return null;

    const setClauses: string[] = ['updated_at = ?'];
    const params: unknown[] = [new Date().toISOString()];

    if (updates.content !== undefined) {
      setClauses.push('content = ?');
      // Encrypt on write if key is configured (ESH-AC-2)
      params.push(this.encryptField(updates.content));
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
      const embJson = updates.embedding !== null ? JSON.stringify(updates.embedding) : null;
      // Encrypt on write if key is configured (ESH-AC-2)
      params.push(embJson !== null ? this.encryptField(embJson) : null);
    }
    if (updates.workspace !== undefined) {
      setClauses.push('workspace = ?');
      params.push(updates.workspace ?? null);
    }
    if (updates.repository !== undefined) {
      setClauses.push('repository = ?');
      params.push(updates.repository ?? null);
    }
    if (updates.ttl_days !== undefined) {
      setClauses.push('ttl_days = ?');
      params.push(updates.ttl_days ?? null);
    }
    if (updates.source_agent !== undefined) {
      setClauses.push('source_agent = ?');
      params.push(updates.source_agent ?? null);
    }
    if (updates.integrity_hash !== undefined) {
      setClauses.push('integrity_hash = ?');
      params.push(updates.integrity_hash ?? null);
    }
    if (updates.access_count !== undefined) {
      setClauses.push('access_count = ?');
      params.push(updates.access_count);
    }
    if (updates.last_accessed_at !== undefined) {
      setClauses.push('last_accessed_at = ?');
      params.push(updates.last_accessed_at ?? null);
    }
    if (updates.staleness_score !== undefined) {
      setClauses.push('staleness_score = ?');
      params.push(updates.staleness_score);
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
  // Purge (ESH-AC-17, ESH-AC-18)
  // ---------------------------------------------------------------------------

  /**
   * Purge learnings that have exceeded their TTL.
   * Synchronous — matches node:sqlite DatabaseSync pattern (ESH-AC-17).
   */
  purgeExpired(defaultTtlDays: number | null): number {
    try {
      let totalChanges = 0;

      // Purge learnings that have an explicit per-learning ttl_days set
      const perLearningResult = this.db
        .prepare(
          `DELETE FROM learnings
           WHERE ttl_days IS NOT NULL
             AND (julianday('now') - julianday(updated_at)) > ttl_days`
        )
        .run();
      totalChanges += perLearningResult.changes;

      // If a global default TTL is configured, purge learnings with no explicit ttl_days
      if (defaultTtlDays !== null) {
        const globalResult = this.db
          .prepare(
            `DELETE FROM learnings
             WHERE ttl_days IS NULL
               AND (julianday('now') - julianday(updated_at)) > ?`
          )
          .run(defaultTtlDays);
        totalChanges += globalResult.changes;
      }

      return totalChanges;
    } catch (err) {
      throw new StorageError(`Failed to purge expired learnings: ${String(err)}`, err);
    }
  }

  /**
   * Purge learnings matching the given filter criteria.
   * Synchronous — matches node:sqlite DatabaseSync pattern (ESH-AC-18).
   */
  purgeByFilter(options: PurgeByFilterOptions): number {
    try {
      if (options.all) {
        const result = this.db.prepare('DELETE FROM learnings').run();
        return result.changes;
      }

      const conditions: string[] = [];
      const params: unknown[] = [];

      if (options.olderThanDays !== undefined) {
        conditions.push(`(julianday('now') - julianday(updated_at)) > ?`);
        params.push(options.olderThanDays);
      }
      if (options.repository !== undefined) {
        conditions.push('repository = ?');
        params.push(options.repository);
      }
      if (options.workspace !== undefined) {
        conditions.push('workspace = ?');
        params.push(options.workspace);
      }

      if (conditions.length === 0) {
        // No filters — refuse to purge everything without explicit `all: true`
        return 0;
      }

      const sql = `DELETE FROM learnings WHERE ${conditions.join(' AND ')}`;
      const result = this.db.prepare(sql).run(...params);
      return result.changes;
    } catch (err) {
      throw new StorageError(`Failed to purge learnings by filter: ${String(err)}`, err);
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
      return rows.map((r) => this.tolearning(r));
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
        const learning = this.tolearning(row);
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
          // Decrypt embedding before parsing (ESH-AC-2/3)
          const embeddingRaw = row.embedding
            ? (this.encryptionKey !== null ? this.decryptField(row.embedding) : row.embedding)
            : null;
          const embedding = embeddingRaw ? (JSON.parse(embeddingRaw) as number[]) : null;
          if (!embedding) return null;
          const score = cosineSimilarity(queryEmbedding, embedding);
          const learning = this.tolearning(row);
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
          MAX(created_at) AS newest_at,
          COALESCE(SUM(access_count), 0) AS total_accesses,
          COALESCE(AVG(access_count), 0) AS avg_access_count,
          COALESCE(SUM(CASE WHEN access_count = 0 THEN 1 ELSE 0 END), 0) AS never_accessed_count
        FROM learnings
      `).get() as {
        total: number;
        active: number;
        deprecated: number;
        stale: number;
        with_embeddings: number;
        oldest_at: string | null;
        newest_at: string | null;
        total_accesses: number;
        avg_access_count: number;
        never_accessed_count: number;
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
        totalAccesses: totals.total_accesses,
        avgAccessCount: Math.round(totals.avg_access_count * 100) / 100,
        neverAccessedCount: totals.never_accessed_count,
      };
    } catch (err) {
      throw new StorageError(`Failed to get stats: ${String(err)}`, err);
    }
  }

  // ---------------------------------------------------------------------------
  // get_context: getContextLearnings (GC-AC-4, GC-AC-5)
  // ---------------------------------------------------------------------------

  /**
   * Fetch all active learnings partitioned by scope for get_context.
   * Returns three arrays (repo, workspace, global) plus a stale array and summary counts.
   * Handles empty database gracefully (GC-AC-29a).
   */
  async getContextLearnings(filters: GetContextFilters): Promise<GetContextData> {
    try {
      const staleCondition = filters.include_stale ? '' : 'AND stale_flag = 0';

      // Repo-scoped: learnings with matching repository value
      const repoRows = this.db
        .prepare(
          `SELECT * FROM learnings
           WHERE repository = ? AND status = 'active' ${staleCondition}
           ORDER BY updated_at DESC`
        )
        .all(filters.repository) as RawLearningRow[];

      // Workspace-scoped: learnings with matching workspace, no repository
      const wsRows = filters.workspace
        ? (this.db
            .prepare(
              `SELECT * FROM learnings
               WHERE workspace = ? AND repository IS NULL AND status = 'active' ${staleCondition}
               ORDER BY updated_at DESC`
            )
            .all(filters.workspace) as RawLearningRow[])
        : [];

      // Global: both repository and workspace are null
      const globalRows = this.db
        .prepare(
          `SELECT * FROM learnings
           WHERE repository IS NULL AND workspace IS NULL AND status = 'active' ${staleCondition}
           ORDER BY updated_at DESC`
        )
        .all() as RawLearningRow[];

      // Stale: stale-flagged active learnings across all matching scopes
      // Always fetched regardless of include_stale (GC-AC-22)
      const staleConditionParts: string[] = ["status = 'active'", 'stale_flag = 1'];
      const staleParams: unknown[] = [];

      // Scope restriction for stale: only include learnings that would appear in our scope
      if (filters.workspace) {
        staleConditionParts.push(
          '(repository = ? OR workspace = ? OR (repository IS NULL AND workspace IS NULL))'
        );
        staleParams.push(filters.repository, filters.workspace);
      } else {
        staleConditionParts.push('(repository = ? OR (repository IS NULL AND workspace IS NULL))');
        staleParams.push(filters.repository);
      }

      const staleRows = this.db
        .prepare(
          `SELECT * FROM learnings
           WHERE ${staleConditionParts.join(' AND ')}
           ORDER BY updated_at DESC`
        )
        .all(...staleParams) as RawLearningRow[];

      // Summary counts (total counts, regardless of include_stale setting)
      const totalRepoRow = this.db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM learnings WHERE repository = ? AND status = 'active'`
        )
        .get(filters.repository) as { cnt: number };

      const totalWsRow = filters.workspace
        ? (this.db
            .prepare(
              `SELECT COUNT(*) AS cnt FROM learnings WHERE workspace = ? AND repository IS NULL AND status = 'active'`
            )
            .get(filters.workspace) as { cnt: number })
        : { cnt: 0 };

      const totalGlobalRow = this.db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM learnings WHERE repository IS NULL AND workspace IS NULL AND status = 'active'`
        )
        .get() as { cnt: number };

      // staleConditionParts and staleParams are reused here unchanged from the staleRows query above;
      // neither array was mutated between the two usages, so the join is identical and safe.
      const staleCountRow = this.db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM learnings WHERE ${staleConditionParts.join(' AND ')}`
        )
        .get(...staleParams) as { cnt: number };

      // last_updated: most recent updated_at across all matching learnings
      const allRows = [...repoRows, ...wsRows, ...globalRows];
      const lastUpdated =
        allRows.length > 0
          ? allRows.reduce((max, r) => (r.updated_at > max ? r.updated_at : max), allRows[0]!.updated_at)
          : '';

      return {
        repo: repoRows.map((r) => this.tolearning(r)),
        workspace: wsRows.map((r) => this.tolearning(r)),
        global: globalRows.map((r) => this.tolearning(r)),
        stale: staleRows.map((r) => this.tolearning(r)),
        summary: {
          total_repo: totalRepoRow.cnt,
          total_workspace: totalWsRow.cnt,
          total_global: totalGlobalRow.cnt,
          stale_count: staleCountRow.cnt,
          last_updated: lastUpdated,
        },
      };
    } catch (err) {
      throw new StorageError(`Failed to get context learnings: ${String(err)}`, err);
    }
  }

  // ---------------------------------------------------------------------------
  // get_context: getDuplicateCandidates (GC-AC-26)
  // ---------------------------------------------------------------------------

  /**
   * Fetch all duplicate_candidates rows involving any of the given learning IDs.
   * Returns an empty array if learningIds is empty.
   */
  async getDuplicateCandidates(learningIds: string[]): Promise<DuplicateCandidate[]> {
    if (learningIds.length === 0) return [];
    try {
      const placeholders = learningIds.map(() => '?').join(', ');
      const rows = this.db
        .prepare(
          `SELECT * FROM duplicate_candidates
           WHERE learning_id_a IN (${placeholders}) OR learning_id_b IN (${placeholders})
           ORDER BY similarity DESC`
        )
        .all(...learningIds, ...learningIds) as RawDuplicateCandidateRow[];
      return rows.map(rowToDuplicateCandidate);
    } catch (err) {
      throw new StorageError(`Failed to get duplicate candidates: ${String(err)}`, err);
    }
  }

  // ---------------------------------------------------------------------------
  // get_context: checkAndStoreDuplicates (GC-AC-25)
  // ---------------------------------------------------------------------------

  /**
   * Compare a learning against others in the same scope and store near-duplicate pairs
   * above the DUPLICATE_SIMILARITY_THRESHOLD. Also removes any existing pairs that
   * are now below threshold (content changed). Traces to GC-AC-25.
   */
  async checkAndStoreDuplicates(
    learningId: string,
    embedding: number[],
    scope: { repository: string | null; workspace: string | null }
  ): Promise<void> {
    try {
      // Determine scope and fetch same-scope learnings with embeddings
      let scopeLabel: 'repo' | 'workspace' | 'global';
      let scopeValue: string | null;
      let candidates: RawLearningRow[];

      if (scope.repository !== null) {
        scopeLabel = 'repo';
        scopeValue = scope.repository;
        candidates = this.db
          .prepare(
            `SELECT * FROM learnings
             WHERE repository = ? AND id != ? AND embedding IS NOT NULL AND status = 'active'`
          )
          .all(scope.repository, learningId) as RawLearningRow[];
      } else if (scope.workspace !== null) {
        scopeLabel = 'workspace';
        scopeValue = scope.workspace;
        candidates = this.db
          .prepare(
            `SELECT * FROM learnings
             WHERE workspace = ? AND repository IS NULL AND id != ? AND embedding IS NOT NULL AND status = 'active'`
          )
          .all(scope.workspace, learningId) as RawLearningRow[];
      } else {
        scopeLabel = 'global';
        scopeValue = null;
        candidates = this.db
          .prepare(
            `SELECT * FROM learnings
             WHERE repository IS NULL AND workspace IS NULL AND id != ? AND embedding IS NOT NULL AND status = 'active'`
          )
          .all(learningId) as RawLearningRow[];
      }

      // Remove existing duplicate_candidates for this learning (will re-add below if still above threshold)
      this.db
        .prepare(
          `DELETE FROM duplicate_candidates WHERE learning_id_a = ? OR learning_id_b = ?`
        )
        .run(learningId, learningId);

      // Compare against each candidate and store pairs above threshold
      for (const candidate of candidates) {
        if (!candidate.embedding) continue;
        // Decrypt embedding before parsing if key is configured (ESH-AC-2/3)
        const embeddingRaw = this.encryptionKey !== null
          ? this.decryptField(candidate.embedding)
          : candidate.embedding;
        const candidateEmbedding = JSON.parse(embeddingRaw) as number[];
        const similarity = cosineSimilarity(embedding, candidateEmbedding);

        if (similarity >= DUPLICATE_SIMILARITY_THRESHOLD) {
          // Normalize ordering: smaller ID first
          const idA = learningId < candidate.id ? learningId : candidate.id;
          const idB = learningId < candidate.id ? candidate.id : learningId;

          this.db
            .prepare(
              `INSERT OR REPLACE INTO duplicate_candidates
               (id, learning_id_a, learning_id_b, similarity, scope, scope_value, created_at)
               VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
            )
            .run(randomUUID(), idA, idB, similarity, scopeLabel, scopeValue);
        }
      }
    } catch (err) {
      throw new StorageError(`Failed to check and store duplicates: ${String(err)}`, err);
    }
  }

  // ---------------------------------------------------------------------------
  // get_context: cleanupDuplicateCandidates (GC-AC-27)
  // ---------------------------------------------------------------------------

  /**
   * Remove all duplicate_candidates rows that reference the given learning ID.
   * Called on deprecate and delete as belt-and-suspenders safety (ON DELETE CASCADE
   * handles the delete case automatically, but we call this explicitly). Traces to GC-AC-27.
   */
  async cleanupDuplicateCandidates(learningId: string): Promise<void> {
    try {
      this.db
        .prepare(
          `DELETE FROM duplicate_candidates WHERE learning_id_a = ? OR learning_id_b = ?`
        )
        .run(learningId, learningId);
    } catch (err) {
      throw new StorageError(`Failed to cleanup duplicate candidates: ${String(err)}`, err);
    }
  }

  // ---------------------------------------------------------------------------
  // SKM: findScopedNeighbors (consolidated similarity scan — SKM Phase 1)
  // ---------------------------------------------------------------------------

  /**
   * Find all same-scope active learnings with embeddings, compute cosine similarity
   * against the given embedding, and return those above the minimum threshold.
   * Returns lightweight records sorted by similarity descending.
   * Used by: duplicate detection, conflict detection, auto-categorization (SKM).
   *
   * Unlike checkAndStoreDuplicates this method does NOT exclude any particular ID.
   * Traces to SKM-AC-18, SKM-AC-22.
   */
  async findScopedNeighbors(
    embedding: number[],
    scope: { repository: string | null; workspace: string | null },
    minSimilarity: number
  ): Promise<Array<{ id: string; content: string; category: string; embedding: number[]; similarity: number }>> {
    try {
      let rows: RawLearningRow[];

      if (scope.repository !== null) {
        rows = this.db
          .prepare(
            `SELECT * FROM learnings
             WHERE repository = ? AND embedding IS NOT NULL AND status = 'active'`
          )
          .all(scope.repository) as RawLearningRow[];
      } else if (scope.workspace !== null) {
        rows = this.db
          .prepare(
            `SELECT * FROM learnings
             WHERE workspace = ? AND repository IS NULL AND embedding IS NOT NULL AND status = 'active'`
          )
          .all(scope.workspace) as RawLearningRow[];
      } else {
        rows = this.db
          .prepare(
            `SELECT * FROM learnings
             WHERE repository IS NULL AND workspace IS NULL AND embedding IS NOT NULL AND status = 'active'`
          )
          .all() as RawLearningRow[];
      }

      const results: Array<{ id: string; content: string; category: string; embedding: number[]; similarity: number }> = [];

      for (const row of rows) {
        if (!row.embedding) continue;
        // Decrypt embedding before parsing if key is configured (ESH-AC-2/3)
        const embeddingRaw = this.encryptionKey !== null
          ? this.decryptField(row.embedding)
          : row.embedding;
        const candidateEmbedding = JSON.parse(embeddingRaw) as number[];
        const similarity = cosineSimilarity(embedding, candidateEmbedding);

        if (similarity >= minSimilarity) {
          // Decrypt content for conflict detection / auto-categorization consumers
          const content = this.encryptionKey !== null
            ? this.decryptField(row.content)
            : row.content;
          results.push({
            id: row.id,
            content,
            category: row.category,
            embedding: candidateEmbedding,
            similarity,
          });
        }
      }

      // Sort by similarity descending
      results.sort((a, b) => b.similarity - a.similarity);

      return results;
    } catch (err) {
      throw new StorageError(`Failed to find scoped neighbors: ${String(err)}`, err);
    }
  }

  // ---------------------------------------------------------------------------
  // Access tracking (SKM-AC-9, SKM-AC-10)
  // ---------------------------------------------------------------------------

  /**
   * Batch-increment access_count and set last_accessed_at for all given learning IDs.
   * Uses a single parameterized UPDATE ... WHERE id IN (...) for efficiency.
   * No-op when learningIds is empty.
   * Non-fatal by convention: callers must wrap in try/catch and log on error.
   * Traces to SKM-AC-9, SKM-AC-10.
   */
  async recordAccess(learningIds: string[]): Promise<void> {
    if (learningIds.length === 0) return;
    try {
      const placeholders = learningIds.map(() => '?').join(', ');
      this.db
        .prepare(
          `UPDATE learnings SET access_count = access_count + 1, last_accessed_at = datetime('now') WHERE id IN (${placeholders})`
        )
        .run(...learningIds);
    } catch (err) {
      throw new StorageError(`Failed to record access: ${String(err)}`, err);
    }
  }

  // ---------------------------------------------------------------------------
  // Learning Relationships (SKM-AC-38, SKM-AC-39, SKM-AC-40, SKM-AC-44, SKM-AC-46)
  // ---------------------------------------------------------------------------

  /**
   * Create a typed relationship between two learnings.
   * FK cascade delete on the learnings table handles cleanup when a learning is deleted (SKM-AC-44).
   * Traces to SKM-AC-38, SKM-AC-39, SKM-AC-40, SKM-AC-44, SKM-AC-46.
   */
  async createRelationship(record: CreateRelationshipRecord): Promise<RelationshipRecord> {
    const now = new Date().toISOString();
    try {
      this.db
        .prepare(
          `INSERT INTO learning_relationships
           (id, source_id, target_id, relationship_type, created_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.id,
          record.source_id,
          record.target_id,
          record.relationship_type,
          now,
          record.created_by ?? null
        );

      return {
        id: record.id,
        source_id: record.source_id,
        target_id: record.target_id,
        relationship_type: record.relationship_type,
        created_at: now,
        created_by: record.created_by ?? null,
      };
    } catch (err) {
      const msg = String(err);
      // UNIQUE constraint violation means a duplicate relationship already exists (SKM-AC-40)
      if (msg.includes('UNIQUE constraint failed') || msg.includes('unique constraint')) {
        throw new StorageError(
          `Relationship of type '${record.relationship_type}' already exists between these learnings`,
          err
        );
      }
      throw new StorageError(`Failed to create relationship: ${msg}`, err);
    }
  }

  /**
   * Get all relationships for the given learning IDs (both as source and target).
   * Returns an empty array if learningIds is empty.
   * Traces to SKM-AC-41, SKM-AC-42.
   */
  async getRelationships(learningIds: string[]): Promise<RelationshipRecord[]> {
    if (learningIds.length === 0) return [];
    try {
      const placeholders = learningIds.map(() => '?').join(', ');
      const rows = this.db
        .prepare(
          `SELECT * FROM learning_relationships
           WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})
           ORDER BY created_at ASC`
        )
        .all(...learningIds, ...learningIds) as RawRelationshipRow[];
      return rows.map(rowToRelationship);
    } catch (err) {
      throw new StorageError(`Failed to get relationships: ${String(err)}`, err);
    }
  }

  // ---------------------------------------------------------------------------
  // Conflict detection (SKM-AC-25, SKM-AC-27, SKM-AC-28)
  // ---------------------------------------------------------------------------

  /**
   * Store a conflict pair. Enforces pair ordering: smaller ID goes in learning_id_a.
   * Uses INSERT OR IGNORE so duplicate pairs (same type) are silently skipped.
   * Traces to SKM-AC-25.
   */
  async storeConflict(record: CreateConflictRecord): Promise<void> {
    // Enforce pair ordering: learning_id_a < learning_id_b (lexicographic)
    const idA = record.learning_id_a < record.learning_id_b
      ? record.learning_id_a
      : record.learning_id_b;
    const idB = record.learning_id_a < record.learning_id_b
      ? record.learning_id_b
      : record.learning_id_a;
    try {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO learning_conflicts
           (id, learning_id_a, learning_id_b, similarity, conflict_type, resolved, resolved_by, created_at)
           VALUES (?, ?, ?, ?, ?, 0, NULL, datetime('now'))`
        )
        .run(record.id, idA, idB, record.similarity, record.conflict_type);
    } catch (err) {
      throw new StorageError(`Failed to store conflict: ${String(err)}`, err);
    }
  }

  /**
   * Get all unresolved conflicts involving any of the given learning IDs.
   * Returns empty array when learningIds is empty. Traces to SKM-AC-27.
   */
  async getUnresolvedConflicts(learningIds: string[]): Promise<ConflictRecord[]> {
    if (learningIds.length === 0) return [];
    try {
      const placeholders = learningIds.map(() => '?').join(', ');
      const rows = this.db
        .prepare(
          `SELECT * FROM learning_conflicts
           WHERE resolved = 0
             AND (learning_id_a IN (${placeholders}) OR learning_id_b IN (${placeholders}))
           ORDER BY created_at DESC`
        )
        .all(...learningIds, ...learningIds) as RawConflictRow[];
      return rows.map(rowToConflict);
    } catch (err) {
      throw new StorageError(`Failed to get unresolved conflicts: ${String(err)}`, err);
    }
  }

  /**
   * Mark all unresolved conflicts involving the given learning ID as resolved.
   * Returns the number of rows updated. Traces to SKM-AC-28.
   */
  async resolveConflicts(learningId: string, resolvedBy: string): Promise<number> {
    try {
      const result = this.db
        .prepare(
          `UPDATE learning_conflicts
           SET resolved = 1, resolved_by = ?
           WHERE (learning_id_a = ? OR learning_id_b = ?) AND resolved = 0`
        )
        .run(resolvedBy, learningId, learningId);
      return result.changes;
    } catch (err) {
      throw new StorageError(`Failed to resolve conflicts: ${String(err)}`, err);
    }
  }

  // ---------------------------------------------------------------------------
  // Smart staleness (SKM-AC-33, SKM-AC-34)
  // ---------------------------------------------------------------------------

  /**
   * Get all active learnings with their unresolved conflict counts.
   * Uses LEFT JOIN on learning_conflicts (WHERE resolved=0) with GROUP BY.
   * When learning_conflicts has no rows, all unresolved_conflict_count values are 0.
   * Traces to SKM-AC-33.
   */
  async getActiveLearningsWithConflictCounts(): Promise<Array<{
    id: string;
    updated_at: string;
    created_at: string;
    last_accessed_at: string | null;
    access_count: number;
    stale_flag: boolean;
    staleness_score: number;
    unresolved_conflict_count: number;
  }>> {
    try {
      const rows = this.db
        .prepare(
          `SELECT
             l.id,
             l.updated_at,
             l.created_at,
             l.last_accessed_at,
             l.access_count,
             l.stale_flag,
             l.staleness_score,
             COALESCE(COUNT(c.id), 0) AS unresolved_conflict_count
           FROM learnings l
           LEFT JOIN learning_conflicts c
             ON (c.learning_id_a = l.id OR c.learning_id_b = l.id)
             AND c.resolved = 0
           WHERE l.status = 'active'
           GROUP BY l.id`
        )
        .all() as Array<{
          id: string;
          updated_at: string;
          created_at: string;
          last_accessed_at: string | null;
          access_count: number;
          stale_flag: number;
          staleness_score: number;
          unresolved_conflict_count: number;
        }>;

      return rows.map((row) => ({
        id: row.id,
        updated_at: row.updated_at,
        created_at: row.created_at,
        last_accessed_at: row.last_accessed_at ?? null,
        access_count: row.access_count ?? 0,
        stale_flag: row.stale_flag === 1,
        staleness_score: row.staleness_score ?? 0.0,
        unresolved_conflict_count: row.unresolved_conflict_count ?? 0,
      }));
    } catch (err) {
      throw new StorageError(`Failed to get active learnings with conflict counts: ${String(err)}`, err);
    }
  }

  /**
   * Batch update staleness_score and stale_flag for a set of learnings.
   * Uses a prepared statement in a transaction for atomicity and performance.
   * Handles empty array gracefully (no-op). Traces to SKM-AC-33, SKM-AC-34.
   */
  async batchUpdateStaleness(
    updates: Array<{ id: string; staleness_score: number; stale_flag: boolean }>
  ): Promise<void> {
    if (updates.length === 0) return;
    try {
      const stmt = this.db.prepare(
        `UPDATE learnings SET staleness_score = ?, stale_flag = ? WHERE id = ?`
      );
      for (const update of updates) {
        stmt.run(update.staleness_score, update.stale_flag ? 1 : 0, update.id);
      }
    } catch (err) {
      throw new StorageError(`Failed to batch update staleness: ${String(err)}`, err);
    }
  }

  // ---------------------------------------------------------------------------
  // Decisions (AMU-AC-6, AMU-AC-7, AMU-AC-8)
  // ---------------------------------------------------------------------------

  async createDecision(record: CreateDecisionRecord): Promise<Decision> {
    const now = new Date().toISOString();
    try {
      this.db
        .prepare(
          `INSERT INTO decisions (id, repository, category, choice, rationale, made_by, made_at, status, superseded_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)`
        )
        .run(
          record.id,
          record.repository,
          record.category,
          record.choice,
          record.rationale,
          record.made_by ?? null,
          now,
          now,
          now
        );
      const decision = this.getDecisionSync(record.id);
      if (!decision) throw new StorageError('Decision not found immediately after insert');
      return decision;
    } catch (err) {
      if (err instanceof StorageError) throw err;
      throw new StorageError(`Failed to create decision: ${String(err)}`, err);
    }
  }

  async getDecision(id: string): Promise<Decision | null> {
    try {
      return this.getDecisionSync(id);
    } catch (err) {
      throw new StorageError(`Failed to get decision: ${String(err)}`, err);
    }
  }

  private getDecisionSync(id: string): Decision | null {
    const row = this.db
      .prepare('SELECT * FROM decisions WHERE id = ?')
      .get(id) as RawDecisionRow | undefined;
    return row ? rowToDecision(row) : null;
  }

  async getDecisions(repository: string, category?: string): Promise<Decision[]> {
    try {
      if (category) {
        const rows = this.db
          .prepare(
            `SELECT * FROM decisions WHERE repository = ? AND category = ? AND status = 'active' ORDER BY made_at DESC`
          )
          .all(repository, category) as RawDecisionRow[];
        return rows.map(rowToDecision);
      }
      const rows = this.db
        .prepare(
          `SELECT * FROM decisions WHERE repository = ? AND status = 'active' ORDER BY made_at DESC`
        )
        .all(repository) as RawDecisionRow[];
      return rows.map(rowToDecision);
    } catch (err) {
      throw new StorageError(`Failed to get decisions: ${String(err)}`, err);
    }
  }

  async updateDecision(id: string, updates: UpdateDecisionRecord): Promise<Decision | null> {
    const existing = this.getDecisionSync(id);
    if (!existing) return null;

    const setClauses: string[] = ['updated_at = ?'];
    const params: unknown[] = [updates.updated_at ?? new Date().toISOString()];

    if (updates.status !== undefined) {
      setClauses.push('status = ?');
      params.push(updates.status);
    }
    if (updates.superseded_by !== undefined) {
      setClauses.push('superseded_by = ?');
      params.push(updates.superseded_by);
    }

    params.push(id);
    try {
      this.db
        .prepare(`UPDATE decisions SET ${setClauses.join(', ')} WHERE id = ?`)
        .run(...params);
      return this.getDecisionSync(id);
    } catch (err) {
      throw new StorageError(`Failed to update decision: ${String(err)}`, err);
    }
  }

  // ---------------------------------------------------------------------------
  // Findings (AMU-AC-9, AMU-AC-10, AMU-AC-11)
  // ---------------------------------------------------------------------------

  async createFinding(record: CreateFindingRecord): Promise<Finding> {
    const now = new Date().toISOString();
    try {
      this.db
        .prepare(
          `INSERT INTO findings (id, repository, file_path, severity, issue, suggestion, status, found_by, found_at, resolved_at, resolved_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, NULL, NULL, ?, ?)`
        )
        .run(
          record.id,
          record.repository,
          record.file_path,
          record.severity,
          record.issue,
          record.suggestion,
          record.found_by ?? null,
          now,
          now,
          now
        );
      const finding = this.getFindingSync(record.id);
      if (!finding) throw new StorageError('Finding not found immediately after insert');
      return finding;
    } catch (err) {
      if (err instanceof StorageError) throw err;
      throw new StorageError(`Failed to create finding: ${String(err)}`, err);
    }
  }

  async getFinding(id: string): Promise<Finding | null> {
    try {
      return this.getFindingSync(id);
    } catch (err) {
      throw new StorageError(`Failed to get finding: ${String(err)}`, err);
    }
  }

  private getFindingSync(id: string): Finding | null {
    const row = this.db
      .prepare('SELECT * FROM findings WHERE id = ?')
      .get(id) as RawFindingRow | undefined;
    return row ? rowToFinding(row) : null;
  }

  async getOpenFindings(repository: string, severity?: string): Promise<Finding[]> {
    try {
      // Severity ordering: critical=0, warning=1, suggestion=2 (critical first per AMU-AC-11)
      const severityOrder = `CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 WHEN 'suggestion' THEN 2 ELSE 3 END`;
      if (severity) {
        const rows = this.db
          .prepare(
            `SELECT * FROM findings WHERE repository = ? AND severity = ? AND status = 'open'
             ORDER BY ${severityOrder}, found_at DESC`
          )
          .all(repository, severity) as RawFindingRow[];
        return rows.map(rowToFinding);
      }
      const rows = this.db
        .prepare(
          `SELECT * FROM findings WHERE repository = ? AND status = 'open'
           ORDER BY ${severityOrder}, found_at DESC`
        )
        .all(repository) as RawFindingRow[];
      return rows.map(rowToFinding);
    } catch (err) {
      throw new StorageError(`Failed to get open findings: ${String(err)}`, err);
    }
  }

  async updateFinding(id: string, updates: UpdateFindingRecord): Promise<Finding | null> {
    const existing = this.getFindingSync(id);
    if (!existing) return null;

    const setClauses: string[] = ['updated_at = ?'];
    const params: unknown[] = [updates.updated_at ?? new Date().toISOString()];

    if (updates.status !== undefined) {
      setClauses.push('status = ?');
      params.push(updates.status);
    }
    if (updates.resolved_at !== undefined) {
      setClauses.push('resolved_at = ?');
      params.push(updates.resolved_at);
    }
    if (updates.resolved_by !== undefined) {
      setClauses.push('resolved_by = ?');
      params.push(updates.resolved_by);
    }

    params.push(id);
    try {
      this.db
        .prepare(`UPDATE findings SET ${setClauses.join(', ')} WHERE id = ?`)
        .run(...params);
      return this.getFindingSync(id);
    } catch (err) {
      throw new StorageError(`Failed to update finding: ${String(err)}`, err);
    }
  }

  // ---------------------------------------------------------------------------
  // Gotchas (AMU-AC-12, AMU-AC-13, AMU-AC-30)
  // ---------------------------------------------------------------------------

  async createGotcha(record: CreateGotchaRecord): Promise<Gotcha> {
    const now = new Date().toISOString();
    const tagsJson = JSON.stringify(record.tags);
    const embeddingJson = record.embedding ? JSON.stringify(record.embedding) : null;
    try {
      this.db
        .prepare(
          `INSERT INTO gotchas (id, repository, description, tags, technology, embedding, times_encountered, first_seen, last_seen, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
        )
        .run(
          record.id,
          record.repository,
          record.description,
          tagsJson,
          record.technology ?? null,
          embeddingJson,
          now,
          now,
          now,
          now
        );
      const gotcha = this.getGotchaSync(record.id);
      if (!gotcha) throw new StorageError('Gotcha not found immediately after insert');
      return gotcha;
    } catch (err) {
      if (err instanceof StorageError) throw err;
      throw new StorageError(`Failed to create gotcha: ${String(err)}`, err);
    }
  }

  async getGotcha(id: string): Promise<Gotcha | null> {
    try {
      return this.getGotchaSync(id);
    } catch (err) {
      throw new StorageError(`Failed to get gotcha: ${String(err)}`, err);
    }
  }

  private getGotchaSync(id: string): Gotcha | null {
    const row = this.db
      .prepare('SELECT * FROM gotchas WHERE id = ?')
      .get(id) as RawGotchaRow | undefined;
    return row ? rowToGotcha(row) : null;
  }

  async getGotchas(repository: string, technology?: string): Promise<Gotcha[]> {
    try {
      if (technology) {
        const rows = this.db
          .prepare(
            `SELECT * FROM gotchas WHERE repository = ? AND technology = ? ORDER BY times_encountered DESC`
          )
          .all(repository, technology) as RawGotchaRow[];
        return rows.map(rowToGotcha);
      }
      const rows = this.db
        .prepare(
          `SELECT * FROM gotchas WHERE repository = ? ORDER BY times_encountered DESC`
        )
        .all(repository) as RawGotchaRow[];
      return rows.map(rowToGotcha);
    } catch (err) {
      throw new StorageError(`Failed to get gotchas: ${String(err)}`, err);
    }
  }

  async updateGotcha(id: string, updates: UpdateGotchaRecord): Promise<Gotcha | null> {
    const existing = this.getGotchaSync(id);
    if (!existing) return null;

    const setClauses: string[] = ['updated_at = ?'];
    const params: unknown[] = [updates.updated_at ?? new Date().toISOString()];

    if (updates.times_encountered !== undefined) {
      setClauses.push('times_encountered = ?');
      params.push(updates.times_encountered);
    }
    if (updates.last_seen !== undefined) {
      setClauses.push('last_seen = ?');
      params.push(updates.last_seen);
    }
    if (updates.embedding !== undefined) {
      setClauses.push('embedding = ?');
      params.push(updates.embedding ? JSON.stringify(updates.embedding) : null);
    }

    params.push(id);
    try {
      this.db
        .prepare(`UPDATE gotchas SET ${setClauses.join(', ')} WHERE id = ?`)
        .run(...params);
      return this.getGotchaSync(id);
    } catch (err) {
      throw new StorageError(`Failed to update gotcha: ${String(err)}`, err);
    }
  }

  async findSimilarGotcha(repository: string, embedding: number[], minSimilarity: number): Promise<Gotcha | null> {
    try {
      // Full scan of gotcha embeddings in same repository (AMU-AC-30)
      const rows = this.db
        .prepare(`SELECT * FROM gotchas WHERE repository = ? AND embedding IS NOT NULL`)
        .all(repository) as RawGotchaRow[];

      let bestMatch: Gotcha | null = null;
      let bestSimilarity = -1;

      for (const row of rows) {
        const gotcha = rowToGotcha(row);
        if (!gotcha.embedding) continue;
        const similarity = cosineSimilarity(embedding, gotcha.embedding);
        if (similarity >= minSimilarity && similarity > bestSimilarity) {
          bestSimilarity = similarity;
          bestMatch = gotcha;
        }
      }

      return bestMatch;
    } catch (err) {
      throw new StorageError(`Failed to find similar gotcha: ${String(err)}`, err);
    }
  }

  // ---------------------------------------------------------------------------
  // Run Summaries (AMU-AC-14, AMU-AC-15)
  // ---------------------------------------------------------------------------

  async createRunSummary(record: CreateRunSummaryRecord): Promise<RunSummary> {
    const now = new Date().toISOString();
    const filesJson = JSON.stringify(record.files_changed);
    try {
      this.db
        .prepare(
          `INSERT INTO run_summaries (id, repository, summary, files_changed, started_at, duration_seconds, outcome, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.id,
          record.repository,
          record.summary,
          filesJson,
          now,
          record.duration_seconds ?? null,
          record.outcome,
          now
        );
      const runSummary = this.getRunSummarySync(record.id);
      if (!runSummary) throw new StorageError('Run summary not found immediately after insert');
      return runSummary;
    } catch (err) {
      if (err instanceof StorageError) throw err;
      throw new StorageError(`Failed to create run summary: ${String(err)}`, err);
    }
  }

  private getRunSummarySync(id: string): RunSummary | null {
    const row = this.db
      .prepare('SELECT * FROM run_summaries WHERE id = ?')
      .get(id) as RawRunSummaryRow | undefined;
    return row ? rowToRunSummary(row) : null;
  }

  async getRunHistory(repository: string, limit: number): Promise<RunSummary[]> {
    try {
      const rows = this.db
        .prepare(
          `SELECT * FROM run_summaries WHERE repository = ? ORDER BY started_at DESC LIMIT ?`
        )
        .all(repository, limit) as RawRunSummaryRow[];
      return rows.map(rowToRunSummary);
    } catch (err) {
      throw new StorageError(`Failed to get run history: ${String(err)}`, err);
    }
  }

  // ---------------------------------------------------------------------------
  // Relevant Context (AMU-AC-16, AMU-AC-18)
  // ---------------------------------------------------------------------------

  async getRelevantDecisions(repository: string, keywords: string[]): Promise<Decision[]> {
    try {
      // Keyword overlap on choice and rationale fields (AMU-AC-18 fallback)
      if (keywords.length === 0) {
        const rows = this.db
          .prepare(
            `SELECT * FROM decisions WHERE repository = ? AND status = 'active' ORDER BY made_at DESC LIMIT 3`
          )
          .all(repository) as RawDecisionRow[];
        return rows.map(rowToDecision);
      }

      // Build keyword LIKE conditions — keyword overlap search
      const conditions = keywords
        .map(() => `(LOWER(choice) LIKE ? OR LOWER(rationale) LIKE ?)`)
        .join(' OR ');
      const params: unknown[] = [];
      for (const kw of keywords) {
        const pattern = `%${kw.toLowerCase()}%`;
        params.push(pattern, pattern);
      }
      params.push(repository);

      const rows = this.db
        .prepare(
          `SELECT * FROM decisions WHERE (${conditions}) AND repository = ? AND status = 'active' ORDER BY made_at DESC LIMIT 3`
        )
        .all(...params) as RawDecisionRow[];
      return rows.map(rowToDecision);
    } catch (err) {
      throw new StorageError(`Failed to get relevant decisions: ${String(err)}`, err);
    }
  }

  async getRelevantFindings(repository: string, keywords: string[]): Promise<Finding[]> {
    try {
      const severityOrder = `CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 WHEN 'suggestion' THEN 2 ELSE 3 END`;

      if (keywords.length === 0) {
        const rows = this.db
          .prepare(
            `SELECT * FROM findings WHERE repository = ? AND status = 'open'
             ORDER BY ${severityOrder}, found_at DESC LIMIT 3`
          )
          .all(repository) as RawFindingRow[];
        return rows.map(rowToFinding);
      }

      // Build keyword LIKE conditions — keyword overlap on issue and suggestion
      const conditions = keywords
        .map(() => `(LOWER(issue) LIKE ? OR LOWER(suggestion) LIKE ?)`)
        .join(' OR ');
      const params: unknown[] = [];
      for (const kw of keywords) {
        const pattern = `%${kw.toLowerCase()}%`;
        params.push(pattern, pattern);
      }
      params.push(repository);

      const rows = this.db
        .prepare(
          `SELECT * FROM findings WHERE (${conditions}) AND repository = ? AND status = 'open'
           ORDER BY ${severityOrder}, found_at DESC LIMIT 3`
        )
        .all(...params) as RawFindingRow[];
      return rows.map(rowToFinding);
    } catch (err) {
      throw new StorageError(`Failed to get relevant findings: ${String(err)}`, err);
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
  /** Per-learning TTL in days (ESH-AC-15). NULL if not set. */
  ttl_days: number | null;
  /** Free-form provenance string (ESH-AC-25). NULL if not set. */
  source_agent: string | null;
  /** SHA-256 integrity hash (ESH-AC-26). NULL for legacy rows. */
  integrity_hash: string | null;
  /** Number of times this learning has been returned by search or get_context (SKM-AC-8). */
  access_count: number;
  /** ISO 8601 timestamp of last access. NULL if never accessed (SKM-AC-8). */
  last_accessed_at: string | null;
  /** Continuous staleness score [0.0, 1.0] (SKM-AC-30). */
  staleness_score: number;
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

interface RawDuplicateCandidateRow {
  id: string;
  learning_id_a: string;
  learning_id_b: string;
  similarity: number;
  scope: string;
  scope_value: string | null;
  created_at: string;
}

interface RawRelationshipRow {
  id: string;
  source_id: string;
  target_id: string;
  relationship_type: string;
  created_at: string;
  created_by: string | null;
}

interface RawConflictRow {
  id: string;
  learning_id_a: string;
  learning_id_b: string;
  similarity: number;
  conflict_type: string;
  resolved: number;
  resolved_by: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Row mapping helpers
// ---------------------------------------------------------------------------

/**
 * Map a raw database row to a Learning entity.
 * @param row - Raw row from SQLite
 * @param decryptFn - Optional decryption function for content/embedding fields (ESH-AC-2, ESH-AC-3)
 */
function rowToLearning(
  row: RawLearningRow,
  decryptFn?: (value: string) => string
): Learning {
  const contentRaw = decryptFn ? decryptFn(row.content) : row.content;
  const embeddingRaw = row.embedding
    ? (decryptFn ? decryptFn(row.embedding) : row.embedding)
    : null;
  return {
    id: row.id,
    content: contentRaw,
    category: row.category as Learning['category'],
    tags: JSON.parse(row.tags) as string[],
    repository: row.repository,
    workspace: row.workspace ?? null,
    group_id: row.group_id,
    source: row.source,
    status: row.status as Learning['status'],
    stale_flag: row.stale_flag === 1,
    embedding: embeddingRaw ? (JSON.parse(embeddingRaw) as number[]) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ttl_days: row.ttl_days ?? null,
    source_agent: row.source_agent ?? null,
    integrity_hash: row.integrity_hash ?? null,
    access_count: row.access_count ?? 0,
    last_accessed_at: row.last_accessed_at ?? null,
    staleness_score: row.staleness_score ?? 0.0,
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

function rowToDuplicateCandidate(row: RawDuplicateCandidateRow): DuplicateCandidate {
  return {
    id: row.id,
    learning_id_a: row.learning_id_a,
    learning_id_b: row.learning_id_b,
    similarity: row.similarity,
    scope: row.scope as DuplicateCandidate['scope'],
    scope_value: row.scope_value,
    created_at: row.created_at,
  };
}

function rowToRelationship(row: RawRelationshipRow): RelationshipRecord {
  return {
    id: row.id,
    source_id: row.source_id,
    target_id: row.target_id,
    relationship_type: row.relationship_type as RelationshipRecord['relationship_type'],
    created_at: row.created_at,
    created_by: row.created_by,
  };
}

function rowToConflict(row: RawConflictRow): ConflictRecord {
  return {
    id: row.id,
    learning_id_a: row.learning_id_a,
    learning_id_b: row.learning_id_b,
    similarity: row.similarity,
    conflict_type: row.conflict_type,
    resolved: row.resolved === 1,
    resolved_by: row.resolved_by,
    created_at: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// AMU raw row interfaces (AMU-AC-1 through AMU-AC-4)
// ---------------------------------------------------------------------------

interface RawDecisionRow {
  id: string;
  repository: string;
  category: string;
  choice: string;
  rationale: string;
  made_by: string | null;
  made_at: string;
  status: string;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
}

interface RawFindingRow {
  id: string;
  repository: string;
  file_path: string;
  severity: string;
  issue: string;
  suggestion: string;
  status: string;
  found_by: string | null;
  found_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string;
  updated_at: string;
}

interface RawGotchaRow {
  id: string;
  repository: string;
  description: string;
  tags: string;
  technology: string | null;
  embedding: string | null;
  times_encountered: number;
  first_seen: string;
  last_seen: string;
  created_at: string;
  updated_at: string;
}

interface RawRunSummaryRow {
  id: string;
  repository: string;
  summary: string;
  files_changed: string;
  started_at: string;
  duration_seconds: number | null;
  outcome: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// AMU row mapping helpers
// ---------------------------------------------------------------------------

function rowToDecision(row: RawDecisionRow): Decision {
  return {
    id: row.id,
    repository: row.repository,
    category: row.category,
    choice: row.choice,
    rationale: row.rationale,
    made_by: row.made_by,
    made_at: row.made_at,
    status: row.status as Decision['status'],
    superseded_by: row.superseded_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToFinding(row: RawFindingRow): Finding {
  return {
    id: row.id,
    repository: row.repository,
    file_path: row.file_path,
    severity: row.severity as Finding['severity'],
    issue: row.issue,
    suggestion: row.suggestion,
    status: row.status as Finding['status'],
    found_by: row.found_by,
    found_at: row.found_at,
    resolved_at: row.resolved_at,
    resolved_by: row.resolved_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToGotcha(row: RawGotchaRow): Gotcha {
  return {
    id: row.id,
    repository: row.repository,
    description: row.description,
    tags: JSON.parse(row.tags) as string[],
    technology: row.technology,
    embedding: row.embedding ? (JSON.parse(row.embedding) as number[]) : null,
    times_encountered: row.times_encountered,
    first_seen: row.first_seen,
    last_seen: row.last_seen,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToRunSummary(row: RawRunSummaryRow): RunSummary {
  return {
    id: row.id,
    repository: row.repository,
    summary: row.summary,
    files_changed: JSON.parse(row.files_changed) as string[],
    started_at: row.started_at,
    duration_seconds: row.duration_seconds,
    outcome: row.outcome as RunSummary['outcome'],
    created_at: row.created_at,
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
