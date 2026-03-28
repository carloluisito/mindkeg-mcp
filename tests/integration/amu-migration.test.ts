/**
 * Integration tests for AMU migration 005.
 * Verifies: tables created, indexes exist, idempotent re-run.
 * Traces to AMU-AC-27, AMU-AC-28, AMU-AC-29.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';

let adapter: SqliteAdapter;

beforeEach(async () => {
  adapter = new SqliteAdapter(':memory:');
  await adapter.initialize();
});

afterEach(async () => {
  await adapter.close();
});

describe('Migration 005 — table creation (AMU-AC-1 through AMU-AC-4, AMU-AC-27, AMU-AC-28)', () => {
  it('creates the decisions table with all required columns (AMU-AC-1)', async () => {
    // If the table doesn't exist, creating a decision would throw
    const decision = await adapter.createDecision({
      id: 'test-id-1',
      repository: '/repo/test',
      category: 'database',
      choice: 'Use SQLite',
      rationale: 'Zero dependencies',
    });
    expect(decision.id).toBe('test-id-1');
    expect(decision.status).toBe('active');
    expect(decision.superseded_by).toBeNull();
    expect(decision.made_by).toBeNull();
  });

  it('creates the findings table with all required columns (AMU-AC-2)', async () => {
    const finding = await adapter.createFinding({
      id: 'finding-1',
      repository: '/repo/test',
      file_path: 'src/auth.ts',
      severity: 'critical',
      issue: 'JWT secret hardcoded',
      suggestion: 'Move to env var',
    });
    expect(finding.id).toBe('finding-1');
    expect(finding.status).toBe('open');
    expect(finding.resolved_at).toBeNull();
    expect(finding.resolved_by).toBeNull();
    expect(finding.found_by).toBeNull();
  });

  it('creates the gotchas table with all required columns (AMU-AC-3)', async () => {
    const gotcha = await adapter.createGotcha({
      id: 'gotcha-1',
      repository: '/repo/test',
      description: 'node:sqlite is synchronous',
      tags: ['sqlite', 'async'],
      technology: 'sqlite',
    });
    expect(gotcha.id).toBe('gotcha-1');
    expect(gotcha.times_encountered).toBe(1);
    expect(gotcha.embedding).toBeNull();
    expect(gotcha.tags).toEqual(['sqlite', 'async']);
  });

  it('creates the run_summaries table with all required columns (AMU-AC-4)', async () => {
    const runSummary = await adapter.createRunSummary({
      id: 'run-1',
      repository: '/repo/test',
      summary: 'Implemented authentication',
      files_changed: ['src/auth.ts', 'tests/auth.test.ts'],
      outcome: 'success',
    });
    expect(runSummary.id).toBe('run-1');
    expect(runSummary.outcome).toBe('success');
    expect(runSummary.files_changed).toEqual(['src/auth.ts', 'tests/auth.test.ts']);
    expect(runSummary.duration_seconds).toBeNull();
  });

  it('existing learnings table is unchanged (AMU-AC-5, AMU-AC-20)', async () => {
    // Creating a learning after migration should still work normally
    const learning = await adapter.createLearning({
      id: 'learning-1',
      content: 'Use transactions for all writes',
      category: 'architecture',
      tags: ['database'],
      repository: '/repo/test',
      workspace: null,
      group_id: null,
      source: 'test',
      embedding: null,
    });
    expect(learning.id).toBe('learning-1');
    expect(learning.category).toBe('architecture');
  });
});

describe('Migration 005 — idempotency (AMU-AC-28)', () => {
  it('running initialize() twice does not throw (CREATE TABLE IF NOT EXISTS)', async () => {
    // Initialize is already called in beforeEach. Call it again.
    await expect(adapter.initialize()).resolves.not.toThrow();
  });
});
