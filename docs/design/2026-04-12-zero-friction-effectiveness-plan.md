# Zero-Friction Effectiveness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make mindkeg invisible — one global `npx mindkeg-mcp init`, then persistent memory works automatically in every session.

**Architecture:** Six changes layered in phases: auth-free stdio (Phase 1), tool consolidation with aliases (Phase 2), self-describing tool descriptions (Phase 3), minimal AGENTS.md (Phase 4), auto-retrieval hook (Phase 5), and streamlined global-first init (Phase 6). Each phase is independently shippable.

**Tech Stack:** TypeScript, Zod, @modelcontextprotocol/sdk, Node.js 22, vitest, bash/PowerShell (hook scripts)

**Spec:** `docs/design/2026-04-12-zero-friction-effectiveness-design.md`

---

## Phase 1: Auth-Free Stdio Transport

### Task 1: Bypass auth for stdio sentinel key

**Files:**
- Modify: `src/auth/middleware.ts:22-45` (validateApiKey function)
- Modify: `src/tools/tool-utils.ts:19-23` (getActorFromApiKey function)
- Test: `tests/unit/auth.test.ts`

- [ ] **Step 1: Write the failing test for stdio bypass**

In `tests/unit/auth.test.ts`, add a test that verifies the `__stdio_local__` sentinel bypasses key validation:

```typescript
describe('validateApiKey', () => {
  it('should bypass validation for __stdio_local__ sentinel', async () => {
    // No need to set up a real API key in storage
    const mockStorage = {
      getApiKeyByHash: vi.fn(),
      touchApiKey: vi.fn(),
    } as unknown as StorageAdapter;

    const result = await validateApiKey('__stdio_local__', mockStorage);

    expect(result.apiKey).toEqual({
      id: 'stdio-local',
      key_hash: '',
      name: 'stdio-local',
      repositories: [],
      revoked: false,
      created_at: expect.any(String),
      last_used_at: null,
    });
    // Must NOT call storage — no DB lookup for local transport
    expect(mockStorage.getApiKeyByHash).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/auth.test.ts -t "bypass validation for __stdio_local__"`
Expected: FAIL — current `validateApiKey` does not handle the sentinel.

- [ ] **Step 3: Implement stdio bypass in validateApiKey**

In `src/auth/middleware.ts`, add the sentinel check at the top of `validateApiKey`:

```typescript
/** Sentinel value indicating stdio local transport — bypasses auth. */
export const STDIO_LOCAL_SENTINEL = '__stdio_local__';

export async function validateApiKey(
  rawKey: string | undefined,
  storage: StorageAdapter
): Promise<AuthContext> {
  // Stdio local transport: bypass all auth checks
  if (rawKey === STDIO_LOCAL_SENTINEL) {
    return {
      apiKey: {
        id: 'stdio-local',
        key_hash: '',
        name: 'stdio-local',
        repositories: [], // empty = all access
        revoked: false,
        created_at: new Date().toISOString(),
        last_used_at: null,
      },
    };
  }

  if (!rawKey || rawKey.trim() === '') {
    throw new AuthError('API key is required. Pass it via the MINDKEG_API_KEY environment variable (stdio) or Authorization: Bearer <key> header (HTTP).');
  }
  // ... rest unchanged
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/auth.test.ts -t "bypass validation for __stdio_local__"`
Expected: PASS

- [ ] **Step 5: Write test for getActorFromApiKey with sentinel**

In `tests/unit/auth.test.ts` (or a new tool-utils test file if one exists):

```typescript
describe('getActorFromApiKey', () => {
  it('should return "stdio-local" for the sentinel key', () => {
    expect(getActorFromApiKey('__stdio_local__')).toBe('stdio-local');
  });
});
```

- [ ] **Step 6: Implement getActorFromApiKey sentinel handling**

In `src/tools/tool-utils.ts`, update `getActorFromApiKey`:

```typescript
import { STDIO_LOCAL_SENTINEL } from '../auth/middleware.js';

export function getActorFromApiKey(apiKey: string | undefined): string {
  if (!apiKey) return 'stdio';
  if (apiKey === STDIO_LOCAL_SENTINEL) return 'stdio-local';
  return apiKey.slice(0, 8);
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run tests/unit/auth.test.ts`
Expected: All auth tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/auth/middleware.ts src/tools/tool-utils.ts tests/unit/auth.test.ts
git commit -m "feat: bypass auth for stdio local transport via sentinel key"
```

### Task 2: Wire stdio sentinel into startStdio

**Files:**
- Modify: `src/index.ts:122-153` (startStdio function)

- [ ] **Step 1: Update startStdio to always use the sentinel**

In `src/index.ts`, change the `startStdio` function to use the sentinel instead of `config.auth.apiKey`:

```typescript
import { STDIO_LOCAL_SENTINEL } from './auth/middleware.js';

export async function startStdio(
  config: Config,
  storage: StorageAdapter,
  embedding: EmbeddingService
): Promise<void> {
  const log = getLogger();

  const auditLogger = new AuditLogger(config.audit.destination);

  const server = createMcpServer({
    storage,
    embedding,
    getApiKey: () => STDIO_LOCAL_SENTINEL,
    auditLogger,
  });

  // Setup TTL purge on startup and periodically (ESH-AC-17)
  setupPurge(config, storage);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log.info('Mind Keg MCP server running in stdio mode');
}
```

This removes the `apiKey` variable and the warning log. Stdio always uses the sentinel — no key needed.

- [ ] **Step 2: Run the full test suite to verify nothing breaks**

Run: `npx vitest run`
Expected: All tests PASS. HTTP transport tests should be unaffected since `startHttp` still uses `config.auth.apiKey`.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire stdio sentinel into startStdio — no API key required for local use"
```

---

## Phase 2: Tool Surface Consolidation (22 → 8)

### Task 3: Create consolidated `get_context` tool

**Files:**
- Create: `src/tools/consolidated/get-context.ts`
- Test: `tests/unit/consolidated-get-context.test.ts`

- [ ] **Step 1: Write the failing test for unified get_context routing**

```typescript
// tests/unit/consolidated-get-context.test.ts
import { describe, it, expect, vi } from 'vitest';
import { routeGetContext } from '../../src/tools/consolidated/get-context.js';

describe('routeGetContext', () => {
  it('should route to session primer when only repository is provided', () => {
    const result = routeGetContext({ repository: '/repo' });
    expect(result).toBe('session_primer');
  });

  it('should route to entity context when task_description is provided', () => {
    const result = routeGetContext({ repository: '/repo', task_description: 'fix auth' });
    expect(result).toBe('entity_context');
  });

  it('should route to semantic search when query is provided', () => {
    const result = routeGetContext({ query: 'authentication patterns' });
    expect(result).toBe('semantic_search');
  });

  it('should route to entity context when both task_description and query provided', () => {
    const result = routeGetContext({
      repository: '/repo',
      task_description: 'fix auth',
      query: 'JWT tokens',
    });
    expect(result).toBe('entity_context');
  });

  it('should throw when no repository, workspace, or query provided', () => {
    expect(() => routeGetContext({})).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/consolidated-get-context.test.ts`
Expected: FAIL — module does not exist yet.

- [ ] **Step 3: Implement the routing function and consolidated tool**

Create `src/tools/consolidated/get-context.ts`:

```typescript
/**
 * Consolidated MCP tool: get_context
 * Single retrieval entry point replacing get_context, get_relevant_context, search_learnings.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LEARNING_CATEGORIES } from '../../models/learning.js';
import type { LearningService } from '../../services/learning-service.js';
import type { EntityService } from '../../services/entity-service.js';
import type { StorageAdapter } from '../../storage/storage-adapter.js';
import { isMindKegError, ValidationError } from '../../utils/errors.js';
import { authenticate } from '../../auth/middleware.js';
import type { AuditLogger } from '../../audit/audit-logger.js';
import { getActorFromApiKey, recordToolMetrics } from '../tool-utils.js';

type GetContextRoute = 'session_primer' | 'entity_context' | 'semantic_search';

export interface GetContextArgs {
  repository?: string;
  workspace?: string;
  task_description?: string;
  query?: string;
  category?: string;
  tags?: string[];
  budget?: 'compact' | 'standard' | 'full';
  limit?: number;
  include_stale?: boolean;
  include_deprecated?: boolean;
  verify_integrity?: boolean;
}

/** Determine which backend to route to based on provided parameters. */
export function routeGetContext(args: GetContextArgs): GetContextRoute {
  const hasRepo = !!args.repository;
  const hasWorkspace = !!args.workspace;
  const hasTask = !!args.task_description;
  const hasQuery = !!args.query;

  if (!hasRepo && !hasWorkspace && !hasQuery) {
    throw new ValidationError(
      'At least one of repository, workspace, or query must be provided.'
    );
  }

  // task_description triggers entity-scoped context (replaces get_relevant_context)
  if (hasTask) return 'entity_context';

  // query without task_description triggers semantic search (replaces search_learnings)
  if (hasQuery) return 'semantic_search';

  // repository/workspace only triggers session primer (replaces old get_context)
  return 'session_primer';
}

export function registerConsolidatedGetContext(
  server: McpServer,
  learningService: LearningService,
  entityService: EntityService,
  storage: StorageAdapter,
  getApiKey: () => string | undefined,
  auditLogger: AuditLogger
): void {
  server.tool(
    'get_context',
    'Retrieve relevant knowledge for your current session. Call this at the start of every session with at least the repository path. Add task_description for task-scoped context across all knowledge types (decisions, findings, gotchas, learnings, run history). Add query for semantic search on a specific topic. Returns knowledge ranked by relevance and trimmed to budget.',
    {
      repository: z.string().optional().describe('Absolute path to the repository. Required for session primer and entity context modes.'),
      workspace: z.string().optional().describe('Workspace path for scoping. Alternative to repository for workspace-level queries.'),
      task_description: z.string().optional().describe('What you are about to do (1-3 sentences). When provided, returns task-scoped context across all entity types.'),
      query: z.string().optional().describe('Semantic search query. When provided without task_description, performs a focused search.'),
      category: z.enum(LEARNING_CATEGORIES).optional().describe('Filter by category.'),
      tags: z.array(z.string()).optional().describe('Filter by tags.'),
      budget: z.enum(['compact', 'standard', 'full']).optional().describe('Character budget: compact (~2000), standard (~5000, default), full (~12000).'),
      limit: z.number().int().min(1).max(50).optional().describe('Max results for search mode (default 10, max 50).'),
      include_stale: z.boolean().optional().describe('Include stale-flagged items (default true for session primer).'),
      include_deprecated: z.boolean().optional().describe('Include deprecated items in search results (default false).'),
      verify_integrity: z.boolean().optional().default(false).describe('Check integrity hashes on returned items.'),
    },
    async (args) => {
      const actor = getActorFromApiKey(getApiKey());
      const startTime = Date.now();
      try {
        await authenticate(getApiKey(), storage, args.repository ?? null);

        const route = routeGetContext(args);

        let result: unknown;

        switch (route) {
          case 'session_primer': {
            if (!args.repository) {
              throw new ValidationError('repository is required for session primer mode (no query or task_description provided).');
            }
            result = await learningService.getContext({
              repository: args.repository,
              workspace: args.workspace,
              query: args.query,
              budget: args.budget ?? 'standard',
              include_stale: args.include_stale ?? true,
              verify_integrity: args.verify_integrity ?? false,
            });
            break;
          }
          case 'entity_context': {
            if (!args.repository) {
              throw new ValidationError('repository is required when task_description is provided.');
            }
            result = await entityService.getRelevantContext(
              args.repository,
              args.task_description!,
              args.budget ?? 'standard'
            );
            break;
          }
          case 'semantic_search': {
            result = await learningService.searchLearnings({
              query: args.query!,
              repository: args.repository ?? undefined,
              workspace: args.workspace ?? undefined,
              category: args.category,
              tags: args.tags,
              limit: args.limit ?? 10,
              includeDeprecated: args.include_deprecated ?? false,
              verifyIntegrity: args.verify_integrity ?? false,
            });
            break;
          }
        }

        auditLogger.logEntry({
          timestamp: new Date().toISOString(),
          action: 'get_context',
          actor,
          resource_id: null,
          result: 'success',
          client: { transport: 'stdio', pid: process.pid },
          metadata: { route, repository: args.repository ?? null },
        });

        recordToolMetrics('get_context', 'success', Date.now() - startTime);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          }],
        };
      } catch (err) {
        if (isMindKegError(err)) {
          recordToolMetrics('get_context', 'error', Date.now() - startTime, err.code);
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify(err.toJSON()) }],
          };
        }
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Unexpected error: ${String(err)}` }],
        };
      }
    }
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/consolidated-get-context.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/consolidated/get-context.ts tests/unit/consolidated-get-context.test.ts
git commit -m "feat: consolidated get_context tool with session primer, entity context, and search routing"
```

### Task 4: Create consolidated `store` tool

**Files:**
- Create: `src/tools/consolidated/store.ts`
- Test: `tests/unit/consolidated-store.test.ts`

- [ ] **Step 1: Write the failing test for store routing**

```typescript
// tests/unit/consolidated-store.test.ts
import { describe, it, expect } from 'vitest';
import { validateStoreInput } from '../../src/tools/consolidated/store.js';

describe('validateStoreInput', () => {
  it('should validate learning type requires content', () => {
    expect(() => validateStoreInput({ type: 'learning' })).toThrow('content is required');
  });

  it('should validate decision type requires choice and rationale', () => {
    expect(() => validateStoreInput({ type: 'decision', repository: '/r' }))
      .toThrow('choice is required');
  });

  it('should validate finding type requires issue and severity', () => {
    expect(() => validateStoreInput({ type: 'finding', repository: '/r' }))
      .toThrow('issue is required');
  });

  it('should validate gotcha type requires description', () => {
    expect(() => validateStoreInput({ type: 'gotcha', repository: '/r' }))
      .toThrow('description is required');
  });

  it('should accept valid learning input', () => {
    const result = validateStoreInput({
      type: 'learning',
      content: 'Test learning',
      category: 'gotchas',
      tags: ['test'],
    });
    expect(result.type).toBe('learning');
  });

  it('should accept valid decision input', () => {
    const result = validateStoreInput({
      type: 'decision',
      repository: '/repo',
      choice: 'Use SQLite',
      rationale: 'Simple and embedded',
      decision_category: 'database',
    });
    expect(result.type).toBe('decision');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/consolidated-store.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the consolidated store tool**

Create `src/tools/consolidated/store.ts`:

```typescript
/**
 * Consolidated MCP tool: store
 * Single storage entry point replacing store_learning, store_decision, store_finding, store_gotcha.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LEARNING_CATEGORIES } from '../../models/learning.js';
import type { LearningService } from '../../services/learning-service.js';
import type { EntityService } from '../../services/entity-service.js';
import type { StorageAdapter } from '../../storage/storage-adapter.js';
import { isMindKegError, ValidationError } from '../../utils/errors.js';
import { authenticate } from '../../auth/middleware.js';
import type { AuditLogger } from '../../audit/audit-logger.js';
import { getActorFromApiKey, recordToolMetrics } from '../tool-utils.js';

export interface StoreInput {
  type: 'learning' | 'decision' | 'finding' | 'gotcha';
  repository?: string | null;
  workspace?: string | null;
  // learning
  content?: string;
  category?: string;
  tags?: string[];
  source_agent?: string | null;
  ttl_days?: number | null;
  source?: string;
  group_id?: string | null;
  // decision
  choice?: string;
  rationale?: string;
  decision_category?: string;
  made_by?: string | null;
  // finding
  file_path?: string;
  severity?: 'critical' | 'warning' | 'suggestion';
  issue?: string;
  suggestion?: string;
  found_by?: string | null;
  // gotcha
  description?: string;
  technology?: string;
}

/** Validate store input based on type discriminator. Throws ValidationError on missing fields. */
export function validateStoreInput(input: StoreInput): StoreInput {
  switch (input.type) {
    case 'learning':
      if (!input.content) throw new ValidationError('content is required for type=learning');
      break;
    case 'decision':
      if (!input.choice) throw new ValidationError('choice is required for type=decision');
      if (!input.rationale) throw new ValidationError('rationale is required for type=decision');
      if (!input.repository) throw new ValidationError('repository is required for type=decision');
      break;
    case 'finding':
      if (!input.issue) throw new ValidationError('issue is required for type=finding');
      if (!input.severity) throw new ValidationError('severity is required for type=finding');
      if (!input.repository) throw new ValidationError('repository is required for type=finding');
      break;
    case 'gotcha':
      if (!input.description) throw new ValidationError('description is required for type=gotcha');
      if (!input.repository) throw new ValidationError('repository is required for type=gotcha');
      break;
  }
  return input;
}

export function registerConsolidatedStore(
  server: McpServer,
  learningService: LearningService,
  entityService: EntityService,
  storage: StorageAdapter,
  getApiKey: () => string | undefined,
  auditLogger: AuditLogger
): void {
  server.tool(
    'store',
    'Save a piece of knowledge. Types: learning (short insight, max 500 chars), decision (architectural choice with rationale), finding (code review issue), gotcha (non-obvious behavior). Before calling this, ask the user if they want to save it and which scope — this repo, workspace, or global.',
    {
      type: z.enum(['learning', 'decision', 'finding', 'gotcha']).describe('Type of knowledge to store.'),
      repository: z.string().optional().nullable().describe('Repository path. Required for decision, finding, gotcha. Optional for learning (omit for global).'),
      workspace: z.string().optional().nullable().describe('Workspace path. Mutually exclusive with repository. For workspace-scoped learnings.'),
      // learning fields
      content: z.string().min(1).max(500).optional().describe('Learning text (type=learning). Max 500 chars.'),
      category: z.enum(LEARNING_CATEGORIES).optional().nullable().describe('Category (type=learning). Omit for auto-categorization.'),
      tags: z.array(z.string()).optional().describe('Tags for organization.'),
      source_agent: z.string().optional().nullable().describe('Agent name for provenance.'),
      ttl_days: z.number().int().positive().optional().nullable().describe('Time-to-live in days (type=learning).'),
      source: z.string().optional().describe('Who created this (type=learning). Defaults to "agent".'),
      group_id: z.string().uuid().optional().nullable().describe('Group UUID to link related learnings (type=learning).'),
      // decision fields
      choice: z.string().min(1).max(1000).optional().describe('What was decided (type=decision). Max 1000 chars.'),
      rationale: z.string().min(1).max(2000).optional().describe('Why this choice was made (type=decision). Max 2000 chars.'),
      decision_category: z.string().min(1).optional().describe('Decision category, e.g. "database", "auth" (type=decision).'),
      made_by: z.string().optional().nullable().describe('Who made this decision (type=decision).'),
      // finding fields
      file_path: z.string().optional().describe('File path where the issue was found (type=finding).'),
      severity: z.enum(['critical', 'warning', 'suggestion']).optional().describe('Issue severity (type=finding).'),
      issue: z.string().min(1).max(1000).optional().describe('What the issue is (type=finding). Max 1000 chars.'),
      suggestion: z.string().max(1000).optional().describe('How to fix it (type=finding). Max 1000 chars.'),
      found_by: z.string().optional().nullable().describe('Who found this (type=finding).'),
      // gotcha fields
      description: z.string().optional().describe('The non-obvious behavior (type=gotcha).'),
      technology: z.string().optional().describe('Technology this relates to (type=gotcha).'),
    },
    async (args) => {
      const actor = getActorFromApiKey(getApiKey());
      const startTime = Date.now();
      try {
        await authenticate(getApiKey(), storage, args.repository ?? null);

        validateStoreInput(args as StoreInput);

        let result: unknown;

        switch (args.type) {
          case 'learning': {
            const { learning, auto_categorized, conflicts } = await learningService.storeLearning({
              content: args.content!,
              category: args.category ?? null,
              tags: args.tags,
              repository: args.repository ?? null,
              workspace: args.workspace ?? null,
              group_id: args.group_id ?? null,
              source: args.source,
              source_agent: args.source_agent ?? null,
              ttl_days: args.ttl_days ?? null,
            });
            result = {
              success: true,
              type: 'learning',
              learning: {
                id: learning.id,
                content: learning.content,
                category: learning.category,
                tags: learning.tags,
                repository: learning.repository,
                workspace: learning.workspace,
                status: learning.status,
                created_at: learning.created_at,
              },
              auto_categorized,
              conflicts: conflicts.map((c) => ({
                conflict_id: c.id,
                conflicting_learning_id: c.learning_id_a === learning.id ? c.learning_id_b : c.learning_id_a,
                similarity: c.similarity,
                conflict_type: c.conflict_type,
              })),
            };
            break;
          }
          case 'decision': {
            const decision = await entityService.storeDecision({
              repository: args.repository!,
              category: args.decision_category!,
              choice: args.choice!,
              rationale: args.rationale!,
              made_by: args.made_by ?? null,
            });
            result = { success: true, type: 'decision', decision };
            break;
          }
          case 'finding': {
            const finding = await entityService.storeFinding({
              repository: args.repository!,
              file_path: args.file_path ?? '',
              severity: args.severity!,
              issue: args.issue!,
              suggestion: args.suggestion ?? '',
              found_by: args.found_by ?? null,
            });
            result = { success: true, type: 'finding', finding };
            break;
          }
          case 'gotcha': {
            const gotchaResult = await entityService.storeGotcha({
              repository: args.repository!,
              description: args.description!,
              tags: args.tags ?? [],
              technology: args.technology ?? null,
            });
            result = { success: true, type: 'gotcha', ...gotchaResult };
            break;
          }
        }

        auditLogger.logEntry({
          timestamp: new Date().toISOString(),
          action: 'store',
          actor,
          resource_id: null,
          result: 'success',
          client: { transport: 'stdio', pid: process.pid },
          metadata: { type: args.type, repository: args.repository ?? null },
        });

        recordToolMetrics('store', 'success', Date.now() - startTime);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        if (isMindKegError(err)) {
          recordToolMetrics('store', 'error', Date.now() - startTime, err.code);
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify(err.toJSON()) }],
          };
        }
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Unexpected error: ${String(err)}` }],
        };
      }
    }
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/consolidated-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/consolidated/store.ts tests/unit/consolidated-store.test.ts
git commit -m "feat: consolidated store tool with type discriminator for learning/decision/finding/gotcha"
```

### Task 5: Create consolidated `update`, `resolve`, `query`, `list_scopes` tools

**Files:**
- Create: `src/tools/consolidated/update.ts`
- Create: `src/tools/consolidated/resolve.ts`
- Create: `src/tools/consolidated/query.ts`
- Create: `src/tools/consolidated/list-scopes.ts`
- Test: `tests/unit/consolidated-update.test.ts`
- Test: `tests/unit/consolidated-resolve.test.ts`
- Test: `tests/unit/consolidated-query.test.ts`
- Test: `tests/unit/consolidated-list-scopes.test.ts`

- [ ] **Step 1: Write failing test for update routing**

```typescript
// tests/unit/consolidated-update.test.ts
import { describe, it, expect } from 'vitest';
import { validateUpdateInput } from '../../src/tools/consolidated/update.js';

describe('validateUpdateInput', () => {
  it('should require id for all actions', () => {
    expect(() => validateUpdateInput({ action: 'update' } as any)).toThrow();
  });

  it('should require duplicate_ids for merge action', () => {
    expect(() => validateUpdateInput({
      action: 'merge',
      id: '550e8400-e29b-41d4-a716-446655440000',
    })).toThrow('duplicate_ids is required');
  });

  it('should accept valid update input', () => {
    const result = validateUpdateInput({
      action: 'update',
      id: '550e8400-e29b-41d4-a716-446655440000',
      content: 'Updated content',
    });
    expect(result.action).toBe('update');
  });

  it('should accept valid deprecate input', () => {
    const result = validateUpdateInput({
      action: 'deprecate',
      id: '550e8400-e29b-41d4-a716-446655440000',
      reason: 'Outdated',
    });
    expect(result.action).toBe('deprecate');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/consolidated-update.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement consolidated update tool**

Create `src/tools/consolidated/update.ts`. The `update` tool dispatches to `learningService.updateLearning`, `learningService.deprecateLearning`, `learningService.flagStale`, `learningService.deleteLearning`, or the merge logic based on the `action` discriminator. Follow the same pattern as `store.ts` — validate input, authenticate, dispatch, format response.

The `validateUpdateInput` function checks:
- `action` is one of `update`, `deprecate`, `flag_stale`, `delete`, `merge`
- `id` is always required (UUID)
- `merge` action additionally requires `duplicate_ids` (array of UUIDs)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/consolidated-update.test.ts`
Expected: PASS

- [ ] **Step 5: Implement consolidated resolve tool**

Create `src/tools/consolidated/resolve.ts`. Dispatches to `entityService.supersedeDecision` for `type=decision` and `entityService.resolveFinding` for `type=finding`.

- [ ] **Step 6: Implement consolidated query tool**

Create `src/tools/consolidated/query.ts`. Dispatches to `entityService.getDecisions`, `entityService.getOpenFindings`, `entityService.getGotchas`, `entityService.getRunHistory` based on `type`.

- [ ] **Step 7: Implement consolidated list_scopes tool**

Create `src/tools/consolidated/list-scopes.ts`. Calls both `learningService.listRepositories()` and `learningService.listWorkspaces()`, returns combined result.

- [ ] **Step 8: Write tests for resolve, query, and list_scopes**

Create `tests/unit/consolidated-resolve.test.ts`, `tests/unit/consolidated-query.test.ts`, `tests/unit/consolidated-list-scopes.test.ts` with input validation tests.

- [ ] **Step 9: Run all consolidated tests**

Run: `npx vitest run tests/unit/consolidated-`
Expected: All PASS

- [ ] **Step 10: Commit**

```bash
git add src/tools/consolidated/ tests/unit/consolidated-*
git commit -m "feat: consolidated update, resolve, query, list_scopes tools"
```

### Task 6: Wire consolidated tools into server.ts and register aliases

**Files:**
- Modify: `src/server.ts`
- Create: `src/tools/consolidated/aliases.ts`
- Test: `tests/integration/consolidated-tools.test.ts`

- [ ] **Step 1: Create alias registration module**

Create `src/tools/consolidated/aliases.ts` that registers all 22 old tool names as thin wrappers. Each alias internally calls the corresponding consolidated tool's service methods and adds a `_deprecated: true` field plus a `_deprecation_notice` string in the response metadata.

```typescript
/**
 * Backwards-compatibility aliases for the legacy 22-tool surface.
 * Each alias delegates to the same service methods as the consolidated tools.
 * All aliases include a deprecation notice in response metadata.
 * These will be removed in the next major version.
 */
```

Each alias registers via `server.tool(oldName, oldDescription, oldSchema, handler)` where the handler delegates to the service layer directly (not through the consolidated tool).

- [ ] **Step 2: Update server.ts to register consolidated tools + aliases**

Replace the 22 individual tool registrations with:

```typescript
// Register 8 consolidated tools
registerConsolidatedGetContext(server, learningService, entityService, storage, deps.getApiKey, auditLogger);
registerConsolidatedStore(server, learningService, entityService, storage, deps.getApiKey, auditLogger);
registerConsolidatedUpdate(server, learningService, storage, deps.getApiKey, auditLogger);
registerConsolidatedResolve(server, entityService);
registerConsolidatedQuery(server, entityService, storage, deps.getApiKey);
registerConsolidatedListScopes(server, learningService, auditLogger);
registerRelate(server, storage, deps.getApiKey, auditLogger); // unchanged, just re-exported
registerCompleteRun(server, entityService, storage, deps.getApiKey); // unchanged

// Register backwards-compatibility aliases (deprecated — removed in next major)
registerAliases(server, learningService, entityService, storage, deps.getApiKey, auditLogger);
```

- [ ] **Step 3: Write integration test verifying both consolidated and alias tool names work**

```typescript
// tests/integration/consolidated-tools.test.ts
// Test that:
// 1. Consolidated tool names are registered
// 2. Legacy alias tool names are registered
// 3. Both route to the same underlying service methods
```

- [ ] **Step 4: Run the full test suite**

Run: `npx vitest run`
Expected: All tests PASS. Existing integration tests that call old tool names should continue to work via aliases.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/tools/consolidated/ tests/integration/consolidated-tools.test.ts
git commit -m "feat: wire consolidated tools into server with backwards-compatible aliases"
```

---

## Phase 3: Self-Describing Tool Descriptions

This is already handled in the consolidated tool implementations (Tasks 3-6). The descriptions are embedded in the `server.tool()` calls in each consolidated tool file. No separate task needed — verify the descriptions match the spec during the Phase 2 implementation.

---

## Phase 4: Minimal AGENTS.md Template

### Task 7: Replace AGENTS.md template

**Files:**
- Modify: `templates/AGENTS.md`
- Modify: `tests/unit/init.test.ts` (if it checks AGENTS.md content)

- [ ] **Step 1: Replace templates/AGENTS.md with the minimal version**

Replace the entire contents of `templates/AGENTS.md` with the ~40-line behavioral contract from the spec:

```markdown
# Mind Keg -- Agent Instructions

You have persistent memory via Mind Keg. Follow these rules:

## Session Start

Call `get_context` with the current repository path to load prior knowledge.
If you know what task you're working on, include `task_description` for
task-scoped results.

## During Work

When you discover something non-obvious -- a gotcha, an architectural decision,
a debugging insight, a code review finding -- ask the user before storing:

> "I found that [X]. Want me to save this to Mind Keg?
> Should it apply to: this repo / this workspace / globally?"

Wait for the user's answer, then call `store` with the chosen scope and
appropriate type (learning, decision, finding, or gotcha).

## Session End

If you made significant discoveries during the session, summarize them and
offer to store any the user wants to keep.

If you completed a significant task (implementation, refactor, debugging
session), call `complete_run` with a summary.

## Rules

- Always ask before storing. Never store silently.
- Deprecate wrong knowledge instead of deleting it.
- Flag knowledge as stale when you suspect it's outdated but aren't sure.
- Use short, focused queries (1-3 keywords) when searching.
```

- [ ] **Step 2: Update init.test.ts if it validates AGENTS.md content**

Check if `tests/unit/init.test.ts` asserts specific content from the old template. Update assertions to match the new template (e.g., check for "Mind Keg -- Agent Instructions" header).

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/unit/init.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add templates/AGENTS.md tests/unit/init.test.ts
git commit -m "feat: minimal AGENTS.md template — 40-line behavioral contract replaces 487-line reference"
```

---

## Phase 5: Auto-Retrieval Hook (Claude Code)

### Task 8: Create hook script generator

**Files:**
- Create: `src/hooks/generate-hook.ts`
- Test: `tests/unit/generate-hook.test.ts`

- [ ] **Step 1: Write failing test for hook script generation**

```typescript
// tests/unit/generate-hook.test.ts
import { describe, it, expect } from 'vitest';
import { generateBashHook, generatePowerShellHook } from '../../src/hooks/generate-hook.js';

describe('generateBashHook', () => {
  it('should produce a valid bash script', () => {
    const script = generateBashHook();
    expect(script).toContain('#!/bin/bash');
    expect(script).toContain('git rev-parse --show-toplevel');
    expect(script).toContain('exit 0');
    // Must use node to call mindkeg directly, not spawn an MCP server
    expect(script).toContain('node');
    expect(script).not.toContain('serve --stdio');
  });

  it('should always exit 0 even on failure', () => {
    const script = generateBashHook();
    // The script must have error trapping that exits 0
    expect(script).toContain('exit 0');
  });
});

describe('generatePowerShellHook', () => {
  it('should produce a valid PowerShell script', () => {
    const script = generatePowerShellHook();
    expect(script).toContain('try');
    expect(script).toContain('catch');
    expect(script).toContain('exit 0');
    expect(script).toContain('git rev-parse --show-toplevel');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/generate-hook.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement hook script generators**

Create `src/hooks/generate-hook.ts`:

```typescript
/**
 * Hook script generators for auto-retrieval at session start.
 * Generated scripts are self-contained — they import mindkeg's storage
 * and learning service directly (no MCP protocol overhead).
 */

/**
 * Generate a bash hook script for Claude Code SessionStart.
 * The script:
 * 1. Detects the repo path via git
 * 2. Runs a Node.js one-liner that imports mindkeg and calls getContext
 * 3. Prints context to stdout (injected into conversation by Claude Code)
 * 4. Exits 0 unconditionally
 */
export function generateBashHook(): string {
  return `#!/bin/bash
# Mind Keg — SessionStart auto-retrieval hook
# Generated by: npx mindkeg-mcp init
# This script loads persistent memory at the start of every Claude Code session.

REPO_PATH=$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")

node --experimental-sqlite -e "
  (async () => {
    try {
      const { loadConfig } = await import('mindkeg-mcp/config');
      const { createStorageAdapter } = await import('mindkeg-mcp/storage');
      const { createEmbeddingService } = await import('mindkeg-mcp/services');
      const { LearningService } = await import('mindkeg-mcp/services');

      const config = loadConfig();
      const storage = createStorageAdapter(config);
      await storage.initialize();
      const embedding = createEmbeddingService(config);
      const svc = new LearningService(storage, embedding);

      const ctx = await svc.getContext({
        repository: process.env.MINDKEG_REPO,
        budget: 'compact',
        include_stale: false,
        verify_integrity: false,
      });

      const lines = [];
      const repos = ctx.repo_learnings || [];
      const ws = ctx.workspace_learnings || [];
      const globals = ctx.global_learnings || [];
      const total = repos.length + ws.length + globals.length;

      if (total === 0) {
        process.exit(0);
      }

      lines.push('=== Mind Keg: Persistent Memory ===');
      lines.push('');

      if (repos.length > 0) {
        lines.push('Repo learnings:');
        for (const l of repos) {
          lines.push('  - [' + l.category + '] ' + l.content);
        }
        lines.push('');
      }
      if (ws.length > 0) {
        lines.push('Workspace learnings:');
        for (const l of ws) {
          lines.push('  - [' + l.category + '] ' + l.content);
        }
        lines.push('');
      }
      if (globals.length > 0) {
        lines.push('Global learnings:');
        for (const l of globals) {
          lines.push('  - [' + l.category + '] ' + l.content);
        }
        lines.push('');
      }
      lines.push('Use get_context for full details or store to save new knowledge.');
      console.log(lines.join('\\n'));
    } catch (e) {
      // Silent failure — never block session startup
    }
  })();
" 2>/dev/null

exit 0
`;
}

/**
 * Generate a PowerShell hook script for Windows Claude Code SessionStart.
 */
export function generatePowerShellHook(): string {
  return `# Mind Keg — SessionStart auto-retrieval hook
# Generated by: npx mindkeg-mcp init

try {
    $repoPath = git rev-parse --show-toplevel 2>$null
    if (-not $repoPath) { $repoPath = $PWD.Path }

    $env:MINDKEG_REPO = $repoPath

    node --experimental-sqlite -e "
      (async () => {
        try {
          const { loadConfig } = await import('mindkeg-mcp/config');
          const { createStorageAdapter } = await import('mindkeg-mcp/storage');
          const { createEmbeddingService, LearningService } = await import('mindkeg-mcp/services');

          const config = loadConfig();
          const storage = createStorageAdapter(config);
          await storage.initialize();
          const embedding = createEmbeddingService(config);
          const svc = new LearningService(storage, embedding);

          const ctx = await svc.getContext({
            repository: process.env.MINDKEG_REPO,
            budget: 'compact',
            include_stale: false,
            verify_integrity: false,
          });

          const repos = ctx.repo_learnings || [];
          const ws = ctx.workspace_learnings || [];
          const globals = ctx.global_learnings || [];
          const total = repos.length + ws.length + globals.length;
          if (total === 0) process.exit(0);

          const lines = ['=== Mind Keg: Persistent Memory ===', ''];
          for (const [label, arr] of [['Repo', repos], ['Workspace', ws], ['Global', globals]]) {
            if (arr.length > 0) {
              lines.push(label + ' learnings:');
              for (const l of arr) lines.push('  - [' + l.category + '] ' + l.content);
              lines.push('');
            }
          }
          lines.push('Use get_context for full details or store to save new knowledge.');
          console.log(lines.join('\\n'));
        } catch (e) { /* silent */ }
      })();
    " 2>$null
} catch {
    # Silent failure
}

exit 0
`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/generate-hook.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/hooks/generate-hook.ts tests/unit/generate-hook.test.ts
git commit -m "feat: hook script generators for Claude Code SessionStart auto-retrieval"
```

---

## Phase 6: Streamlined Global-First `init`

### Task 9: Refactor init command for global-first setup

**Files:**
- Modify: `cli/commands/init.ts`
- Test: `tests/unit/init.test.ts`

- [ ] **Step 1: Write failing test for global init behavior**

```typescript
// Add to tests/unit/init.test.ts
describe('global init', () => {
  it('should write MCP config to global location by default', () => {
    // Mock homedir, existsSync, writeFileSync
    // Call the global init logic
    // Assert config is written to ~/.claude.json (not project .claude/mcp.json)
  });

  it('should not include MINDKEG_API_KEY in env block', () => {
    // Assert the generated MCP config env block does not contain MINDKEG_API_KEY
  });

  it('should generate hook script for claude-code', () => {
    // Assert .claude/hooks/load-mindkeg.sh is created in the global claude dir
  });

  it('should merge SessionStart hook into existing settings.json', () => {
    // Provide an existing settings.json with other hooks
    // Assert the mindkeg SessionStart hook is added without removing existing hooks
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/init.test.ts -t "global init"`
Expected: FAIL

- [ ] **Step 3: Refactor init.ts for global-first behavior**

Key changes to `cli/commands/init.ts`:

1. Add `--project` flag. Default behavior (no `--project`) does global setup.
2. Change `AGENT_CONFIGS` to have both global and project config paths:
   ```typescript
   'claude-code': {
     globalConfigFile: '~/.claude.json',  // global MCP config
     projectConfigFile: '.claude/mcp.json', // project override
     globalHookDir: '~/.claude/hooks',
     globalSettingsFile: '~/.claude/settings.json',
     ...
   }
   ```
3. Global init: writes to `globalConfigFile`, generates hook in `globalHookDir`, merges hook into `globalSettingsFile`.
4. Project init (`--project`): writes to `projectConfigFile`, appends AGENTS.md to CLAUDE.md (existing behavior).
5. Remove `MINDKEG_API_KEY` from the `mcpEntry` env block.
6. Add `runMigrations()` step that imports storage factory and calls `storage.initialize()`.
7. Add hook generation step using `generateBashHook()` / `generatePowerShellHook()` from `src/hooks/generate-hook.ts`.
8. Add settings.json merge logic that preserves existing hooks.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/init.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add cli/commands/init.ts tests/unit/init.test.ts
git commit -m "feat: global-first init — one-time setup, no API key, auto-retrieval hook"
```

---

## Phase 7: Final Integration & Cleanup

### Task 10: End-to-end validation and documentation

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `AGENTS.md` (root)

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All PASS

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: No errors (or only pre-existing warnings)

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 5: Update README.md Quick Start section**

Replace the current Quick Start with:

```markdown
## Quick Start

```bash
npx mindkeg-mcp init
```

That's it. This installs Mind Keg globally for your AI agent (Claude Code, Cursor, Windsurf). Open any project and your agent has persistent memory.

For Claude Code, a SessionStart hook is also installed — your agent loads prior knowledge automatically at the start of every session.

**Options:**

```bash
npx mindkeg-mcp init --agent cursor    # Target a specific agent
npx mindkeg-mcp init --project         # Per-project setup instead of global
```
```

- [ ] **Step 6: Update CLAUDE.md tool list and version**

Update the tool count, tool table, and version references in CLAUDE.md to reflect the 8 consolidated tools + aliases.

- [ ] **Step 7: Commit**

```bash
git add README.md CLAUDE.md AGENTS.md
git commit -m "docs: update README, CLAUDE.md, AGENTS.md for zero-friction v0.7.0"
```

- [ ] **Step 8: Run preflight checks one final time**

Run: `npm run typecheck && npm run lint && npx vitest run && npm run build`
Expected: All pass clean.
