/**
 * Integration tests for SqliteAdapter AMU methods.
 * Full CRUD cycle for decisions, findings, gotchas, run summaries.
 * Tests gotcha deduplication via findSimilarGotcha.
 * Tests getRelevantDecisions and getRelevantFindings keyword search.
 * Traces to AMU-AC-6 through AMU-AC-18, AMU-AC-30.
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

// ---------------------------------------------------------------------------
// Decisions CRUD (AMU-AC-6, AMU-AC-7, AMU-AC-8)
// ---------------------------------------------------------------------------

describe('Decisions CRUD', () => {
  it('creates and retrieves a decision (AMU-AC-6, AMU-AC-7)', async () => {
    const created = await adapter.createDecision({
      id: 'dec-1',
      repository: '/repo/test',
      category: 'database',
      choice: 'Use SQLite',
      rationale: 'Zero dependencies',
      made_by: 'architect-agent',
    });

    expect(created.id).toBe('dec-1');
    expect(created.status).toBe('active');
    expect(created.made_by).toBe('architect-agent');

    const fetched = await adapter.getDecision('dec-1');
    expect(fetched).not.toBeNull();
    expect(fetched?.choice).toBe('Use SQLite');
    expect(fetched?.category).toBe('database');
  });

  it('returns null for missing decision', async () => {
    const result = await adapter.getDecision('nonexistent-id');
    expect(result).toBeNull();
  });

  it('getDecisions returns only active decisions ordered by made_at desc (AMU-AC-7)', async () => {
    await adapter.createDecision({ id: 'dec-old', repository: '/repo/test', category: 'database', choice: 'Old choice', rationale: 'Old reason' });
    await adapter.createDecision({ id: 'dec-new', repository: '/repo/test', category: 'database', choice: 'New choice', rationale: 'New reason' });

    // Supersede dec-old
    await adapter.updateDecision('dec-old', { status: 'superseded', superseded_by: 'dec-new' });

    const decisions = await adapter.getDecisions('/repo/test');
    expect(decisions.length).toBe(1);
    expect(decisions[0]?.id).toBe('dec-new');
  });

  it('filters decisions by category (AMU-AC-7)', async () => {
    await adapter.createDecision({ id: 'dec-db', repository: '/repo/test', category: 'database', choice: 'SQLite', rationale: 'Fast' });
    await adapter.createDecision({ id: 'dec-auth', repository: '/repo/test', category: 'auth', choice: 'JWT', rationale: 'Stateless' });

    const dbDecisions = await adapter.getDecisions('/repo/test', 'database');
    expect(dbDecisions.length).toBe(1);
    expect(dbDecisions[0]?.category).toBe('database');
  });

  it('updateDecision sets status and superseded_by (AMU-AC-8)', async () => {
    await adapter.createDecision({ id: 'dec-1', repository: '/repo/test', category: 'database', choice: 'Old', rationale: 'Old reason' });
    await adapter.createDecision({ id: 'dec-2', repository: '/repo/test', category: 'database', choice: 'New', rationale: 'New reason' });

    const updated = await adapter.updateDecision('dec-1', { status: 'superseded', superseded_by: 'dec-2' });
    expect(updated?.status).toBe('superseded');
    expect(updated?.superseded_by).toBe('dec-2');
  });

  it('updateDecision returns null for missing decision', async () => {
    const result = await adapter.updateDecision('nonexistent', { status: 'reverted' });
    expect(result).toBeNull();
  });

  it('scopes decisions to repository', async () => {
    await adapter.createDecision({ id: 'dec-a', repository: '/repo/a', category: 'db', choice: 'A', rationale: 'R' });
    await adapter.createDecision({ id: 'dec-b', repository: '/repo/b', category: 'db', choice: 'B', rationale: 'R' });

    const decisionsA = await adapter.getDecisions('/repo/a');
    expect(decisionsA.every((d) => d.repository === '/repo/a')).toBe(true);
    expect(decisionsA.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Findings CRUD (AMU-AC-9, AMU-AC-10, AMU-AC-11)
// ---------------------------------------------------------------------------

describe('Findings CRUD', () => {
  it('creates and retrieves a finding (AMU-AC-9)', async () => {
    const created = await adapter.createFinding({
      id: 'finding-1',
      repository: '/repo/test',
      file_path: 'src/auth.ts',
      severity: 'critical',
      issue: 'JWT secret hardcoded',
      suggestion: 'Move to env var',
      found_by: 'reviewer',
    });

    expect(created.id).toBe('finding-1');
    expect(created.status).toBe('open');
    expect(created.found_by).toBe('reviewer');

    const fetched = await adapter.getFinding('finding-1');
    expect(fetched?.severity).toBe('critical');
    expect(fetched?.file_path).toBe('src/auth.ts');
  });

  it('returns null for missing finding', async () => {
    expect(await adapter.getFinding('nope')).toBeNull();
  });

  it('getOpenFindings returns only open findings ordered critical first (AMU-AC-11)', async () => {
    await adapter.createFinding({ id: 'f-sug', repository: '/repo/test', file_path: 'a.ts', severity: 'suggestion', issue: 'Style', suggestion: 'Fix style' });
    await adapter.createFinding({ id: 'f-crit', repository: '/repo/test', file_path: 'b.ts', severity: 'critical', issue: 'Security', suggestion: 'Fix security' });
    await adapter.createFinding({ id: 'f-warn', repository: '/repo/test', file_path: 'c.ts', severity: 'warning', issue: 'Performance', suggestion: 'Fix perf' });

    // Resolve the suggestion
    await adapter.updateFinding('f-sug', { status: 'resolved', resolved_at: new Date().toISOString() });

    const findings = await adapter.getOpenFindings('/repo/test');
    expect(findings.length).toBe(2);
    expect(findings[0]?.severity).toBe('critical');
    expect(findings[1]?.severity).toBe('warning');
  });

  it('filters findings by severity (AMU-AC-11)', async () => {
    await adapter.createFinding({ id: 'f-crit', repository: '/repo/test', file_path: 'a.ts', severity: 'critical', issue: 'X', suggestion: 'Y' });
    await adapter.createFinding({ id: 'f-warn', repository: '/repo/test', file_path: 'b.ts', severity: 'warning', issue: 'A', suggestion: 'B' });

    const critical = await adapter.getOpenFindings('/repo/test', 'critical');
    expect(critical.length).toBe(1);
    expect(critical[0]?.severity).toBe('critical');
  });

  it('updateFinding resolves a finding (AMU-AC-10)', async () => {
    await adapter.createFinding({ id: 'finding-1', repository: '/repo/test', file_path: 'src/auth.ts', severity: 'critical', issue: 'Issue', suggestion: 'Fix' });

    const now = new Date().toISOString();
    const updated = await adapter.updateFinding('finding-1', {
      status: 'resolved',
      resolved_at: now,
      resolved_by: 'developer',
    });

    expect(updated?.status).toBe('resolved');
    expect(updated?.resolved_by).toBe('developer');
    expect(updated?.resolved_at).toBe(now);
  });
});

// ---------------------------------------------------------------------------
// Gotchas CRUD + deduplication (AMU-AC-12, AMU-AC-13, AMU-AC-30)
// ---------------------------------------------------------------------------

describe('Gotchas CRUD', () => {
  it('creates and retrieves a gotcha (AMU-AC-12)', async () => {
    const created = await adapter.createGotcha({
      id: 'gotcha-1',
      repository: '/repo/test',
      description: 'node:sqlite is synchronous',
      tags: ['sqlite', 'async'],
      technology: 'sqlite',
    });

    expect(created.id).toBe('gotcha-1');
    expect(created.times_encountered).toBe(1);
    expect(created.tags).toEqual(['sqlite', 'async']);

    const fetched = await adapter.getGotcha('gotcha-1');
    expect(fetched?.description).toBe('node:sqlite is synchronous');
  });

  it('getGotchas orders by times_encountered desc (AMU-AC-13)', async () => {
    await adapter.createGotcha({ id: 'g-1', repository: '/repo/test', description: 'Rare', tags: [] });
    await adapter.createGotcha({ id: 'g-2', repository: '/repo/test', description: 'Common', tags: [] });

    // Increment g-2 twice
    await adapter.updateGotcha('g-2', { times_encountered: 3 });

    const gotchas = await adapter.getGotchas('/repo/test');
    expect(gotchas[0]?.id).toBe('g-2'); // most frequent first
    expect(gotchas[0]?.times_encountered).toBe(3);
  });

  it('filters gotchas by technology (AMU-AC-13)', async () => {
    await adapter.createGotcha({ id: 'g-sqlite', repository: '/repo/test', description: 'SQLite gotcha', tags: [], technology: 'sqlite' });
    await adapter.createGotcha({ id: 'g-react', repository: '/repo/test', description: 'React gotcha', tags: [], technology: 'react' });

    const sqliteGotchas = await adapter.getGotchas('/repo/test', 'sqlite');
    expect(sqliteGotchas.length).toBe(1);
    expect(sqliteGotchas[0]?.technology).toBe('sqlite');
  });

  it('updateGotcha increments times_encountered', async () => {
    await adapter.createGotcha({ id: 'g-1', repository: '/repo/test', description: 'Gotcha', tags: [] });
    const updated = await adapter.updateGotcha('g-1', { times_encountered: 5 });
    expect(updated?.times_encountered).toBe(5);
  });

  it('findSimilarGotcha returns matching gotcha above threshold (AMU-AC-30)', async () => {
    // Create embedding with known values
    const embeddingA = new Array(4).fill(0).map((_, i) => (i === 0 ? 1.0 : 0.0)); // [1,0,0,0]
    const embeddingB = new Array(4).fill(0).map((_, i) => (i === 0 ? 0.99 : 0.01)); // very similar

    await adapter.createGotcha({
      id: 'g-1',
      repository: '/repo/test',
      description: 'Existing gotcha',
      tags: [],
      embedding: embeddingA,
    });

    // embeddingB is very similar to embeddingA (cosine similarity > 0.85)
    const similar = await adapter.findSimilarGotcha('/repo/test', embeddingB, 0.85);
    expect(similar).not.toBeNull();
    expect(similar?.id).toBe('g-1');
  });

  it('findSimilarGotcha returns null when no embedding stored', async () => {
    await adapter.createGotcha({
      id: 'g-no-emb',
      repository: '/repo/test',
      description: 'No embedding',
      tags: [],
      embedding: null,
    });

    const queryEmbedding = new Array(4).fill(0.5);
    const similar = await adapter.findSimilarGotcha('/repo/test', queryEmbedding, 0.85);
    expect(similar).toBeNull(); // no embeddings to compare against
  });

  it('findSimilarGotcha respects repository scope', async () => {
    const embedding = new Array(4).fill(0).map((_, i) => (i === 0 ? 1.0 : 0.0));
    await adapter.createGotcha({
      id: 'g-other-repo',
      repository: '/repo/other',
      description: 'Other repo gotcha',
      tags: [],
      embedding,
    });

    // Search in /repo/test — should not find gotcha from /repo/other
    const similar = await adapter.findSimilarGotcha('/repo/test', embedding, 0.85);
    expect(similar).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Run Summaries CRUD (AMU-AC-14, AMU-AC-15)
// ---------------------------------------------------------------------------

describe('Run Summaries CRUD', () => {
  it('creates and retrieves run history (AMU-AC-14, AMU-AC-15)', async () => {
    await adapter.createRunSummary({
      id: 'run-1',
      repository: '/repo/test',
      summary: 'First run',
      files_changed: ['src/a.ts'],
      outcome: 'success',
      duration_seconds: 60,
    });
    await adapter.createRunSummary({
      id: 'run-2',
      repository: '/repo/test',
      summary: 'Second run',
      files_changed: [],
      outcome: 'partial',
    });

    const history = await adapter.getRunHistory('/repo/test', 10);
    expect(history.length).toBe(2);
    // Ordered by started_at desc — run-2 was created after run-1 in the same second
    // both should be present, we just verify the count and fields
    expect(history.some((r) => r.id === 'run-1')).toBe(true);
    expect(history.some((r) => r.id === 'run-2')).toBe(true);
  });

  it('respects limit in getRunHistory (AMU-AC-15)', async () => {
    for (let i = 0; i < 5; i++) {
      await adapter.createRunSummary({
        id: `run-${i}`,
        repository: '/repo/test',
        summary: `Run ${i}`,
        files_changed: [],
        outcome: 'success',
      });
    }

    const history = await adapter.getRunHistory('/repo/test', 3);
    expect(history.length).toBe(3);
  });

  it('stores and parses files_changed as JSON array (AMU-AC-4)', async () => {
    const files = ['src/a.ts', 'src/b.ts', 'tests/c.test.ts'];
    await adapter.createRunSummary({
      id: 'run-files',
      repository: '/repo/test',
      summary: 'Files run',
      files_changed: files,
      outcome: 'success',
    });

    const history = await adapter.getRunHistory('/repo/test', 1);
    expect(history[0]?.files_changed).toEqual(files);
  });

  it('scopes run history to repository', async () => {
    await adapter.createRunSummary({ id: 'run-a', repository: '/repo/a', summary: 'A', files_changed: [], outcome: 'success' });
    await adapter.createRunSummary({ id: 'run-b', repository: '/repo/b', summary: 'B', files_changed: [], outcome: 'success' });

    const historyA = await adapter.getRunHistory('/repo/a', 10);
    expect(historyA.every((r) => r.repository === '/repo/a')).toBe(true);
    expect(historyA.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Relevant Context queries (AMU-AC-16, AMU-AC-18)
// ---------------------------------------------------------------------------

describe('getRelevantDecisions', () => {
  it('returns decisions matching keywords in choice or rationale (AMU-AC-16, AMU-AC-18)', async () => {
    await adapter.createDecision({ id: 'd-auth', repository: '/repo/test', category: 'auth', choice: 'Use JWT for authentication', rationale: 'Stateless sessions' });
    await adapter.createDecision({ id: 'd-db', repository: '/repo/test', category: 'database', choice: 'Use SQLite', rationale: 'Zero dependencies for local storage' });

    const results = await adapter.getRelevantDecisions('/repo/test', ['authentication', 'jwt']);
    expect(results.some((d) => d.id === 'd-auth')).toBe(true);
  });

  it('returns all active decisions when keywords are empty', async () => {
    await adapter.createDecision({ id: 'd-1', repository: '/repo/test', category: 'db', choice: 'Choice A', rationale: 'Reason A' });
    await adapter.createDecision({ id: 'd-2', repository: '/repo/test', category: 'auth', choice: 'Choice B', rationale: 'Reason B' });

    const results = await adapter.getRelevantDecisions('/repo/test', []);
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it('returns at most 3 decisions (AMU-AC-17)', async () => {
    for (let i = 0; i < 5; i++) {
      await adapter.createDecision({ id: `d-${i}`, repository: '/repo/test', category: 'test', choice: `Choice ${i}`, rationale: `Reason ${i}` });
    }

    const results = await adapter.getRelevantDecisions('/repo/test', []);
    expect(results.length).toBeLessThanOrEqual(3);
  });
});

describe('getRelevantFindings', () => {
  it('returns open findings matching keywords in issue or suggestion (AMU-AC-16, AMU-AC-18)', async () => {
    await adapter.createFinding({ id: 'f-sec', repository: '/repo/test', file_path: 'src/auth.ts', severity: 'critical', issue: 'SQL injection vulnerability detected', suggestion: 'Use parameterized queries' });
    await adapter.createFinding({ id: 'f-perf', repository: '/repo/test', file_path: 'src/db.ts', severity: 'warning', issue: 'Missing database index', suggestion: 'Add index on user_id column' });

    const results = await adapter.getRelevantFindings('/repo/test', ['sql', 'injection']);
    expect(results.some((f) => f.id === 'f-sec')).toBe(true);
  });

  it('does not return resolved findings (AMU-AC-16)', async () => {
    await adapter.createFinding({ id: 'f-resolved', repository: '/repo/test', file_path: 'src/auth.ts', severity: 'critical', issue: 'Already fixed issue', suggestion: 'Done' });
    await adapter.updateFinding('f-resolved', { status: 'resolved', resolved_at: new Date().toISOString() });

    const results = await adapter.getRelevantFindings('/repo/test', ['already', 'fixed']);
    expect(results.some((f) => f.id === 'f-resolved')).toBe(false);
  });

  it('returns at most 3 findings (AMU-AC-17)', async () => {
    for (let i = 0; i < 5; i++) {
      await adapter.createFinding({ id: `f-${i}`, repository: '/repo/test', file_path: `src/file${i}.ts`, severity: 'warning', issue: `Issue ${i}`, suggestion: `Fix ${i}` });
    }

    const results = await adapter.getRelevantFindings('/repo/test', []);
    expect(results.length).toBeLessThanOrEqual(3);
  });
});
