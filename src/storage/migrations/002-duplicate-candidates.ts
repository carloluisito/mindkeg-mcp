/**
 * Migration 002: duplicate_candidates table.
 * Pre-computed near-duplicate learning pairs for get_context deduplication.
 * Traces to GC-AC-24.
 *
 * Design decisions:
 * - Pairs stored with learning_id_a < learning_id_b (lexicographic) to prevent duplicate rows.
 * - ON DELETE CASCADE on FKs removes rows automatically when a learning is deleted.
 *   PRAGMA foreign_keys=ON is set in SqliteAdapter constructor.
 * - scope + scope_value record context at detection time.
 */

export const version = 2;
export const description = 'Add duplicate_candidates table for near-duplicate detection';

/** Array of individual SQL statements to run in order. */
export const upStatements: string[] = [
  `CREATE TABLE IF NOT EXISTS duplicate_candidates (
    id TEXT PRIMARY KEY,
    learning_id_a TEXT NOT NULL,
    learning_id_b TEXT NOT NULL,
    similarity REAL NOT NULL,
    scope TEXT NOT NULL,
    scope_value TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (learning_id_a) REFERENCES learnings(id) ON DELETE CASCADE,
    FOREIGN KEY (learning_id_b) REFERENCES learnings(id) ON DELETE CASCADE
  )`,

  `CREATE INDEX IF NOT EXISTS idx_dup_learning_a ON duplicate_candidates(learning_id_a)`,
  `CREATE INDEX IF NOT EXISTS idx_dup_learning_b ON duplicate_candidates(learning_id_b)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_dup_pair ON duplicate_candidates(learning_id_a, learning_id_b)`,
];

/** Array of statements to undo the migration. */
export const downStatements: string[] = [
  `DROP INDEX IF EXISTS idx_dup_pair`,
  `DROP INDEX IF EXISTS idx_dup_learning_b`,
  `DROP INDEX IF EXISTS idx_dup_learning_a`,
  `DROP TABLE IF EXISTS duplicate_candidates`,
];
