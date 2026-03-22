/**
 * Unit tests for recordAccess (SqliteAdapter) and access tracking integration.
 * Traces to SKM-AC-9, SKM-AC-10, SKM-AC-11.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import type { CreateLearningRecord } from '../../src/storage/storage-adapter.js';

function makeRecord(overrides: Partial<CreateLearningRecord> = {}): CreateLearningRecord {
  return {
    id: randomUUID(),
    content: 'Use parameterized queries for all SQL.',
    category: 'conventions',
    tags: ['sql', 'security'],
    repository: '/repo/test',
    workspace: null,
    group_id: null,
    source: 'test-agent',
    embedding: null,
    ...overrides,
  };
}

describe('SqliteAdapter.recordAccess (SKM-AC-9, SKM-AC-10)', () => {
  let adapter: SqliteAdapter;

  beforeEach(async () => {
    adapter = new SqliteAdapter(':memory:');
    await adapter.initialize();
  });

  afterEach(async () => {
    await adapter.close();
  });

  it('is a no-op for an empty array (SKM-AC-11)', async () => {
    // Should not throw
    await expect(adapter.recordAccess([])).resolves.toBeUndefined();
  });

  it('increments access_count for a single learning', async () => {
    const record = makeRecord();
    const learning = await adapter.createLearning(record);

    expect(learning.access_count).toBe(0);
    expect(learning.last_accessed_at).toBeNull();

    await adapter.recordAccess([learning.id]);

    const updated = await adapter.getLearning(learning.id);
    expect(updated!.access_count).toBe(1);
    expect(updated!.last_accessed_at).not.toBeNull();
  });

  it('increments access_count on each call', async () => {
    const record = makeRecord();
    const learning = await adapter.createLearning(record);

    await adapter.recordAccess([learning.id]);
    await adapter.recordAccess([learning.id]);

    const updated = await adapter.getLearning(learning.id);
    expect(updated!.access_count).toBe(2);
  });

  it('batch-increments multiple learnings in one call', async () => {
    const l1 = await adapter.createLearning(makeRecord({ id: randomUUID() }));
    const l2 = await adapter.createLearning(makeRecord({ id: randomUUID() }));
    const l3 = await adapter.createLearning(makeRecord({ id: randomUUID() }));

    await adapter.recordAccess([l1.id, l2.id, l3.id]);

    const u1 = await adapter.getLearning(l1.id);
    const u2 = await adapter.getLearning(l2.id);
    const u3 = await adapter.getLearning(l3.id);

    expect(u1!.access_count).toBe(1);
    expect(u2!.access_count).toBe(1);
    expect(u3!.access_count).toBe(1);
  });

  it('silently ignores non-existent IDs — only valid IDs are updated', async () => {
    const record = makeRecord();
    const learning = await adapter.createLearning(record);

    const fakeId = randomUUID();
    await expect(adapter.recordAccess([learning.id, fakeId])).resolves.toBeUndefined();

    const updated = await adapter.getLearning(learning.id);
    expect(updated!.access_count).toBe(1);
  });

  it('returns learnings with access_count=0 and last_accessed_at=null before first access', async () => {
    const record = makeRecord();
    const learning = await adapter.createLearning(record);

    expect(learning.access_count).toBe(0);
    expect(learning.last_accessed_at).toBeNull();
  });

  it('sets last_accessed_at to a valid ISO-like datetime string after access', async () => {
    const record = makeRecord();
    const learning = await adapter.createLearning(record);

    await adapter.recordAccess([learning.id]);

    const updated = await adapter.getLearning(learning.id);
    expect(updated!.last_accessed_at).not.toBeNull();
    // SQLite datetime('now') returns "YYYY-MM-DD HH:MM:SS" format
    expect(updated!.last_accessed_at).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });
});
