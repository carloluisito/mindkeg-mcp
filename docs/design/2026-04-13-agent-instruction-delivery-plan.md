# Agent Instruction Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver mindkeg's behavioral contract to every MCP client via the server `instructions` field, with reinforcing updates to `store` and `update` tool descriptions.

**Architecture:** Three small, focused changes: (1) add `instructions` to `McpServer` constructor in `src/server.ts`, (2) refine the `store` tool description, (3) refine the `update` tool description. No data model or behavior changes beyond this.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, vitest.

**Spec:** `docs/design/2026-04-13-agent-instruction-delivery-design.md`

---

## File Structure

**Files modified:**
- `src/server.ts` — Add `instructions` to `McpServer` constructor options, exported as a named constant for testability.
- `src/tools/consolidated/store.ts` — Update tool description string.
- `src/tools/consolidated/update.ts` — Update tool description string.

**Files created:**
- `tests/unit/server-instructions.test.ts` — Verify `createMcpServer` produces a server with the `instructions` field set to the expected text.

**Files unchanged:**
- Hook scripts, hook generator, init command, AGENTS.md template.
- All service, storage, model files.

---

## Task 1: Define and export the server instructions constant

**Files:**
- Modify: `src/server.ts` (add exported constant + use it in `McpServer` constructor)
- Test: `tests/unit/server-instructions.test.ts` (new file)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/server-instructions.test.ts`:

```typescript
/**
 * Unit tests for MCP server instructions — the behavioral contract
 * delivered to every MCP client at handshake.
 */
import { describe, it, expect } from 'vitest';
import { MINDKEG_SERVER_INSTRUCTIONS } from '../../src/server.js';

describe('MINDKEG_SERVER_INSTRUCTIONS', () => {
  it('is a non-empty string', () => {
    expect(typeof MINDKEG_SERVER_INSTRUCTIONS).toBe('string');
    expect(MINDKEG_SERVER_INSTRUCTIONS.length).toBeGreaterThan(100);
  });

  it('mentions proactive storage pattern', () => {
    expect(MINDKEG_SERVER_INSTRUCTIONS).toMatch(/proactively|Proactively/);
    expect(MINDKEG_SERVER_INSTRUCTIONS).toContain('ask the user');
  });

  it('mentions all four storage types', () => {
    expect(MINDKEG_SERVER_INSTRUCTIONS).toContain('gotcha');
    expect(MINDKEG_SERVER_INSTRUCTIONS).toContain('decision');
    expect(MINDKEG_SERVER_INSTRUCTIONS).toContain('finding');
    expect(MINDKEG_SERVER_INSTRUCTIONS).toContain('learning');
  });

  it('mentions scope question (repo / workspace / global)', () => {
    expect(MINDKEG_SERVER_INSTRUCTIONS).toContain('repo');
    expect(MINDKEG_SERVER_INSTRUCTIONS).toContain('workspace');
    expect(MINDKEG_SERVER_INSTRUCTIONS).toContain('global');
  });

  it('mentions retrieval at session start', () => {
    expect(MINDKEG_SERVER_INSTRUCTIONS).toContain('get_context');
    expect(MINDKEG_SERVER_INSTRUCTIONS).toMatch(/session start|SessionStart/);
  });

  it('mentions the never-store-silently rule', () => {
    expect(MINDKEG_SERVER_INSTRUCTIONS).toMatch(/never store silently|Never store silently/i);
  });

  it('mentions deprecate vs flag_stale distinction', () => {
    expect(MINDKEG_SERVER_INSTRUCTIONS).toContain('deprecate');
    expect(MINDKEG_SERVER_INSTRUCTIONS).toContain('flag_stale');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/server-instructions.test.ts`
Expected: FAIL — `MINDKEG_SERVER_INSTRUCTIONS` is not exported from `src/server.js`.

- [ ] **Step 3: Add the exported constant to `src/server.ts`**

Open `src/server.ts`. After the imports block and before `export interface ServerDependencies` (around line 52), add:

```typescript
/**
 * MCP server instructions — the behavioral contract delivered to every MCP client
 * at handshake (via the `initialize` response's `instructions` field).
 *
 * This is the primary delivery mechanism for mindkeg's proactive storage workflow.
 * It reaches every MCP-compliant client (Claude Code, Cursor, Windsurf, Codex, Gemini CLI)
 * once per connection, regardless of hook or resource support.
 *
 * Traces to: docs/design/2026-04-13-agent-instruction-delivery-design.md Section 1.
 */
export const MINDKEG_SERVER_INSTRUCTIONS = `You have access to Mind Keg — a persistent memory system for knowledge that survives across sessions. Use it to retrieve prior context and proactively preserve new insights.

# When to retrieve

At session start, call \`get_context({ repository: "<current repo path>" })\` to load prior knowledge. If the SessionStart hook already injected context (visible as "Mind Keg Persistent Memory" at the top of the conversation), skip this — the context is already loaded.

For topic-specific lookups mid-session, call \`get_context({ query: "<topic>", repository: "<path>" })\`.

# When to store (proactively offer)

When you discover something non-obvious during work, pause and offer to save it:

> "I noticed [X]. This looks like a [gotcha/decision/finding]. Want me to save it to Mind Keg?
>  Scope: this repo, this workspace, or globally?"

Wait for the user's answer before calling \`store\`.

Watch for these patterns specifically:

- **Gotchas** — non-obvious behaviors, footguns, surprising library quirks → \`store({ type: "gotcha", ... })\`
- **Architectural decisions** with rationale → \`store({ type: "decision", ... })\`
- **Code review findings** that need tracking across sessions → \`store({ type: "finding", ... })\`
- **Short factual insights** (conventions, debugging tips, compact observations) → \`store({ type: "learning", ... })\`

# Rules

- Always ask before storing. Never store silently.
- Don't store transient session state, obvious facts, or codebase-specific details that change as code evolves (file paths, function locations). Those belong in project-level memory, not Mind Keg.
- Prefer \`update({ action: "deprecate" })\` over delete for wrong knowledge — preserves audit trail.
- Use \`update({ action: "flag_stale" })\` when you suspect something is outdated but aren't sure.
- For scope, default suggestion when asking the user: this repo unless the insight clearly applies cross-project.
- At session end, if you made multiple discoveries, summarize them and offer to save the ones the user wants to keep.`;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/server-instructions.test.ts`
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/unit/server-instructions.test.ts
git commit -m "feat: add MINDKEG_SERVER_INSTRUCTIONS exported constant"
```

---

## Task 2: Wire instructions into McpServer constructor

**Files:**
- Modify: `src/server.ts` lines 71-82 (the `McpServer` constructor call)
- Test: `tests/unit/server-instructions.test.ts` (extend with createMcpServer test)

- [ ] **Step 1: Extend the test with a createMcpServer assertion**

Append to `tests/unit/server-instructions.test.ts`:

```typescript
import { createMcpServer } from '../../src/server.js';
import type { StorageAdapter } from '../../src/storage/storage-adapter.js';
import type { EmbeddingService } from '../../src/services/embedding-service.js';

describe('createMcpServer with instructions', () => {
  it('passes MINDKEG_SERVER_INSTRUCTIONS to the McpServer', () => {
    // Minimal mocks — we only need the shape, not real behavior
    const mockStorage = {} as StorageAdapter;
    const mockEmbedding = {} as EmbeddingService;

    const server = createMcpServer({
      storage: mockStorage,
      embedding: mockEmbedding,
      getApiKey: () => undefined,
    });

    // The McpServer stores instructions on an internal Server instance.
    // Access via the private `_instructions` field on the underlying server.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internal = (server as any).server as { _instructions?: string };
    expect(internal._instructions).toBe(MINDKEG_SERVER_INSTRUCTIONS);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/server-instructions.test.ts -t "passes MINDKEG_SERVER_INSTRUCTIONS"`
Expected: FAIL — `_instructions` is currently `undefined` because the constructor doesn't pass it.

- [ ] **Step 3: Update the McpServer constructor call**

In `src/server.ts`, find the `createMcpServer` function (line ~71). Change this block:

```typescript
const server = new McpServer(
  {
    name: 'mindkeg-mcp',
    version: '0.7.1',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);
```

To:

```typescript
const server = new McpServer(
  {
    name: 'mindkeg-mcp',
    version: '0.7.1',
  },
  {
    capabilities: {
      tools: {},
    },
    instructions: MINDKEG_SERVER_INSTRUCTIONS,
  }
);
```

(Only the addition of the `instructions:` line inside the second options object.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/server-instructions.test.ts`
Expected: PASS — all tests green.

- [ ] **Step 5: Run the full suite to verify no regressions**

Run: `npx vitest run`
Expected: all tests pass (858+ tests). No existing behavior changed.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts tests/unit/server-instructions.test.ts
git commit -m "feat: wire MINDKEG_SERVER_INSTRUCTIONS into McpServer initialize handshake"
```

---

## Task 3: Refine the `store` tool description

**Files:**
- Modify: `src/tools/consolidated/store.ts` line 114 (tool description string)
- Test: `tests/unit/consolidated-store.test.ts` (extend with description check)

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/consolidated-store.test.ts` (or create a new describe block if one doesn't already exist for descriptions):

```typescript
describe('store tool description', () => {
  // Capture the description by spying on server.tool calls during registration
  it('contains proactive storage cues', async () => {
    // We test the description string indirectly by reading the source file.
    // This avoids needing to mock the full McpServer registration flow.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(
      resolve(__dirname, '..', '..', 'src', 'tools', 'consolidated', 'store.ts'),
      'utf-8'
    );

    // The description string should contain these proactive phrases
    expect(source).toContain('Call this proactively');
    expect(source).toContain('Always ask the user first');
    expect(source).toContain('scope (this repo / workspace / global)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/consolidated-store.test.ts -t "contains proactive storage cues"`
Expected: FAIL — the current description doesn't contain "Call this proactively" or the other phrases.

- [ ] **Step 3: Update the description string**

In `src/tools/consolidated/store.ts`, find the `server.tool(` call around line 112-114. The current description on line 114 is:

```typescript
    'Save a piece of knowledge. Types: learning (short insight, max 500 chars), decision (architectural choice with rationale), finding (code review issue), gotcha (non-obvious behavior). Before calling this, ask the user if they want to save it and which scope — this repo, workspace, or global.',
```

Replace it with:

```typescript
    'Save a piece of knowledge when you discover something worth preserving across sessions. Call this proactively when you encounter: a gotcha (non-obvious behavior), an architectural decision with rationale, a code review finding, or a short factual insight (conventions, debugging tips). Always ask the user first — e.g., "I noticed X, want me to save this to Mind Keg?" — and confirm scope (this repo / workspace / global) before calling.',
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/consolidated-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/consolidated/store.ts tests/unit/consolidated-store.test.ts
git commit -m "feat: add proactive storage cues to store tool description"
```

---

## Task 4: Refine the `update` tool description

**Files:**
- Modify: `src/tools/consolidated/update.ts` line 69 (tool description string)
- Test: `tests/unit/consolidated-update.test.ts` (extend with description check)

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/consolidated-update.test.ts`:

```typescript
describe('update tool description', () => {
  it('contains proactive deprecation cue', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(
      resolve(__dirname, '..', '..', 'src', 'tools', 'consolidated', 'update.ts'),
      'utf-8'
    );

    expect(source).toContain('proactively offer to deprecate or flag it');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/consolidated-update.test.ts -t "contains proactive deprecation cue"`
Expected: FAIL — the phrase isn't in the current description.

- [ ] **Step 3: Update the description string**

In `src/tools/consolidated/update.ts`, find the `server.tool(` call around line 67-69. The current description on line 69 is:

```typescript
    'Modify or manage existing knowledge. Actions: update (change content/tags), deprecate (mark outdated — preferred over delete), flag_stale (soft flag when unsure), delete (permanent), merge (consolidate duplicates). Use deprecate when you discover a stored learning is wrong. Use flag_stale when you\'re unsure.',
```

Replace it with:

```typescript
    'Modify or manage existing knowledge. Actions: update (change content/tags), deprecate (mark outdated — preferred over delete), flag_stale (soft flag when unsure), delete (permanent), merge (consolidate duplicates). When you find a stored learning that contradicts current reality, proactively offer to deprecate or flag it. Use deprecate when certain, flag_stale when unsure.',
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/consolidated-update.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/consolidated/update.ts tests/unit/consolidated-update.test.ts
git commit -m "feat: add proactive deprecation cue to update tool description"
```

---

## Task 5: Final preflight validation

**Files:** none (verification only)

- [ ] **Step 1: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: all tests pass (previous count + new tests from Tasks 1-4).

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: clean build.

- [ ] **Step 5: Manual verification — inspect the handshake**

Start the server in stdio mode and send an `initialize` request to verify `instructions` appears in the response:

```bash
# Build first
npm run build

# Send an initialize request and capture the response
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}' | node --experimental-sqlite dist/cli/index.js serve --stdio 2>/dev/null | head -1
```

Expected: the JSON response contains an `instructions` field with text starting with "You have access to Mind Keg".

If the output contains `"instructions":"You have access to Mind Keg`, the wiring is confirmed end-to-end.

- [ ] **Step 6: No commit needed**

Preflight validation produces no code changes.
