# Zero-Friction Effectiveness — Design Spec

**Date:** 2026-04-12
**Status:** Draft
**Goal:** Make mindkeg invisible — `npx mindkeg-mcp init` and the agent has persistent memory that works automatically.

## Problem

Mind Keg has strong internals (semantic search, conflict detection, staleness scoring, 22 tools across learnings and structured entities) but high adoption friction:

1. **Auth blocks local use.** Stdio transport requires an API key even though it's a local pipe on the same machine. Users must run `mindkeg api-key create`, copy the key, and set `MINDKEG_API_KEY` in their MCP config before anything works.
2. **Agents don't use it consistently.** With 22 tools and a 487-line AGENTS.md, LLMs get confused about which tool to call, forget to retrieve context at session start, and rarely store learnings proactively.
3. **No automatic retrieval.** The agent must remember to call `get_context` or `get_relevant_context` at session start. If it doesn't (and it often doesn't), the session runs without prior knowledge.

## Non-Goals

- Changing the data model, storage layer, or embedding system.
- Removing HTTP auth or enterprise security features.
- Dropping Cursor/Windsurf support.
- Changing how semantic search or ranking works internally.

---

## Design

### 1. Auth-Free Stdio Transport

**Current behavior:** Every MCP tool call routes through `authenticate()` → `validateApiKey()`, which throws `AuthError` when no API key is set. This applies to both stdio and HTTP transports identically.

**New behavior:** Stdio transport bypasses authentication entirely.

**Implementation:**

- In `startStdio()` (`src/index.ts`), pass a sentinel value as the API key callback: `getApiKey: () => '__stdio_local__'`.
- In `authenticate()` (`src/auth/middleware.ts`), when the raw key is `'__stdio_local__'`, skip key validation and repository access checks. Return a synthetic `AuthContext` with an unrestricted key record (empty `repositories` array = all access).
- HTTP transport is unchanged — full API key validation, rate limiting, and repository access control remain.
- The `init` command stops including `MINDKEG_API_KEY` in the generated MCP config env block.
- `mindkeg api-key create` remains available for HTTP mode users.

**Audit logging:** Stdio calls are logged with actor `"stdio-local"` instead of an API key prefix.

### 2. Tool Surface Consolidation (22 → 8)

Collapse 22 tools into 8 organized by intent.

#### `get_context` (replaces `get_context`, `get_relevant_context`, `search_learnings`)

Single retrieval entry point. Behavior determined by parameters:

| Parameters provided | Behavior |
|---|---|
| `repository` only | Full session primer — learnings partitioned by scope, stale review, near-duplicates, conflicts, relationships (current `get_context`) |
| `repository` + `task_description` | Task-scoped context across all entity types — decisions, findings, gotchas, learnings, run history (current `get_relevant_context`) |
| `query` (with optional `repository`, `workspace`, `category`, `tags`) | Semantic search with filters (current `search_learnings`) |
| `repository` + `task_description` + `query` | Task-scoped context with additional semantic boost |

Parameters:

```typescript
{
  repository: z.string().optional(),      // Repo path for scoping
  workspace: z.string().optional(),       // Workspace path for scoping
  task_description: z.string().optional(), // What you're about to do (triggers entity-scoped context)
  query: z.string().optional(),           // Semantic search query
  category: z.enum(CATEGORIES).optional(), // Filter by category
  tags: z.array(z.string()).optional(),   // Filter by tags
  budget: z.enum(['compact', 'standard', 'full']).optional(), // Character budget
  limit: z.number().int().min(1).max(50).optional(), // Max results (search mode)
  include_stale: z.boolean().optional(),  // Include stale-flagged items
  include_deprecated: z.boolean().optional(), // Include deprecated items
  verify_integrity: z.boolean().optional(), // Check integrity hashes
}
```

Validation: at least one of `repository`, `workspace`, or `query` must be provided.

#### `store` (replaces `store_learning`, `store_decision`, `store_finding`, `store_gotcha`)

Single storage entry point with a `type` discriminator.

```typescript
{
  type: z.enum(['learning', 'decision', 'finding', 'gotcha']),
  repository: z.string().optional(),
  workspace: z.string().optional(),

  // Learning fields (type='learning')
  content: z.string().max(500).optional(),
  category: z.enum(CATEGORIES).optional(),
  tags: z.array(z.string()).optional(),
  source_agent: z.string().optional(),
  ttl_days: z.number().int().positive().optional(),

  // Decision fields (type='decision')
  choice: z.string().max(1000).optional(),
  rationale: z.string().max(2000).optional(),
  decision_category: z.string().optional(),
  made_by: z.string().optional(),

  // Finding fields (type='finding')
  file_path: z.string().optional(),
  severity: z.enum(['critical', 'warning', 'suggestion']).optional(),
  issue: z.string().max(1000).optional(),
  suggestion: z.string().max(1000).optional(),
  found_by: z.string().optional(),

  // Gotcha fields (type='gotcha')
  description: z.string().optional(),
  technology: z.string().optional(),
}
```

Validation: Zod discriminated union on `type`. Each type requires its own mandatory fields (e.g., `type='learning'` requires `content`; `type='decision'` requires `choice` and `rationale`).

#### `update` (replaces `update_learning`, `deprecate_learning`, `flag_stale`, `delete_learning`, `merge_learnings`)

```typescript
{
  action: z.enum(['update', 'deprecate', 'flag_stale', 'delete', 'merge']),
  id: z.string().uuid(),                    // Target learning ID
  // update fields
  content: z.string().max(500).optional(),
  category: z.enum(CATEGORIES).optional(),
  tags: z.array(z.string()).optional(),
  source_agent: z.string().optional(),
  // deprecate/flag_stale fields
  reason: z.string().optional(),
  // merge fields
  duplicate_ids: z.array(z.string().uuid()).optional(),
  merged_content: z.string().optional(),
}
```

#### `resolve` (replaces `supersede_decision`, `resolve_finding`)

```typescript
{
  type: z.enum(['decision', 'finding']),
  id: z.string().uuid(),                    // ID to resolve/supersede
  // decision fields
  new_decision_id: z.string().uuid().optional(), // For superseding
  // finding fields
  resolved_by: z.string().optional(),
}
```

#### `complete_run` (unchanged)

Same parameters and behavior as current `complete_run`.

#### `query` (replaces `get_decisions`, `get_open_findings`, `get_gotchas`, `get_run_history`)

```typescript
{
  type: z.enum(['decisions', 'findings', 'gotchas', 'runs']),
  repository: z.string(),
  // Optional filters per type
  category: z.string().optional(),          // decisions filter
  severity: z.enum([...]).optional(),       // findings filter
  technology: z.string().optional(),        // gotchas filter
  limit: z.number().int().optional(),       // runs limit
}
```

#### `list_scopes` (replaces `list_repositories`, `list_workspaces`)

```typescript
{} // No parameters — returns both repositories and workspaces with counts
```

#### `relate` (unchanged from `relate_learnings`)

Same parameters. Kept separate because it's a graph operation between two entities, distinct from CRUD.

#### Backwards Compatibility

Old tool names (all 22) are registered as aliases that internally delegate to the new consolidated tools. Aliases emit a deprecation notice in the response metadata. Aliases are removed in the next major version.

### 3. Self-Describing Tool Descriptions

Each tool description encodes behavioral guidance — *when* to call, not just *what* it does. The description is the instruction manual for LLMs that don't read AGENTS.md.

#### `get_context`

> "Retrieve relevant knowledge for your current session. **Call this at the start of every session** with at least the repository path. Add task_description for task-scoped context across all knowledge types (decisions, findings, gotchas, learnings, run history). Add query for semantic search on a specific topic. Returns knowledge ranked by relevance and trimmed to budget."

#### `store`

> "Save a piece of knowledge. Types: learning (short insight, max 500 chars), decision (architectural choice with rationale), finding (code review issue), gotcha (non-obvious behavior). **Before calling this, ask the user if they want to save it and which scope** — this repo, workspace, or global."

#### `update`

> "Modify or manage existing knowledge. Actions: update (change content/tags), deprecate (mark outdated — preferred over delete), flag_stale (soft flag when unsure), delete (permanent), merge (consolidate duplicates). **Use deprecate when you discover a stored learning is wrong. Use flag_stale when you're unsure.**"

#### `resolve`

> "Close out a decision or finding. For decisions: supersede an old decision with a new one (store the new decision first, then call resolve). For findings: mark a code review finding as resolved after it's been addressed."

#### `complete_run`

> "Record a completed work session. **Call this at the end of significant tasks** — implementations, refactors, debugging sessions. Records what was done, which files changed, and whether the outcome was success, partial, or failed."

#### `query`

> "List stored knowledge by type. Use to browse decisions, open findings, gotchas, or run history for a repository. For searching by topic, use get_context with a query instead."

#### `list_scopes`

> "List all repositories and workspaces that have stored knowledge, with counts. Use to understand what knowledge exists across your projects."

#### `relate`

> "Create a typed relationship between two pieces of knowledge. Types: supersedes, depends_on, related_to, caused_by. Use when you notice that learnings are connected."

### 4. Minimal AGENTS.md

Replace the current 487-line AGENTS.md template with a ~40-line behavioral contract. Tool details are in the self-describing tool descriptions (Section 3) and don't need to be duplicated.

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

### 5. Auto-Retrieval Hook (Claude Code)

`init --agent claude-code` generates a `SessionStart` hook that loads mindkeg context into every new conversation automatically.

#### Hook Script: `.claude/hooks/load-mindkeg.sh`

The script:

1. Detects the repository path from `git rev-parse --show-toplevel` (falls back to `$PWD`).
2. Runs a self-contained Node.js script (inline via `node -e` or a bundled `.mjs` file) that:
   a. Imports mindkeg's storage factory and learning service directly (no stdio transport round-trip — avoids MCP protocol overhead and timeout risk).
   b. Calls `learningService.getContext({ repository })` synchronously.
   c. Formats the result as human-readable structured text.
3. Prints the formatted context to stdout (which Claude Code injects into the conversation).
4. Wraps the entire invocation in a try/catch — failures produce empty output and exit 0. Never blocks startup.
5. Completes within the 10-second timeout. Direct library import avoids the cold-start penalty of spawning a full MCP server.

**Alternative considered:** Spawning `npx mindkeg-mcp serve --stdio` and sending a JSON-RPC request. Rejected because the stdio MCP handshake (initialize + tools/call + shutdown) adds latency and complexity for a single read-only call. Direct library import is simpler and faster.

For Windows, `init` generates `.claude/hooks/load-mindkeg.ps1` with equivalent logic.

#### Hook Registration: `.claude/settings.json`

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": ".claude/hooks/load-mindkeg.sh",
            "timeout": 10,
            "statusMessage": "Loading persistent memory..."
          }
        ]
      }
    ]
  }
}
```

`init` merges this into existing settings — it never overwrites other hook configurations.

#### Non-Claude-Code Fallback

Cursor and Windsurf don't support session hooks. For these agents:
- The self-describing `get_context` tool description ("call this at session start") is the primary driver.
- The minimal AGENTS.md reinforces the behavior.
- When these clients gain hook or resource support, `init` can be updated to generate the appropriate config.

#### MCP Resource (Bonus)

Register an MCP resource for clients that support resource auto-loading:

```
mindkeg://context/{repository}
```

This is additive — it provides another path for MCP clients to discover and load context. Lower priority than the hook since hook support in Claude Code is confirmed and reliable.

### 6. Streamlined `init` Command — Global-First Setup

**Key insight:** Per-repo onboarding is friction. Mindkeg should be a one-time global install that works in every repo automatically. Per-repo `init` becomes optional customization.

#### `npx mindkeg-mcp init` (default — global setup)

1. **Detect agent** — scan for global config locations. Default to Claude Code.
2. **Run migrations** — ensure `~/.mindkeg/brain.db` exists and schema is current.
3. **Write global MCP config** — to `~/.claude.json` (Claude Code), `~/.cursor/mcp.json` (Cursor), `~/.windsurf/mcp.json` (Windsurf). No `MINDKEG_API_KEY` in env block.
4. **Generate global hook** (Claude Code only) — write `~/.claude/hooks/load-mindkeg.sh` (or `.ps1` on Windows) and add `SessionStart` entry to `~/.claude/settings.json`.
5. **Health check** — verify Node 22+, `node:sqlite`, fastembed.
6. **Print summary:**

```
Mind Keg installed globally!

  MCP config       ~/.claude.json
  Auto-retrieval   ~/.claude/hooks/load-mindkeg.sh (SessionStart hook)
  Database         ~/.mindkeg/brain.db (migrated)
  Health           Node 22 OK, SQLite OK, FastEmbed OK

Mind Keg is now active in every Claude Code session.
Learnings accumulate as you work -- no per-project setup needed.
```

#### `npx mindkeg-mcp init --project` (optional — per-repo customization)

For users who want project-specific AGENTS.md or hook customization:

1. **Write project-level MCP config** — to `.claude/mcp.json` (overrides global for this project).
2. **Write agent instructions** — the ~40-line AGENTS.md appended to CLAUDE.md.
3. **Generate project-level hook** (optional) — only if the user wants project-specific hook behavior.

Most users never run `--project`. The global setup is sufficient.

---

## Migration Path

### For Existing Users

- Old 22 tool names continue to work as aliases for one major version.
- Existing `MINDKEG_API_KEY` env vars in MCP configs still work — auth is bypassed for stdio regardless of whether a key is set. The key is simply ignored.
- Existing per-project MCP configs continue to work. The global config is additive — project-level configs take precedence.
- Running `init` again is safe (idempotent) — it adds the hook and updates config without breaking existing setup.

### Breaking Changes (Next Major Version)

- Old tool name aliases removed.
- `MINDKEG_API_KEY` no longer checked for stdio transport (already ignored in this version, formally removed in next).

---

## Success Criteria

1. A new user runs `npx mindkeg-mcp init` **once** and opens Claude Code in **any** repo. The agent has mindkeg context loaded automatically — no env vars, no API keys, no per-repo setup.
2. The agent stores learnings only after asking the user. It retrieves context without being asked.
3. An existing mindkeg user can upgrade without breaking their workflow — old tool names and per-project configs continue to work during the transition period.
4. Cursor/Windsurf users get improved tool descriptions that drive consistent behavior even without hooks.
