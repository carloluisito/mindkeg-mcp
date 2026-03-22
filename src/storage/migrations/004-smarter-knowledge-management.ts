/**
 * Migration 004: Smarter Knowledge Management (SKM).
 * Adds access tracking columns, staleness score, conflict detection table,
 * and learning relationships table.
 *
 * New columns on learnings (all non-destructive — safe for 0.4.x → 0.5.0 upgrade):
 *   - access_count INTEGER NOT NULL DEFAULT 0 (SKM-AC-8)
 *   - last_accessed_at TEXT DEFAULT NULL (SKM-AC-8)
 *   - staleness_score REAL NOT NULL DEFAULT 0.0 (SKM-AC-30)
 *
 * New tables:
 *   - learning_conflicts: keyword-heuristic contradiction pairs (SKM-AC-25)
 *   - learning_relationships: typed edges between learnings (SKM-AC-38)
 */

export const version = 4;
export const description =
  'Add access_count, last_accessed_at, staleness_score columns; add learning_conflicts and learning_relationships tables';

/** Array of individual SQL statements to run in order. */
export const upStatements: string[] = [
  // Access tracking columns (SKM-AC-8)
  `ALTER TABLE learnings ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE learnings ADD COLUMN last_accessed_at TEXT DEFAULT NULL`,

  // Smart staleness score column (SKM-AC-30)
  `ALTER TABLE learnings ADD COLUMN staleness_score REAL NOT NULL DEFAULT 0.0`,

  // Conflict detection table (SKM-AC-25)
  // Pairs stored with learning_id_a < learning_id_b (lexicographic) to prevent duplicate rows.
  // ON DELETE CASCADE removes rows automatically when a learning is deleted.
  `CREATE TABLE IF NOT EXISTS learning_conflicts (
    id TEXT PRIMARY KEY,
    learning_id_a TEXT NOT NULL,
    learning_id_b TEXT NOT NULL,
    similarity REAL NOT NULL,
    conflict_type TEXT NOT NULL DEFAULT 'keyword_heuristic',
    resolved INTEGER NOT NULL DEFAULT 0,
    resolved_by TEXT DEFAULT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (learning_id_a) REFERENCES learnings(id) ON DELETE CASCADE,
    FOREIGN KEY (learning_id_b) REFERENCES learnings(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_conflict_a ON learning_conflicts(learning_id_a)`,
  `CREATE INDEX IF NOT EXISTS idx_conflict_b ON learning_conflicts(learning_id_b)`,
  // Unique index on pair + conflict_type allows future ML-based detection to coexist with
  // keyword_heuristic conflicts between the same pair.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_conflict_pair ON learning_conflicts(learning_id_a, learning_id_b, conflict_type)`,

  // Learning relationships table (SKM-AC-38)
  // ON DELETE CASCADE removes relationships when either referenced learning is deleted.
  `CREATE TABLE IF NOT EXISTS learning_relationships (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    relationship_type TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by TEXT DEFAULT NULL,
    FOREIGN KEY (source_id) REFERENCES learnings(id) ON DELETE CASCADE,
    FOREIGN KEY (target_id) REFERENCES learnings(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rel_source ON learning_relationships(source_id)`,
  `CREATE INDEX IF NOT EXISTS idx_rel_target ON learning_relationships(target_id)`,
  // Unique index prevents duplicate (source, target, type) triples.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_rel_pair_type ON learning_relationships(source_id, target_id, relationship_type)`,
];

/** Downgrade: DROP the new tables and indexes. ALTER TABLE ADD COLUMN cannot be reversed in SQLite. */
export const downStatements: string[] = [
  `DROP INDEX IF EXISTS idx_rel_pair_type`,
  `DROP INDEX IF EXISTS idx_rel_target`,
  `DROP INDEX IF EXISTS idx_rel_source`,
  `DROP TABLE IF EXISTS learning_relationships`,
  `DROP INDEX IF EXISTS idx_conflict_pair`,
  `DROP INDEX IF EXISTS idx_conflict_b`,
  `DROP INDEX IF EXISTS idx_conflict_a`,
  `DROP TABLE IF EXISTS learning_conflicts`,
  // Note: ALTER TABLE DROP COLUMN is not supported in older SQLite versions.
  // The access_count, last_accessed_at, and staleness_score columns cannot be removed.
];
