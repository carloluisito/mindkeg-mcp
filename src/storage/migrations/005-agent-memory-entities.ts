/**
 * Migration 005: Agent Memory Entities (AMU).
 * Creates four new tables for structured agent knowledge:
 *   - decisions: architectural decisions with lifecycle tracking (AMU-AC-1)
 *   - findings: code review findings with severity and resolution (AMU-AC-2)
 *   - gotchas: non-obvious behaviors with frequency tracking (AMU-AC-3)
 *   - run_summaries: execution run history (AMU-AC-4)
 *
 * All existing tables (learnings, learnings_fts, duplicate_candidates,
 * learning_conflicts, learning_relationships, api_keys, schema_migrations)
 * are unchanged (AMU-AC-5, AMU-AC-20, AMU-AC-21).
 */

export const version = 5;
export const description =
  'Add decisions, findings, gotchas, and run_summaries tables for structured agent memory (AMU)';

/** Array of individual SQL statements to run in order (AMU-AC-27, AMU-AC-28). */
export const upStatements: string[] = [
  // decisions table (AMU-AC-1)
  `CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,
    repository TEXT NOT NULL,
    category TEXT NOT NULL,
    choice TEXT NOT NULL,
    rationale TEXT NOT NULL,
    made_by TEXT,
    made_at TEXT NOT NULL DEFAULT (datetime('now')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'reverted')),
    superseded_by TEXT REFERENCES decisions(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_decisions_repo_status ON decisions(repository, status)`,
  `CREATE INDEX IF NOT EXISTS idx_decisions_repo_category ON decisions(repository, category)`,

  // findings table (AMU-AC-2)
  `CREATE TABLE IF NOT EXISTS findings (
    id TEXT PRIMARY KEY,
    repository TEXT NOT NULL,
    file_path TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'suggestion')),
    issue TEXT NOT NULL,
    suggestion TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'wont_fix')),
    found_by TEXT,
    found_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT,
    resolved_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_findings_repo_status ON findings(repository, status)`,
  `CREATE INDEX IF NOT EXISTS idx_findings_repo_severity ON findings(repository, severity)`,

  // gotchas table (AMU-AC-3)
  // embedding stored as JSON text (float array), same pattern as learnings.embedding
  // tags stored as JSON text (array of strings), same pattern as learnings.tags
  `CREATE TABLE IF NOT EXISTS gotchas (
    id TEXT PRIMARY KEY,
    repository TEXT NOT NULL,
    description TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    technology TEXT,
    embedding TEXT,
    times_encountered INTEGER NOT NULL DEFAULT 1,
    first_seen TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_gotchas_repo ON gotchas(repository)`,
  `CREATE INDEX IF NOT EXISTS idx_gotchas_repo_tech ON gotchas(repository, technology)`,

  // run_summaries table (AMU-AC-4)
  // No decisions_made/findings_found columns per OQ-1 resolution
  // files_changed stored as JSON text (array of strings)
  `CREATE TABLE IF NOT EXISTS run_summaries (
    id TEXT PRIMARY KEY,
    repository TEXT NOT NULL,
    summary TEXT NOT NULL,
    files_changed TEXT NOT NULL DEFAULT '[]',
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    duration_seconds INTEGER,
    outcome TEXT NOT NULL DEFAULT 'success' CHECK (outcome IN ('success', 'partial', 'failed')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_run_summaries_repo ON run_summaries(repository)`,
];

/** Downgrade: DROP the new tables and indexes. */
export const downStatements: string[] = [
  `DROP INDEX IF EXISTS idx_run_summaries_repo`,
  `DROP TABLE IF EXISTS run_summaries`,
  `DROP INDEX IF EXISTS idx_gotchas_repo_tech`,
  `DROP INDEX IF EXISTS idx_gotchas_repo`,
  `DROP TABLE IF EXISTS gotchas`,
  `DROP INDEX IF EXISTS idx_findings_repo_severity`,
  `DROP INDEX IF EXISTS idx_findings_repo_status`,
  `DROP TABLE IF EXISTS findings`,
  `DROP INDEX IF EXISTS idx_decisions_repo_category`,
  `DROP INDEX IF EXISTS idx_decisions_repo_status`,
  `DROP TABLE IF EXISTS decisions`,
];
