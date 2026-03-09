/**
 * Unit tests for the stats command and StorageAdapter.getStats().
 * Uses an in-memory SQLite database.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import type { CreateLearningRecord } from '../../src/storage/storage-adapter.js';

function makeRecord(overrides: Partial<CreateLearningRecord> = {}): CreateLearningRecord {
  return {
    id: randomUUID(),
    content: 'Test learning content.',
    category: 'conventions',
    tags: ['test'],
    repository: null,
    workspace: null,
    group_id: null,
    source: 'test-agent',
    embedding: null,
    ...overrides,
  };
}

describe('SqliteAdapter.getStats', () => {
  let adapter: SqliteAdapter;

  beforeEach(async () => {
    adapter = new SqliteAdapter(':memory:');
    await adapter.initialize();
  });

  afterEach(async () => {
    await adapter.close();
  });

  it('returns zero counts on empty database', async () => {
    const stats = await adapter.getStats();
    expect(stats.total).toBe(0);
    expect(stats.active).toBe(0);
    expect(stats.deprecated).toBe(0);
    expect(stats.stale).toBe(0);
    expect(stats.withEmbeddings).toBe(0);
    expect(stats.byCategory).toEqual([]);
    expect(stats.byRepository).toEqual([]);
    expect(stats.byWorkspace).toEqual([]);
    expect(stats.oldestAt).toBeNull();
    expect(stats.newestAt).toBeNull();
  });

  it('counts total learnings', async () => {
    await adapter.createLearning(makeRecord());
    await adapter.createLearning(makeRecord());
    await adapter.createLearning(makeRecord());

    const stats = await adapter.getStats();
    expect(stats.total).toBe(3);
    expect(stats.active).toBe(3);
  });

  it('counts active vs deprecated', async () => {
    const l1 = await adapter.createLearning(makeRecord());
    await adapter.createLearning(makeRecord());
    await adapter.updateLearning(l1.id, { status: 'deprecated' });

    const stats = await adapter.getStats();
    expect(stats.total).toBe(2);
    expect(stats.active).toBe(1);
    expect(stats.deprecated).toBe(1);
  });

  it('counts stale-flagged learnings', async () => {
    const l1 = await adapter.createLearning(makeRecord());
    await adapter.createLearning(makeRecord());
    await adapter.updateLearning(l1.id, { stale_flag: true });

    const stats = await adapter.getStats();
    expect(stats.stale).toBe(1);
  });

  it('counts learnings with embeddings', async () => {
    await adapter.createLearning(makeRecord({ embedding: [0.1, 0.2, 0.3] }));
    await adapter.createLearning(makeRecord({ embedding: null }));

    const stats = await adapter.getStats();
    expect(stats.withEmbeddings).toBe(1);
  });

  it('breaks down by category', async () => {
    await adapter.createLearning(makeRecord({ category: 'conventions' }));
    await adapter.createLearning(makeRecord({ category: 'conventions' }));
    await adapter.createLearning(makeRecord({ category: 'gotchas' }));
    await adapter.createLearning(makeRecord({ category: 'debugging' }));

    const stats = await adapter.getStats();
    expect(stats.byCategory).toHaveLength(3);

    const conventions = stats.byCategory.find(c => c.category === 'conventions');
    expect(conventions?.count).toBe(2);

    const gotchas = stats.byCategory.find(c => c.category === 'gotchas');
    expect(gotchas?.count).toBe(1);
  });

  it('orders categories by count descending', async () => {
    await adapter.createLearning(makeRecord({ category: 'debugging' }));
    await adapter.createLearning(makeRecord({ category: 'gotchas' }));
    await adapter.createLearning(makeRecord({ category: 'gotchas' }));
    await adapter.createLearning(makeRecord({ category: 'conventions' }));
    await adapter.createLearning(makeRecord({ category: 'conventions' }));
    await adapter.createLearning(makeRecord({ category: 'conventions' }));

    const stats = await adapter.getStats();
    expect(stats.byCategory[0].category).toBe('conventions');
    expect(stats.byCategory[1].category).toBe('gotchas');
    expect(stats.byCategory[2].category).toBe('debugging');
  });

  it('breaks down by repository', async () => {
    await adapter.createLearning(makeRecord({ repository: '/repo/a' }));
    await adapter.createLearning(makeRecord({ repository: '/repo/a' }));
    await adapter.createLearning(makeRecord({ repository: '/repo/b' }));
    await adapter.createLearning(makeRecord({ repository: null }));

    const stats = await adapter.getStats();
    const repoA = stats.byRepository.find(r => r.repository === '/repo/a');
    const repoB = stats.byRepository.find(r => r.repository === '/repo/b');
    const global = stats.byRepository.find(r => r.repository === null);

    expect(repoA?.count).toBe(2);
    expect(repoB?.count).toBe(1);
    expect(global?.count).toBe(1);
  });

  it('breaks down by workspace', async () => {
    await adapter.createLearning(makeRecord({ workspace: '/ws/one/' }));
    await adapter.createLearning(makeRecord({ workspace: '/ws/one/' }));
    await adapter.createLearning(makeRecord({ workspace: '/ws/two/' }));
    await adapter.createLearning(makeRecord({ workspace: null }));

    const stats = await adapter.getStats();
    const ws1 = stats.byWorkspace.find(w => w.workspace === '/ws/one/');
    const ws2 = stats.byWorkspace.find(w => w.workspace === '/ws/two/');
    const noWs = stats.byWorkspace.find(w => w.workspace === null);

    expect(ws1?.count).toBe(2);
    expect(ws2?.count).toBe(1);
    expect(noWs?.count).toBe(1);
  });

  it('reports oldest and newest timestamps', async () => {
    await adapter.createLearning(makeRecord());
    // Small delay to ensure different timestamps
    await adapter.createLearning(makeRecord());

    const stats = await adapter.getStats();
    expect(stats.oldestAt).toBeTruthy();
    expect(stats.newestAt).toBeTruthy();
    expect(new Date(stats.oldestAt!).getTime()).toBeLessThanOrEqual(
      new Date(stats.newestAt!).getTime()
    );
  });

  it('handles mixed scenario correctly', async () => {
    // 2 active conventions in repo A
    await adapter.createLearning(makeRecord({ category: 'conventions', repository: '/repo/a' }));
    await adapter.createLearning(makeRecord({ category: 'conventions', repository: '/repo/a', embedding: [0.1] }));
    // 1 deprecated gotcha globally
    const dep = await adapter.createLearning(makeRecord({ category: 'gotchas', repository: null }));
    await adapter.updateLearning(dep.id, { status: 'deprecated' });
    // 1 stale architecture in workspace
    const stale = await adapter.createLearning(makeRecord({ category: 'architecture', workspace: '/ws/' }));
    await adapter.updateLearning(stale.id, { stale_flag: true });

    const stats = await adapter.getStats();
    expect(stats.total).toBe(4);
    expect(stats.active).toBe(3);
    expect(stats.deprecated).toBe(1);
    expect(stats.stale).toBe(1);
    expect(stats.withEmbeddings).toBe(1);
    expect(stats.byCategory).toHaveLength(3);
  });
});
