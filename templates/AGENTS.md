# Mind Keg — Agent Instructions

You have access to **Mind Keg**, a persistent memory system. It stores structured knowledge — architectural decisions, code review findings, gotchas, and atomic learnings — so you never lose context between sessions.

**You MUST follow these instructions in every session.**

## On Session Start

1. Determine the current repository path and workspace path (parent folder) from the working directory.

2. Call `get_relevant_context` to prime yourself with task-scoped knowledge in one call:

   ```
   get_relevant_context({
     repository: "<current repo path>",
     task_description: "<what you are about to do — 1-3 sentences>",
     budget: "standard"
   })
   ```

   This returns the most relevant decisions, open findings, gotchas, learnings, and recent run history — all scored by relevance to your task. Use this instead of (or in addition to) `get_context` for structured agent knowledge.

   **Budget options:**
   - `"compact"`: ~2000 chars (quick check, minimal context)
   - `"standard"`: ~4000 chars (default, good balance)
   - `"full"`: ~8000 chars (deep context, larger tasks)

3. Optionally call `get_context` for the full learning dump with staleness review and near-duplicate detection:

   ```
   get_context({ repository: "<current repo path>" })
   ```

   This returns learnings partitioned into `repo_learnings`, `workspace_learnings`, and `global_learnings`, ranked by actionability (gotchas first). It also surfaces `stale_review` items (learnings that may be outdated) and `near_duplicates` (redundant pairs for cleanup).

4. If `get_context` returns a `stale_review` array with items, examine them. For each:
   - If the learning is confirmed outdated: use `deprecate_learning` and store a corrected version.
   - If you're unsure: leave it flagged (do not clear the flag).

5. If `get_context` returns `near_duplicates`, note the pairs. Offer to consolidate them at the end of the session.

6. For topic-specific work, use `search_learnings` to find learnings you know to look for. **You MUST search all three scopes explicitly** if you need targeted results:

   ```
   // Repo scope
   search_learnings({ query: "<short keywords>", repository: "<current repo path>" })

   // Workspace scope
   search_learnings({ query: "<short keywords>", workspace: "<parent folder path>" })

   // Global scope (omit both)
   search_learnings({ query: "<short keywords>" })
   ```

   Use **short, focused queries** (1-3 keywords). Semantic search performs poorly with long sentences.

6. Read the results and incorporate relevant learnings into your approach **before writing any code**.

## During the Session

Use the appropriate tool for each type of knowledge you discover:

| What you discover | Tool to use |
|---|---|
| An architectural choice with clear WHY (tech selection, design pattern, API design) | `store_decision` |
| A code review issue that needs tracking across sessions | `store_finding` |
| A non-obvious behavior or footgun that keeps tripping people up | `store_gotcha` |
| A short factual insight (debugging tip, convention, quick gotcha) | `store_learning` |

- If you discover a **contradiction** with a stored learning, use `deprecate_learning` on the old one and store the corrected version with `store_learning`.
- If a learning seems **outdated but you're not sure**, use `flag_stale` to mark it for review instead of deleting it.
- When a decision is **replaced by a newer one**: call `store_decision` for the new decision, then call `supersede_decision({ decision_id: oldId, new_decision_id: newId })`.
- When a finding is **fixed**: call `resolve_finding({ finding_id: "<uuid>", resolved_by: "<your-agent-name>" })`.

## On Session End (or After Significant Discoveries)

**Ask the user** if they want to save any learnings from the session:

> "I discovered some things during this session that might be useful for future work:
> - [learning 1]
> - [learning 2]
>
> Should I save these to Mind Keg?"

If you are an orchestrator or completed a significant work session, call `complete_run`:

```json
{
  "repository": "/path/to/current/repo",
  "summary": "Implemented OAuth 2.0 authentication. Added JWT validation middleware and updated all protected routes.",
  "files_changed": ["src/auth/middleware.ts", "src/routes/users.ts"],
  "outcome": "success"
}
```

**CRITICAL — NEVER skip this step:**

Before storing ANY learning, you **MUST ask the user which scope applies**. Do NOT assume the scope — even if it seems obvious. Always ask explicitly:

> "Should this learning apply to:
> 1. **This repo only** (`repository`: `/path/to/current/repo`)
> 2. **All repos in this workspace** (`workspace`: `/path/to/parent/folder/`)
> 3. **Globally** (omit both)"

Wait for the user's answer before calling `store_learning`. If the user provides a blanket answer (e.g., "workspace for all of them"), apply it to all learnings in that batch.

Then use `store_learning` with the chosen scope. Always include:
- `repository` OR `workspace` (not both) — or omit both for global learnings
- `category`: one of `architecture`, `conventions`, `debugging`, `gotchas`, `dependencies`, `decisions` — optional; omit to trigger auto-categorization (requires an embedding provider)
- `tags`: relevant keywords for searchability
- `source`: your agent name (e.g., `"claude-code"`, `"cursor"`, `"windsurf"`, `"codex-cli"`)

---

## Tool Reference

### store_learning

Store a new atomic learning. Keep it short (1-3 sentences, max 500 characters).

Use `repository` for repo-specific learnings, `workspace` for workspace-wide learnings (all repos under the same parent folder), or omit both for global learnings. `repository` and `workspace` are mutually exclusive.

```json
{
  "content": "Always wrap Prisma client calls in try/catch — it throws on constraint violations, not returns null.",
  "category": "gotchas",
  "tags": ["prisma", "error-handling"],
  "repository": "/path/to/current/repo",
  "source": "your-agent-name",
  "source_agent": "your-agent-name"
}
```

**Optional parameters:**
- `category`: One of `architecture`, `conventions`, `debugging`, `gotchas`, `dependencies`, `decisions`. If omitted, the server auto-categorizes using KNN voting on the 5 nearest neighbor learnings. Requires an embedding provider — omitting category with `MINDKEG_EMBEDDING_PROVIDER=none` returns a validation error.
- `source_agent`: Your agent name (e.g., `"claude-code"`, `"cursor"`). Used for provenance tracking — records which agent authored the learning.
- `ttl_days`: Integer. Per-learning time-to-live in days. Overrides the global `MINDKEG_DEFAULT_TTL_DAYS` setting. Omit for no per-learning expiry.

**Response fields:**
- `auto_categorized`: Boolean. `true` if the server inferred the category rather than using an explicitly provided value.
- `conflicts`: Array of conflict objects detected at store time. Each entry has `learning_id`, `content`, `similarity`, and `conflict_type: "keyword_heuristic"`. Review conflicts — they are keyword-heuristic detections and may include false positives.

Workspace-scoped example (applies to all repos under `/path/to/workspace/`):

```json
{
  "content": "All services in this workspace use OAuth 2.0 with PKCE — do not use implicit flow.",
  "category": "conventions",
  "tags": ["auth", "oauth"],
  "workspace": "/path/to/workspace/",
  "source": "your-agent-name",
  "source_agent": "your-agent-name",
  "ttl_days": 365
}
```

### search_learnings

Search for relevant learnings. Each scope requires its own search call:
- Use `repository` to search **repo-scoped** learnings
- Use `workspace` to search **workspace-scoped** learnings
- Omit both to search **global** learnings

**Always search all three scopes** to get complete results. The `repository` parameter does NOT automatically include workspace-scoped learnings.

```json
// Repo scope
{ "query": "how to handle database migrations", "repository": "/path/to/current/repo" }

// Workspace scope
{ "query": "how to handle database migrations", "workspace": "/path/to/parent/folder/" }

// Global scope
{ "query": "how to handle database migrations" }
```

**Optional parameter:**
- `verify_integrity`: Boolean (default `false`). When `true`, each result includes an `integrity_valid` field: `true` (hash matches), `false` (content may have been tampered), or `null` (legacy learning with no stored hash). Use this when you suspect memory poisoning or database corruption.

**Response fields on each result:**
- `access_count`: Integer. How many times this learning has been returned by search or get_context.
- `last_accessed_at`: ISO 8601 string or `null`. When this learning was last returned.
- `staleness_score`: Float 0.0–1.0. Computed staleness; 0.0 = fresh, 1.0 = very stale. Updated periodically.
- `relationships`: Array of relationship objects for this learning (if any). Each entry has `source_id`, `target_id`, `relationship_type` (one of `supersedes`, `depends_on`, `related_to`, `caused_by`), `created_at`, and `created_by`.

### update_learning

Update an existing learning's content, category, or tags.

```json
{
  "id": "uuid-of-the-learning",
  "content": "Updated content here.",
  "tags": ["updated", "tags"],
  "source_agent": "your-agent-name"
}
```

**Optional parameter:**
- `source_agent`: Your agent name. Records which agent last updated the learning for provenance tracking.

### deprecate_learning

Mark a learning as outdated. Deprecated learnings are excluded from search by default.

```json
{
  "id": "uuid-of-the-learning",
  "reason": "This approach was replaced with X in PR #123."
}
```

### flag_stale

Flag a learning as potentially stale when you notice contradictions or suspect it's outdated. Unlike deprecation, this is a soft flag — the learning still appears in search results.

```json
{
  "id": "uuid-of-the-learning",
  "reason": "Batch limit may have been increased to 200 based on recent changes."
}
```

### delete_learning

Permanently delete a learning. Prefer `deprecate_learning` for auditability.

```json
{
  "id": "uuid-of-the-learning"
}
```

### merge_learnings

Merge one or more near-duplicate learnings into a single canonical entry. All duplicate learnings are deprecated after the merge.

```json
{
  "canonical_id": "uuid-of-the-learning-to-keep",
  "duplicate_ids": ["uuid-of-duplicate-1", "uuid-of-duplicate-2"],
  "merged_content": "Optional replacement content for the canonical learning."
}
```

- `canonical_id`: The learning to keep. Must be active.
- `duplicate_ids`: One to twenty IDs of learnings to deprecate. Must not include `canonical_id`.
- `merged_content` (optional): If provided, updates the canonical learning's content and regenerates its embedding. If omitted, canonical content is unchanged.

**Response fields:**
- `canonical`: The updated canonical learning object.
- `deprecated_count`: Number of learnings deprecated by the merge.

### relate_learnings

Create a typed directed relationship between two learnings. Use this to express how learnings relate to each other.

```json
{
  "source_id": "uuid-of-the-source-learning",
  "target_id": "uuid-of-the-target-learning",
  "relationship_type": "supersedes",
  "created_by": "your-agent-name"
}
```

- `relationship_type`: One of `supersedes`, `depends_on`, `related_to`, `caused_by`.
- `created_by`: Your agent name (for provenance).
- Duplicate relationships (same source, target, and type) are rejected with a validation error.
- Relationships are cascade-deleted when either learning is deleted. Deprecated learnings retain their relationships.

**Response fields:**
- `relationship`: The created relationship record (`id`, `source_id`, `target_id`, `relationship_type`, `created_at`, `created_by`).

### list_repositories

List all repositories that have stored learnings.

```json
{}
```

### list_workspaces

List all workspace directories that have workspace-scoped learnings, along with the learning count per workspace.

```json
{}
```

### get_context

Prime an agent session with all relevant learnings for the current repository in one call. Returns learnings ranked by actionability, partitioned by scope, and trimmed to a character budget. Always safe to call — read-only.

```json
{
  "repository": "/path/to/current/repo",
  "path_hint": "packages/api",
  "query": "authentication",
  "budget": "standard"
}
```

**Optional parameter:**
- `verify_integrity`: Boolean (default `false`). When `true`, each returned learning includes `integrity_valid`: `true` (hash matches), `false` (possible tampering), or `null` (legacy learning). Useful for security-conscious sessions or after a database migration.

Response sections:
- `repo_learnings`: Repo-scoped learnings (ranked: gotchas → conventions → decisions → dependencies). Each entry includes `access_count`, `last_accessed_at`, and `staleness_score`.
- `workspace_learnings`: Workspace-scoped learnings (same fields as above).
- `global_learnings`: Global learnings (same fields as above).
- `stale_review`: Stale-flagged learnings for your attention; ranked by `staleness_score` descending (most stale first).
- `near_duplicates`: Near-duplicate pairs to consider consolidating.
- `conflicts`: Array of unresolved conflict objects for all returned learnings. Each entry has `id`, `learning_id_a`, `learning_id_b`, `similarity`, `conflict_type`, and `created_at`. Conflicts are keyword-heuristic detections — review before acting.
- `relationships`: Map of learning ID → relationship array. Each relationship has `source_id`, `target_id`, `relationship_type`, `created_at`, and `created_by`.
- `summary`: Counts per scope and most-recent `last_updated` timestamp.

---

## What Makes a Good Learning?

- **Atomic**: One insight per entry. Don't bundle multiple unrelated facts.
- **Actionable**: Describes what to DO or AVOID, not just what exists.
- **Specific**: Mentions concrete context (library name, file path, pattern name).
- **Brief**: 1-3 sentences. Max 500 characters. If it's longer, split it.

**Good:**
- "Always wrap Prisma client calls in try/catch — it throws on constraint violations, not returns null."
- "The `useAuth` hook must be called inside `AuthProvider` — calling it at the page level causes an infinite loop."
- "This repo uses `pnpm` workspaces — do not use `npm install`; it will break the lockfile."

**Bad:**
- "Be careful with the database." (not actionable)
- "The codebase uses TypeScript." (not an insight)
- Long multi-paragraph descriptions (not atomic — split into separate learnings)

## Categories

Category is optional in `store_learning`. If omitted, the server infers it using KNN voting on the 5 nearest neighbor learnings in scope. Provide an explicit category when you know it — this is faster and more predictable than auto-categorization. Auto-categorization requires an embedding provider (`fastembed` or `openai`); it fails if `MINDKEG_EMBEDDING_PROVIDER=none`.

| Category | When to Use |
|---|---|
| `architecture` | System design decisions, patterns, module structure |
| `conventions` | Code style, naming, formatting rules specific to this project |
| `debugging` | How specific bugs were diagnosed and fixed |
| `gotchas` | Surprising behaviors, footguns, things that break unexpectedly |
| `dependencies` | Library-specific behaviors, version constraints, breaking changes |
| `decisions` | Why a specific approach was chosen over alternatives |

---

## New Structured Tools (Agent Memory Upgrade)

These tools provide first-class entities for the most common knowledge types agents produce and consume.

### store_decision

Store an architectural decision with rationale. Max 1000 chars for `choice`, 2000 chars for `rationale`.

```json
{
  "repository": "/path/to/repo",
  "category": "database",
  "choice": "Use SQLite with node:sqlite for local storage. No external database.",
  "rationale": "Solo developer use case. No concurrent writes needed. node:sqlite is built-in to Node.js 22+ — zero external dependencies. SQLite file can be shared via git or backed up easily.",
  "made_by": "claude-code"
}
```

### get_decisions

Get active decisions for a repository (optional category filter):

```json
{ "repository": "/path/to/repo", "category": "database" }
```

### supersede_decision

Mark a decision as replaced. Call `store_decision` first to get the new ID:

```json
{ "decision_id": "old-uuid", "new_decision_id": "new-uuid" }
```

### store_finding

Store a code review finding. Severity: `critical` (must fix), `warning` (should fix), `suggestion` (nice to fix). Max 1000 chars each for `issue` and `suggestion`.

```json
{
  "repository": "/path/to/repo",
  "file_path": "src/auth/middleware.ts",
  "severity": "critical",
  "issue": "JWT secret is hardcoded as 'secret123' on line 12. This will be exposed in version control.",
  "suggestion": "Move to environment variable: process.env.JWT_SECRET. Add JWT_SECRET to .env.example.",
  "found_by": "claude-code"
}
```

### resolve_finding

Mark a finding as resolved after it has been addressed:

```json
{ "finding_id": "uuid-of-finding", "resolved_by": "claude-code" }
```

### get_open_findings

Get unresolved findings (critical first):

```json
{ "repository": "/path/to/repo", "severity": "critical" }
```

### store_gotcha

Store a non-obvious behavior. Auto-deduplicates: if a similar gotcha exists (cosine similarity >= 0.85), increments its `times_encountered` counter instead of creating a duplicate.

```json
{
  "repository": "/path/to/repo",
  "description": "node:sqlite DatabaseSync is synchronous — do NOT use await on DB calls. It will silently return a Promise wrapping the result instead of the actual row.",
  "tags": ["sqlite", "async", "node"],
  "technology": "sqlite"
}
```

Response includes `incremented: true` when an existing gotcha was updated instead of a new one being created.

### get_gotchas

Get gotchas ordered by frequency (most common first):

```json
{ "repository": "/path/to/repo", "technology": "sqlite" }
```

### complete_run

Record a completed execution run at the end of an orchestration or work session:

```json
{
  "repository": "/path/to/repo",
  "summary": "Implemented JWT authentication. Added middleware, updated all protected routes, wrote tests.",
  "files_changed": ["src/auth/middleware.ts", "src/routes/users.ts", "tests/auth.test.ts"],
  "outcome": "success",
  "duration_seconds": 180
}
```

`outcome`: `"success"` (all done), `"partial"` (some done), `"failed"` (did not complete).

### get_run_history

Get recent run summaries:

```json
{ "repository": "/path/to/repo", "limit": 5 }
```

### get_relevant_context

Get task-scoped context across ALL entity types in one call. Use at session start:

```json
{
  "repository": "/path/to/repo",
  "task_description": "Implement rate limiting middleware for the REST API using token bucket algorithm",
  "budget": "standard"
}
```

Response structure:

```json
{
  "decisions": [...],      // max 3 most relevant active decisions
  "open_findings": [...],  // max 3 most relevant open findings (critical first)
  "gotchas": [...],        // max 3 most relevant gotchas (frequent first)
  "recent_learnings": [...],// max 3 most relevant active learnings
  "recent_runs": [...],    // max 2 most recent run summaries
  "summary": { "total_items": 11, "repository": "..." }
}
```
