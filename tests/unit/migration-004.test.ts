/**
 * Unit tests for migration 004: Smarter Knowledge Management columns and tables.
 * Tests:
 * - Migration metadata (version, description)
 * - upStatements list correctness
 * - SQL statement structure (tables, columns, indexes)
 * Traces to SKM-AC-8, SKM-AC-25, SKM-AC-30, SKM-AC-38.
 */
import { describe, it, expect } from 'vitest';
import {
  version,
  description,
  upStatements,
  downStatements,
} from '../../src/storage/migrations/004-smarter-knowledge-management.js';

describe('Migration 004: metadata', () => {
  it('has version 4 (SKM-AC-8)', () => {
    expect(version).toBe(4);
  });

  it('has a non-empty description', () => {
    expect(description).toBeTruthy();
    expect(typeof description).toBe('string');
  });

  it('has upStatements array', () => {
    expect(Array.isArray(upStatements)).toBe(true);
    expect(upStatements.length).toBeGreaterThan(0);
  });

  it('has downStatements array', () => {
    expect(Array.isArray(downStatements)).toBe(true);
  });
});

describe('Migration 004: upStatements — learnings column additions', () => {
  it('adds access_count column with NOT NULL DEFAULT 0 (SKM-AC-8)', () => {
    const stmt = upStatements.find(
      (s) => s.includes('access_count') && s.includes('ALTER TABLE learnings')
    );
    expect(stmt).toBeTruthy();
    expect(stmt).toContain('INTEGER');
    expect(stmt).toContain('NOT NULL');
    expect(stmt).toContain('DEFAULT 0');
  });

  it('adds last_accessed_at column with DEFAULT NULL (SKM-AC-8)', () => {
    const stmt = upStatements.find(
      (s) => s.includes('last_accessed_at') && s.includes('ALTER TABLE learnings')
    );
    expect(stmt).toBeTruthy();
    expect(stmt).toContain('TEXT');
    expect(stmt).toContain('DEFAULT NULL');
  });

  it('adds staleness_score column with NOT NULL DEFAULT 0.0 (SKM-AC-30)', () => {
    const stmt = upStatements.find(
      (s) => s.includes('staleness_score') && s.includes('ALTER TABLE learnings')
    );
    expect(stmt).toBeTruthy();
    expect(stmt).toContain('REAL');
    expect(stmt).toContain('NOT NULL');
    expect(stmt).toContain('DEFAULT 0.0');
  });
});

describe('Migration 004: upStatements — learning_conflicts table (SKM-AC-25)', () => {
  const conflictTableStmt = upStatements.find(
    (s) => s.includes('CREATE TABLE') && s.includes('learning_conflicts')
  );

  it('creates learning_conflicts table', () => {
    expect(conflictTableStmt).toBeTruthy();
  });

  it('has id TEXT PRIMARY KEY', () => {
    expect(conflictTableStmt).toContain('id TEXT PRIMARY KEY');
  });

  it('has learning_id_a and learning_id_b TEXT NOT NULL', () => {
    expect(conflictTableStmt).toContain('learning_id_a TEXT NOT NULL');
    expect(conflictTableStmt).toContain('learning_id_b TEXT NOT NULL');
  });

  it('has similarity REAL NOT NULL', () => {
    expect(conflictTableStmt).toContain('similarity REAL NOT NULL');
  });

  it('has conflict_type with default keyword_heuristic', () => {
    expect(conflictTableStmt).toContain("DEFAULT 'keyword_heuristic'");
  });

  it('has resolved INTEGER NOT NULL DEFAULT 0', () => {
    expect(conflictTableStmt).toContain('resolved INTEGER NOT NULL DEFAULT 0');
  });

  it('has resolved_by TEXT DEFAULT NULL', () => {
    expect(conflictTableStmt).toContain('resolved_by TEXT DEFAULT NULL');
  });

  it('has created_at with default datetime now', () => {
    expect(conflictTableStmt).toContain("DEFAULT (datetime('now'))");
  });

  it('has ON DELETE CASCADE for both FKs', () => {
    const cascadeCount = (conflictTableStmt?.match(/ON DELETE CASCADE/g) ?? []).length;
    expect(cascadeCount).toBe(2);
  });

  it('creates idx_conflict_a index on learning_id_a', () => {
    const idxStmt = upStatements.find((s) => s.includes('idx_conflict_a'));
    expect(idxStmt).toBeTruthy();
    expect(idxStmt).toContain('learning_id_a');
  });

  it('creates idx_conflict_b index on learning_id_b', () => {
    const idxStmt = upStatements.find((s) => s.includes('idx_conflict_b'));
    expect(idxStmt).toBeTruthy();
    expect(idxStmt).toContain('learning_id_b');
  });

  it('creates unique idx_conflict_pair index on (learning_id_a, learning_id_b, conflict_type)', () => {
    const idxStmt = upStatements.find((s) => s.includes('idx_conflict_pair'));
    expect(idxStmt).toBeTruthy();
    expect(idxStmt).toContain('UNIQUE');
    expect(idxStmt).toContain('learning_id_a');
    expect(idxStmt).toContain('learning_id_b');
    expect(idxStmt).toContain('conflict_type');
  });
});

describe('Migration 004: upStatements — learning_relationships table (SKM-AC-38)', () => {
  const relTableStmt = upStatements.find(
    (s) => s.includes('CREATE TABLE') && s.includes('learning_relationships')
  );

  it('creates learning_relationships table', () => {
    expect(relTableStmt).toBeTruthy();
  });

  it('has id TEXT PRIMARY KEY', () => {
    expect(relTableStmt).toContain('id TEXT PRIMARY KEY');
  });

  it('has source_id and target_id TEXT NOT NULL', () => {
    expect(relTableStmt).toContain('source_id TEXT NOT NULL');
    expect(relTableStmt).toContain('target_id TEXT NOT NULL');
  });

  it('has relationship_type TEXT NOT NULL', () => {
    expect(relTableStmt).toContain('relationship_type TEXT NOT NULL');
  });

  it('has created_at with default datetime now', () => {
    expect(relTableStmt).toContain("DEFAULT (datetime('now'))");
  });

  it('has created_by TEXT DEFAULT NULL', () => {
    expect(relTableStmt).toContain('created_by TEXT DEFAULT NULL');
  });

  it('has ON DELETE CASCADE for both FKs', () => {
    const cascadeCount = (relTableStmt?.match(/ON DELETE CASCADE/g) ?? []).length;
    expect(cascadeCount).toBe(2);
  });

  it('creates idx_rel_source index on source_id', () => {
    const idxStmt = upStatements.find((s) => s.includes('idx_rel_source'));
    expect(idxStmt).toBeTruthy();
    expect(idxStmt).toContain('source_id');
  });

  it('creates idx_rel_target index on target_id', () => {
    const idxStmt = upStatements.find((s) => s.includes('idx_rel_target'));
    expect(idxStmt).toBeTruthy();
    expect(idxStmt).toContain('target_id');
  });

  it('creates unique idx_rel_pair_type index on (source_id, target_id, relationship_type)', () => {
    const idxStmt = upStatements.find((s) => s.includes('idx_rel_pair_type'));
    expect(idxStmt).toBeTruthy();
    expect(idxStmt).toContain('UNIQUE');
    expect(idxStmt).toContain('source_id');
    expect(idxStmt).toContain('target_id');
    expect(idxStmt).toContain('relationship_type');
  });
});

describe('Migration 004: downStatements', () => {
  it('drops learning_relationships table', () => {
    const stmt = downStatements.find((s) => s.includes('learning_relationships'));
    expect(stmt).toBeTruthy();
  });

  it('drops learning_conflicts table', () => {
    const stmt = downStatements.find((s) => s.includes('learning_conflicts'));
    expect(stmt).toBeTruthy();
  });

  it('drops all four relationship indexes', () => {
    const relIdxes = ['idx_rel_pair_type', 'idx_rel_target', 'idx_rel_source'];
    for (const idx of relIdxes) {
      const stmt = downStatements.find((s) => s.includes(idx));
      expect(stmt).toBeTruthy();
    }
  });

  it('drops all three conflict indexes', () => {
    const conflictIdxes = ['idx_conflict_pair', 'idx_conflict_b', 'idx_conflict_a'];
    for (const idx of conflictIdxes) {
      const stmt = downStatements.find((s) => s.includes(idx));
      expect(stmt).toBeTruthy();
    }
  });
});
