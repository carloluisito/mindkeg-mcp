/**
 * End-to-end test: full lifecycle with SQLite backend.
 * Tests the complete path: storage → service → auth → tools.
 * Traces to AC-1 through AC-5, AC-8, AC-9, AC-20 through AC-24, AC-29, AC-30.
 *
 * This test does NOT start an HTTP server or stdio process.
 * It tests the business logic chain directly, which is the "minimum viable demo" path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { NoneEmbeddingService } from '../../src/services/embedding-service.js';
import { LearningService } from '../../src/services/learning-service.js';
import { generateApiKey, hashApiKey, extractKeyPrefix } from '../../src/auth/api-key.js';
import { validateApiKey, checkRepositoryAccess } from '../../src/auth/middleware.js';
import { ValidationError, NotFoundError, AuthError, AccessError } from '../../src/utils/errors.js';

const REPO_PATH = '/home/user/my-project';
const GLOBAL = null;

describe('E2E: Full SQLite Lifecycle', () => {
  let storage: SqliteAdapter;
  let service: LearningService;
  let apiKey: string;

  beforeEach(async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();

    const embedding = new NoneEmbeddingService();
    service = new LearningService(storage, embedding);

    // Create an API key for auth tests
    apiKey = generateApiKey();
    await storage.createApiKey({
      id: randomUUID(),
      name: 'E2E Test Key',
      key_hash: hashApiKey(apiKey),
      key_prefix: extractKeyPrefix(apiKey),
      repositories: [],
    });
  });

  afterEach(async () => {
    await storage.close();
  });

  // -------------------------------------------------------------------------
  // Authentication flow (AC-20, AC-21, AC-22, AC-23)
  // -------------------------------------------------------------------------

  it('validates a correct API key (AC-21)', async () => {
    const ctx = await validateApiKey(apiKey, storage);
    expect(ctx.apiKey.name).toBe('E2E Test Key');
    expect(ctx.apiKey.revoked).toBe(false);
  });

  it('rejects a missing API key (AC-23)', async () => {
    await expect(validateApiKey(undefined, storage)).rejects.toThrow(AuthError);
  });

  it('rejects a wrong API key (AC-23)', async () => {
    const wrongKey = generateApiKey();
    await expect(validateApiKey(wrongKey, storage)).rejects.toThrow(AuthError);
  });

  it('rejects a revoked API key (AC-21, AC-23)', async () => {
    const prefix = extractKeyPrefix(apiKey);
    await storage.revokeApiKey(prefix);
    await expect(validateApiKey(apiKey, storage)).rejects.toThrow(AuthError);
  });

  it('enforces repository access control for restricted keys (AC-22)', async () => {
    // Create a key restricted to /repo/a only
    const restrictedKey = generateApiKey();
    await storage.createApiKey({
      id: randomUUID(),
      name: 'Restricted Key',
      key_hash: hashApiKey(restrictedKey),
      key_prefix: extractKeyPrefix(restrictedKey),
      repositories: ['/repo/a'],
    });

    const ctx = await validateApiKey(restrictedKey, storage);

    // Allowed: the permitted repo
    expect(() => checkRepositoryAccess(ctx, '/repo/a')).not.toThrow();

    // Allowed: global learnings are always accessible
    expect(() => checkRepositoryAccess(ctx, null)).not.toThrow();

    // Denied: a different repo
    expect(() => checkRepositoryAccess(ctx, '/repo/forbidden')).toThrow(AccessError);
  });

  // -------------------------------------------------------------------------
  // Store → Search → Update → Deprecate → Delete lifecycle (AC-1 through AC-5)
  // -------------------------------------------------------------------------

  it('full learning lifecycle: store, search, update, deprecate, delete', async () => {
    // 1. Store a learning (AC-1)
    const { learning } = await service.storeLearning({
      content: 'Always use database transactions for multi-step writes.',
      category: 'architecture',
      tags: ['database', 'transactions'],
      repository: REPO_PATH,
      source: 'e2e-test',
    });

    expect(learning.id).toBeTruthy();
    expect(learning.content).toBe('Always use database transactions for multi-step writes.');
    expect(learning.status).toBe('active');
    expect(learning.created_at).toBeTruthy();
    expect(learning.updated_at).toBeTruthy();
    expect(learning.source).toBe('e2e-test');

    // 2. Search and find the learning (AC-9 FTS fallback, AC-12)
    const searchResults = await service.searchLearnings({
      query: 'database transactions',
      repository: REPO_PATH,
    });

    expect(searchResults.length).toBeGreaterThanOrEqual(1);
    const found = searchResults.find((r) => r.id === learning.id);
    expect(found).toBeDefined();
    expect(typeof found!.score).toBe('number');

    // 3. Search also returns global learnings when filtering by repo (AC-8)
    const { learning: globalLearning } = await service.storeLearning({
      content: 'Universal tip: use strict TypeScript mode.',
      category: 'conventions',
      repository: GLOBAL,
      source: 'e2e-test',
    });

    const repoSearch = await service.searchLearnings({
      query: 'Universal',
      repository: REPO_PATH,
    });
    const globalFound = repoSearch.find((r) => r.id === globalLearning.id);
    expect(globalFound).toBeDefined();

    // 4. Update the learning (AC-3)
    const updated = await service.updateLearning({
      id: learning.id,
      content: 'Use DB transactions for ALL multi-step writes — including reads that precede writes.',
      tags: ['database', 'transactions', 'consistency'],
    });

    expect(updated.content).toContain('ALL multi-step writes');
    expect(updated.tags).toContain('consistency');

    // 5. Deprecate the learning (AC-4)
    const deprecated = await service.deprecateLearning({
      id: learning.id,
      reason: 'Superseded by more specific guidance.',
    });
    expect(deprecated.status).toBe('deprecated');

    // 6. Verify deprecated learning is excluded from search by default (AC-4, AC-29)
    const activeOnlySearch = await service.searchLearnings({
      query: 'database transactions',
      repository: REPO_PATH,
    });
    const foundDeprecated = activeOnlySearch.find((r) => r.id === learning.id);
    expect(foundDeprecated).toBeUndefined();

    // 7. Verify deprecated learning IS included when flag is set (AC-29)
    const allSearch = await service.searchLearnings({
      query: 'database transactions',
      repository: REPO_PATH,
      include_deprecated: true,
    });
    const foundWithFlag = allSearch.find((r) => r.id === learning.id);
    expect(foundWithFlag).toBeDefined();

    // 8. Delete the learning permanently (AC-5)
    const deleteResult = await service.deleteLearning({ id: learning.id });
    expect(deleteResult.success).toBe(true);

    // Verify it's gone
    const afterDelete = await storage.getLearning(learning.id);
    expect(afterDelete).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Repository scoping (AC-7, AC-8)
  // -------------------------------------------------------------------------

  it('repo-scoped search includes global learnings (AC-8)', async () => {
    const { learning: repoLearning } = await service.storeLearning({
      content: 'Repo-specific: use Prisma for DB access.',
      category: 'architecture',
      repository: REPO_PATH,
    });
    const { learning: globalLearning } = await service.storeLearning({
      content: 'Global: prefer composition over inheritance.',
      category: 'architecture',
      repository: null,
    });

    // FTS5 searches match on individual words — search for "Prisma" (in repo learning)
    const repoResults = await service.searchLearnings({
      query: 'Prisma',
      repository: REPO_PATH,
    });
    const repoIds = repoResults.map((r) => r.id);
    expect(repoIds).toContain(repoLearning.id);

    // Search for "composition" (in global learning) while filtering by REPO_PATH — should still find global
    const globalResults = await service.searchLearnings({
      query: 'composition',
      repository: REPO_PATH,
    });
    const globalIds = globalResults.map((r) => r.id);
    expect(globalIds).toContain(globalLearning.id);
  });

  it('global learning appears in REPO_PATH search even if content is specific', async () => {
    const { learning: globalLearning } = await service.storeLearning({
      content: 'Zygomorphic pattern applies universally across all repos.',
      category: 'conventions',
      repository: null, // global
    });

    // When searching in REPO_PATH with a query that matches the global learning
    const results = await service.searchLearnings({
      query: 'Zygomorphic',
      repository: REPO_PATH,
    });
    // Global learning should appear regardless of repo filter (AC-8)
    const found = results.find((r) => r.id === globalLearning.id);
    expect(found).toBeDefined();
    expect(found!.repository).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Stale flagging (AC-30)
  // -------------------------------------------------------------------------

  it('can flag a learning as stale (AC-30)', async () => {
    const { learning } = await service.storeLearning({
      content: 'Use version X of the API.',
      category: 'dependencies',
      repository: REPO_PATH,
    });

    expect(learning.stale_flag).toBe(false);

    const flagged = await service.flagStale({ id: learning.id });
    expect(flagged.stale_flag).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Validation boundaries (AC-6, AC-13)
  // -------------------------------------------------------------------------

  it('rejects content exceeding 500 characters (AC-6)', async () => {
    await expect(
      service.storeLearning({
        content: 'a'.repeat(501),
        category: 'conventions',
      })
    ).rejects.toThrow(ValidationError);
  });

  it('rejects invalid category (AC-13)', async () => {
    await expect(
      service.storeLearning({
        content: 'Valid content.',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        category: 'invalid-category' as any,
      })
    ).rejects.toThrow(ValidationError);
  });

  it('throws NotFoundError when updating non-existent learning', async () => {
    await expect(
      service.updateLearning({ id: randomUUID() })
    ).rejects.toThrow(NotFoundError);
  });

  it('throws NotFoundError when deleting non-existent learning (AC-5)', async () => {
    await expect(
      service.deleteLearning({ id: randomUUID() })
    ).rejects.toThrow(NotFoundError);
  });

  // -------------------------------------------------------------------------
  // listRepositories (AC-16)
  // -------------------------------------------------------------------------

  it('lists repositories with learning counts', async () => {
    await service.storeLearning({ content: 'A.', category: 'conventions', repository: '/repo/a' });
    await service.storeLearning({ content: 'B.', category: 'conventions', repository: '/repo/a' });
    await service.storeLearning({ content: 'C.', category: 'conventions', repository: '/repo/b' });
    await service.storeLearning({ content: 'D.', category: 'conventions', repository: null });

    const repos = await service.listRepositories();

    const repoA = repos.find((r) => r.path === '/repo/a');
    expect(repoA?.learning_count).toBe(2);

    const repoB = repos.find((r) => r.path === '/repo/b');
    expect(repoB?.learning_count).toBe(1);

    const global = repos.find((r) => r.path === null);
    expect(global?.learning_count).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Category and tag filtering (AC-10, AC-13, AC-14)
  // -------------------------------------------------------------------------

  it('filters search by category (AC-10)', async () => {
    await service.storeLearning({
      content: 'Architecture learning: use hexagonal.',
      category: 'architecture',
      repository: REPO_PATH,
    });
    await service.storeLearning({
      content: 'Debugging learning: check logs first.',
      category: 'debugging',
      repository: REPO_PATH,
    });

    const results = await service.searchLearnings({
      query: 'learning',
      repository: REPO_PATH,
      category: 'debugging',
    });

    expect(results.every((r) => r.category === 'debugging')).toBe(true);
  });

  it('filters search by tags (AC-10, AC-14)', async () => {
    await service.storeLearning({
      content: 'Zod validation tip.',
      category: 'conventions',
      tags: ['zod', 'validation'],
      repository: REPO_PATH,
    });
    await service.storeLearning({
      content: 'Prisma ORM tip.',
      category: 'dependencies',
      tags: ['prisma', 'orm'],
      repository: REPO_PATH,
    });

    const results = await service.searchLearnings({
      query: 'tip',
      repository: REPO_PATH,
      tags: ['zod'],
    });

    expect(results.every((r) => r.tags.includes('zod'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Search limit (AC-11)
  // -------------------------------------------------------------------------

  it('respects the limit parameter (AC-11)', async () => {
    for (let i = 0; i < 15; i++) {
      await service.storeLearning({
        content: `Learning ${i}: use consistent patterns.`,
        category: 'conventions',
        repository: REPO_PATH,
      });
    }

    const results = await service.searchLearnings({
      query: 'consistent patterns',
      repository: REPO_PATH,
      limit: 5,
    });

    expect(results.length).toBeLessThanOrEqual(5);
  });

  // -------------------------------------------------------------------------
  // Workspace scoping (WS-AC-12, WS-AC-14, WS-AC-22, WS-AC-23, WS-AC-24)
  // -------------------------------------------------------------------------

  it('full three-scope search: repo + workspace + global all returned (WS-AC-12, WS-AC-14, WS-AC-22)', async () => {
    const WORKSPACE = '/home/user/';
    const WS_REPO = '/home/user/my-project';

    // Store repo-specific learning
    const { learning: repoLearning } = await service.storeLearning({
      content: 'Repo learning: use strict null checks.',
      category: 'conventions',
      repository: WS_REPO,
    });

    // Store workspace-scoped learning
    const { learning: wsLearning } = await service.storeLearning({
      content: 'Workspace learning: all services share auth module.',
      category: 'architecture',
      workspace: WORKSPACE,
    });

    // Store global learning
    const { learning: globalLearning } = await service.storeLearning({
      content: 'Global learning: prefer immutable data structures.',
      category: 'conventions',
      repository: null,
    });

    // Search from WS_REPO — should return all three (WS-AC-12)
    const results = await service.searchLearnings({
      query: 'learning',
      repository: WS_REPO,
    });

    const ids = results.map((r) => r.id);
    expect(ids).toContain(repoLearning.id);
    expect(ids).toContain(wsLearning.id);
    expect(ids).toContain(globalLearning.id);

    // Verify scope annotation (WS-AC-14)
    const repoResult = results.find((r) => r.id === repoLearning.id);
    expect(repoResult?.scope).toBe('repo');

    const wsResult = results.find((r) => r.id === wsLearning.id);
    expect(wsResult?.scope).toBe('workspace');

    const globalResult = results.find((r) => r.id === globalLearning.id);
    expect(globalResult?.scope).toBe('global');
  });

  it('workspace learnings do not appear in search from a different workspace (WS-AC-23)', async () => {
    const WS_A = '/home/user/repos/personal/';

    const { learning: wsALearning } = await service.storeLearning({
      content: 'Personal workspace: use hobby project conventions.',
      category: 'conventions',
      workspace: WS_A,
    });

    // Search from a repo in workspace B — should NOT see workspace A's learning
    const results = await service.searchLearnings({
      query: 'Personal workspace hobby',
      repository: '/home/user/repos/work/api-service',
    });

    const ids = results.map((r) => r.id);
    expect(ids).not.toContain(wsALearning.id);
  });

  it('validates mutual exclusivity: cannot set both repository and workspace (WS-AC-10, WS-AC-24)', async () => {
    await expect(
      service.storeLearning({
        content: 'Invalid: both scopes.',
        category: 'conventions',
        repository: '/home/user/repos/personal/my-app',
        workspace: '/home/user/repos/personal/',
      })
    ).rejects.toThrow(ValidationError);
  });

  it('global-only search returns only global learnings (WS-AC-15)', async () => {
    await service.storeLearning({
      content: 'Repo-specific learning.',
      category: 'conventions',
      repository: REPO_PATH,
    });
    await service.storeLearning({
      content: 'Workspace learning.',
      category: 'conventions',
      workspace: '/home/user/',
    });
    const { learning: globalLearning } = await service.storeLearning({
      content: 'Global: always write tests.',
      category: 'conventions',
      repository: null,
    });

    // Search without repository — global only (WS-AC-15)
    const results = await service.searchLearnings({
      query: 'always write tests',
    });

    const ids = results.map((r) => r.id);
    expect(ids).toContain(globalLearning.id);
    // Should not include repo or workspace learnings
    expect(results.every((r) => r.scope === 'global')).toBe(true);
  });

  it('listWorkspaces returns correct counts (WS-AC-16)', async () => {
    const WS = '/home/user/repos/personal/';
    await service.storeLearning({
      content: 'Workspace learning A.',
      category: 'conventions',
      workspace: WS,
    });
    await service.storeLearning({
      content: 'Workspace learning B.',
      category: 'conventions',
      workspace: WS,
    });

    const workspaces = await service.listWorkspaces();
    const ws = workspaces.find((w) => w.workspace === WS);
    expect(ws).toBeDefined();
    expect(ws?.learning_count).toBe(2);
  });
});
