# Agent Instruction Delivery — Design Spec

**Date:** 2026-04-13
**Status:** Draft
**Goal:** Ensure agents reliably know to proactively offer to save discoveries during work, regardless of MCP client or whether the user ran `init --project`.

## Problem

After v0.7.0's global-first init, mindkeg's retrieval path works automatically (SessionStart hook injects context). But the storage path is broken:

1. **Agents don't proactively store.** Tool descriptions tell agents *how* to store, but not *when* to reach for the tool. Without a behavioral contract in the conversation context, agents treat mindkeg as a passive library instead of an active memory system.

2. **The old delivery mechanism is gone.** In v0.6 and earlier, `mindkeg init` copied a 487-line AGENTS.md into every project, including an explicit "during work: ask the user before storing when you discover X" workflow. The v0.7.0 global-first init only writes this when the user explicitly runs `init --project`, which most users never will.

3. **Observed behavior confirms the gap.** In a testing session on a real repo, the agent loaded mindkeg context via the hook (retrieval worked), then worked through a full session without ever offering to save any of the discoveries it made. The MCP tools were available, but nothing prompted the agent to reach for them proactively.

## Non-Goals

- Codebase indexing or per-repo onboarding — Claude Code's auto-memory already handles this.
- Changing the data model, storage, or retrieval logic.
- Modifying the SessionStart hook's core behavior.
- Resurrecting the 487-line AGENTS.md as the primary delivery path.

---

## Design

Three complementary layers, each with one clear responsibility.

### 1. MCP Server `instructions` (Primary Mechanism)

The MCP protocol includes an `instructions` field on the server metadata (supported by the `@modelcontextprotocol/sdk` `McpServer` constructor). It's a string returned in the `initialize` response to every MCP client at handshake. Every MCP-compliant client — Claude Code, Cursor, Windsurf, Codex, Gemini CLI — receives this.

**Implementation:** Add an `instructions` property to the `McpServer` constructor options in `src/server.ts`.

**Content:**

```
You have access to Mind Keg — a persistent memory system for knowledge that survives across sessions. Use it to retrieve prior context and proactively preserve new insights.

# When to retrieve

At session start, call `get_context({ repository: "<current repo path>" })` to load prior knowledge. If the SessionStart hook already injected context (visible as "Mind Keg Persistent Memory" at the top of the conversation), skip this — the context is already loaded.

For topic-specific lookups mid-session, call `get_context({ query: "<topic>", repository: "<path>" })`.

# When to store (proactively offer)

When you discover something non-obvious during work, pause and offer to save it:

> "I noticed [X]. This looks like a [gotcha/decision/finding]. Want me to save it to Mind Keg?
>  Scope: this repo, this workspace, or globally?"

Wait for the user's answer before calling `store`.

Watch for these patterns specifically:

- **Gotchas** — non-obvious behaviors, footguns, surprising library quirks → `store({ type: "gotcha", ... })`
- **Architectural decisions** with rationale → `store({ type: "decision", ... })`
- **Code review findings** that need tracking across sessions → `store({ type: "finding", ... })`
- **Short factual insights** (conventions, debugging tips, compact observations) → `store({ type: "learning", ... })`

# Rules

- Always ask before storing. Never store silently.
- Don't store transient session state, obvious facts, or codebase-specific details that change as code evolves (file paths, function locations). Those belong in project-level memory, not Mind Keg.
- Prefer `update({ action: "deprecate" })` over delete for wrong knowledge — preserves audit trail.
- Use `update({ action: "flag_stale" })` when you suspect something is outdated but aren't sure.
- For scope, default suggestion when asking the user: this repo unless the insight clearly applies cross-project.
- At session end, if you made multiple discoveries, summarize them and offer to save the ones the user wants to keep.
```

**Token cost:** ~350 tokens, delivered once per connection (not per message). Minimal impact.

**Why this is the right primary mechanism:**
- Universal — every MCP-compliant client reads this at handshake.
- Single source of truth — the behavioral contract lives in one place.
- Independent of hook support, resource support, or client-specific features.
- Survives future MCP client evolution.

### 2. Refined Tool Descriptions (Reinforcement)

Tool descriptions are already self-describing (v0.7.0 feature). Two descriptions get minor refinements to reinforce proactive behavior.

#### `store` — Enhanced description

**Current:**
> "Save a piece of knowledge. Types: learning (short insight, max 500 chars), decision (architectural choice with rationale), finding (code review issue), gotcha (non-obvious behavior). Before calling this, ask the user if they want to save it and which scope — this repo, workspace, or global."

**New:**
> "Save a piece of knowledge when you discover something worth preserving across sessions. **Call this proactively** when you encounter: a gotcha (non-obvious behavior), an architectural decision with rationale, a code review finding, or a short factual insight (conventions, debugging tips). **Always ask the user first** — e.g., 'I noticed X, want me to save this to Mind Keg?' — and confirm scope (this repo / workspace / global) before calling."

**Location:** `src/tools/consolidated/store.ts` line ~108 (the `server.tool('store', '...', schema, handler)` call).

#### `update` — Enhanced description

**Current:**
> "Modify or manage existing knowledge. Actions: update (change content/tags), deprecate (mark outdated — preferred over delete), flag_stale (soft flag when unsure), delete (permanent), merge (consolidate duplicates). Use deprecate when you discover a stored learning is wrong. Use flag_stale when you're unsure."

**New:**
> "Modify or manage existing knowledge. Actions: update (change content/tags), deprecate (mark outdated — preferred over delete), flag_stale (soft flag when unsure), delete (permanent), merge (consolidate duplicates). **When you find a stored learning that contradicts current reality, proactively offer to deprecate or flag it.** Use deprecate when certain, flag_stale when unsure."

**Location:** `src/tools/consolidated/update.ts`.

The other 6 consolidated tools (`get_context`, `resolve`, `complete_run`, `query`, `list_scopes`, `relate_learnings`) are already correctly descriptive and don't need proactive cues — they're either read-only or driven by explicit user intent.

### 3. SessionStart Hook (Unchanged)

The hook remains focused on context retrieval for Claude Code. Its current output ends with:

```
These learnings were loaded from Mind Keg. Use get_context for more details or store to save new knowledge.
```

This short footer is sufficient as a reminder — the full behavioral contract now lives in server `instructions` (Section 1), so duplicating it in the hook would waste tokens.

No changes to `src/hooks/generate-hook.ts` or the hook registration in `init`.

---

## What's Explicitly NOT Changing

**Not adding MCP resources (`mindkeg://instructions`).** Server `instructions` covers the same ground more universally and with more reliable client support. A resource would duplicate the content and add complexity.

**Not expanding the hook output.** Server `instructions` is delivered once per connection to every client; hook output is Claude-Code-only and runs every session. Putting the contract in `instructions` is more efficient and broader.

**Not resurrecting the 487-line AGENTS.md.** The 40-line minimal AGENTS.md template stays as-is for `init --project` users who want project-specific customization.

**Not adding codebase onboarding or indexing.** Claude Code's auto-memory already handles per-project codebase knowledge. Mindkeg's role is cross-project insights, not per-repo facts.

---

## Implementation Summary

**Files modified:**
- `src/server.ts` — Add `instructions` string to `McpServer` constructor options.
- `src/tools/consolidated/store.ts` — Enhance tool description (~50 char change).
- `src/tools/consolidated/update.ts` — Enhance tool description (~30 char change).

**Files unchanged:**
- `src/hooks/generate-hook.ts`
- `cli/commands/init.ts`
- `templates/AGENTS.md`
- All services, storage, models.

**Test additions:**
- Unit test verifying `createMcpServer` returns a server with the `instructions` field populated.
- Unit test verifying `store` and `update` tool descriptions contain the key proactive phrases.

---

## Migration Path

No breaking changes. Every existing user benefits automatically on upgrade:
- Claude Code users: continue to get the hook, plus new server instructions at handshake.
- Cursor/Windsurf users: get the server instructions (their only behavioral contract delivery path).
- Existing MCP configs and databases: unaffected.

---

## Success Criteria

1. Agents in any MCP client proactively offer to save discoveries during sessions (gotchas, decisions, findings, insights) without being told to.
2. The offer includes a scope question (repo / workspace / global).
3. Agents never store silently — they always ask first.
4. The behavioral contract is delivered once per connection at handshake, not repeated per message.
5. Existing retrieval behavior (SessionStart hook in Claude Code) continues to work unchanged.
