# Mind Keg MCP

A persistent memory MCP server for AI coding agents. Stores atomic learnings — debugging insights, architectural decisions, codebase conventions — so every agent session starts with relevant institutional knowledge.

## Problem

AI coding agents (Claude Code, Cursor, Windsurf) lose context between sessions. Hard-won insights are forgotten the moment a conversation ends. Developers repeatedly re-explain the same things; agents repeatedly make the same mistakes.

**Mind Keg** solves this with a centralized, persistent brain that any MCP-compatible agent can query and contribute to.

## How It Works

Mind Keg implements a **RAG (Retrieval-Augmented Generation)** pattern for AI coding agents:

1. **Retrieval** — Agent searches the brain for relevant learnings using semantic or keyword search
2. **Augmentation** — Retrieved learnings are injected into the agent's conversation context
3. **Generation** — The agent responds with awareness of past discoveries and decisions

Unlike traditional RAG systems that chunk large documents, Mind Keg stores **pre-curated atomic learnings** (max 500 chars each). No chunking strategy needed — each learning IS the retrieval unit. The agent controls both retrieval and storage, creating a feedback loop where knowledge improves over time.

## Features

- Store and retrieve atomic learnings (max 500 chars, one insight per entry)
- Semantic search with three provider options:
  - **FastEmbed** (free, local, ONNX-based — `BAAI/bge-small-en-v1.5`, 384 dims)
  - **OpenAI** (paid, best quality — `text-embedding-3-small`, 1536 dims)
  - **None** (FTS5 keyword fallback — zero external dependencies)
- Six categories: `architecture`, `conventions`, `debugging`, `gotchas`, `dependencies`, `decisions`
- Free-form tags and group linking
- Three scoping levels: repository-specific, workspace-wide, and global learnings
- Dual transport: stdio (local) + HTTP+SSE (remote)
- API key authentication with per-repository access control
- SQLite storage (zero dependencies, zero config)
- Import/export for backup and migration
- **Smarter knowledge management**: auto-categorization (KNN voting), conflict detection, smart staleness scoring, access tracking with relevance decay, near-duplicate merging, typed learning relationships
- **Enterprise security**: encryption at rest, audit logging, TTL/data retention, Prometheus monitoring, rate limiting, content integrity verification

## Quick Start

```bash
npx mindkeg-mcp init
```

That's it. This installs Mind Keg globally for your AI agent (Claude Code, Cursor, Windsurf). Open any project and your agent has persistent memory -- no API keys, no per-project setup.

For Claude Code, a SessionStart hook is also installed -- your agent loads prior knowledge automatically at the start of every session.

**Options:**

```bash
npx mindkeg-mcp init --agent cursor    # Target a specific agent
npx mindkeg-mcp init --project         # Per-project setup instead of global
```

`init` is idempotent -- safe to run multiple times. It merges with existing configs and never overwrites.

### Manual setup

If you prefer to configure manually, or need HTTP mode:

<details>
<summary>Click to expand manual setup instructions</summary>

#### Install

```bash
npm install -g mindkeg-mcp
```

#### Create an API key

```bash
mindkeg api-key create --name "My Laptop"
# Displays the key ONCE — save it securely
# mk_abc123...
```

#### Connect your AI agent

Mind Keg works with any MCP-compatible AI coding agent. Choose your setup:

**Claude Code** — Add to `~/.claude.json` or your project's `.claude/mcp.json`:

```json
{
  "mcpServers": {
    "mindkeg": {
      "command": "mindkeg",
      "args": ["serve", "--stdio"]
    }
  }
}
```

**Cursor** — Add to `.cursor/mcp.json` or global settings:

```json
{
  "mcpServers": {
    "mindkeg": {
      "command": "mindkeg",
      "args": ["serve", "--stdio"]
    }
  }
}
```

**Windsurf** — Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "mindkeg": {
      "command": "mindkeg",
      "args": ["serve", "--stdio"]
    }
  }
}
```

**HTTP mode (any MCP client):**

```bash
MINDKEG_API_KEY=mk_your_key mindkeg serve --http
# Listening on http://127.0.0.1:52100/mcp
```

```json
{
  "mcpServers": {
    "mindkeg": {
      "type": "http",
      "url": "http://127.0.0.1:52100/mcp",
      "headers": {
        "Authorization": "Bearer mk_your_key_here"
      }
    }
  }
}
```

**Other MCP-compatible agents** — Mind Keg works with any agent that supports the [Model Context Protocol](https://modelcontextprotocol.io) — including Codex CLI, Gemini CLI, GitHub Copilot, and more. Use the stdio config above adapted to your agent's MCP settings format.

#### Add Mind Keg instructions to your repository

Copy `templates/AGENTS.md` to the root of any repository where you want agents to use Mind Keg.

`AGENTS.md` is the industry standard supported by 20+ AI tools (Cursor, Windsurf, Codex, Gemini CLI, GitHub Copilot, etc.).

> **Claude Code only**: Claude Code doesn't auto-load `AGENTS.md` natively. Add `@AGENTS.md` to your `CLAUDE.md` to bridge it.

</details>

## MCP Tools

### Learnings

| Tool                 | Description                                          |
|----------------------|------------------------------------------------------|
| `get_context`        | Prime an agent session with all relevant learnings — ranked, scoped, and budget-controlled |
| `store_learning`     | Store a new atomic learning (repo, workspace, or global scope) |
| `search_learnings`   | Semantic/keyword search for relevant learnings       |
| `update_learning`    | Update content, category, or tags                    |
| `deprecate_learning` | Mark a learning as deprecated                        |
| `flag_stale`         | Flag a learning as potentially outdated               |
| `delete_learning`    | Permanently delete a learning                        |
| `merge_learnings`    | Merge near-duplicate learnings into a canonical entry |
| `relate_learnings`   | Create typed relationships between learnings          |
| `list_repositories`  | List all repositories with learning counts           |
| `list_workspaces`    | List all workspaces with learning counts             |

### Agent Memory Entities

Structured entity types for capturing decisions, findings, gotchas, and run summaries — richer than atomic learnings, designed for cross-session agent memory.

| Tool                   | Description                                          |
|------------------------|------------------------------------------------------|
| `store_decision`       | Record an architectural or design decision with rationale |
| `get_decisions`        | Retrieve decisions for a repository, optionally filtered by status |
| `supersede_decision`   | Mark a decision as superseded by a newer one         |
| `store_finding`        | Record a bug, issue, or investigation finding         |
| `get_open_findings`    | Retrieve unresolved findings for a repository         |
| `resolve_finding`      | Mark a finding as resolved with a resolution summary  |
| `store_gotcha`         | Record a non-obvious pitfall or gotcha                |
| `get_gotchas`          | Retrieve gotchas for a repository                     |
| `get_relevant_context` | Retrieve all entity types relevant to a repository    |
| `get_run_history`      | Retrieve run summaries for a repository               |
| `complete_run`         | Record the completion of an agent run with a summary  |

## CLI Commands

```bash
# Quick setup (auto-detects agent, writes config, copies instructions)
mindkeg init
mindkeg init --agent cursor

# Database statistics
mindkeg stats
mindkeg stats --json

# Start in stdio mode (for local agent connections)
mindkeg serve --stdio

# Start in HTTP mode (for remote connections)
mindkeg serve --http

# API key management
mindkeg api-key create --name "My Key"
mindkeg api-key create --name "Team Key" --repositories /repo/a /repo/b
mindkeg api-key list
mindkeg api-key revoke <prefix>

# Database
mindkeg migrate

# Near-duplicate detection (backfill existing learnings)
mindkeg dedup-scan
mindkeg dedup-scan --dry-run

# Backup and restore
mindkeg export --output backup.json
mindkeg import backup.json --regenerate-embeddings

# Data retention
mindkeg purge --older-than 90          # Purge learnings older than 90 days
mindkeg purge --repository /path/repo  # Purge all learnings for a repo
mindkeg purge --all --confirm          # Purge everything (requires --confirm)

# Encryption at rest
mindkeg encrypt-db   # Encrypt existing database (requires MINDKEG_ENCRYPTION_KEY)
mindkeg decrypt-db   # Decrypt existing database (requires MINDKEG_ENCRYPTION_KEY)

# Integrity backfill
mindkeg backfill-integrity  # Compute SHA-256 hashes for legacy learnings
```

## Configuration

| Environment Variable          | Default                      | Description                         |
|-------------------------------|------------------------------|-------------------------------------|
| `MINDKEG_SQLITE_PATH`         | `~/.mindkeg/brain.db`        | SQLite database file                |
| `MINDKEG_EMBEDDING_PROVIDER`  | `fastembed`                  | `fastembed`, `openai`, or `none`    |
| `OPENAI_API_KEY`              | (none)                       | OpenAI API key (when provider=openai)|
| `MINDKEG_HOST`                | `127.0.0.1`                  | HTTP server bind address            |
| `MINDKEG_PORT`                | `52100`                      | HTTP server port                    |
| `MINDKEG_LOG_LEVEL`           | `info`                       | `debug`, `info`, `warn`, `error`    |
| `MINDKEG_API_KEY`             | (none)                       | API key for HTTP transport (stdio is auth-free) |

### Embedding providers

**FastEmbed (default, free, local)**

Semantic search works out of the box using FastEmbed — no API key needed, no network calls. Uses `BAAI/bge-small-en-v1.5` (384 dimensions) via local ONNX Runtime. Model files are downloaded once on first use (~50MB).

**OpenAI (paid, best quality)**

```bash
export MINDKEG_EMBEDDING_PROVIDER=openai
export OPENAI_API_KEY=sk-...
```

Uses `text-embedding-3-small` (1536 dimensions). Best semantic search quality but requires an API key and incurs per-request costs.

**None (keyword search only)**

```bash
export MINDKEG_EMBEDDING_PROVIDER=none
```

Disables semantic search and falls back to SQLite FTS5 full-text search — all other features work identically.

## Enterprise Security

Mind Keg ships a suite of security features suitable for corporate and regulated environments.

### Encryption at Rest

Encrypt `content` and `embedding` fields using AES-256-GCM. All other fields (category, tags, timestamps) remain plaintext.

```bash
# Generate a 256-bit key
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

export MINDKEG_ENCRYPTION_KEY=<your-base64-key>
mindkeg serve --stdio
```

To encrypt an existing database in-place:

```bash
MINDKEG_ENCRYPTION_KEY=<key> mindkeg encrypt-db
# Creates a backup automatically before operating
```

> **Note**: FTS5 keyword search does not work when encryption is enabled. Use FastEmbed or OpenAI embedding providers for search.

### Audit Logging

All MCP tool invocations are written to a structured JSON lines audit log (SIEM-compatible).

```bash
export MINDKEG_AUDIT_LOG=~/.mindkeg/audit.jsonl  # default
# Or: MINDKEG_AUDIT_LOG=stderr  (write to stderr alongside app logs)
# Or: MINDKEG_AUDIT_LOG=none    (disable)
```

Each audit entry contains: `timestamp` (ISO 8601), `action`, `actor` (API key prefix), `resource_id`, `result`, `client` transport metadata. Sensitive fields (`content`, `embedding`) are never logged.

### TTL and Data Retention

Set a global default TTL or a per-learning TTL to automatically expire old entries.

```bash
export MINDKEG_DEFAULT_TTL_DAYS=365    # Expire all learnings after 1 year by default
export MINDKEG_PURGE_INTERVAL_HOURS=24 # Run purge every 24 hours (default)
```

Per-learning TTL overrides the global default:

```json
{ "content": "...", "ttl_days": 30 }
```

Manual purge:

```bash
mindkeg purge --older-than 180 --confirm
```

### Monitoring

HTTP transport exposes Prometheus-compatible endpoints:

```
GET /health   → JSON: { status, version, uptime, database }
GET /metrics  → Prometheus text format
```

Both endpoints are unauthenticated by default. Set `MINDKEG_METRICS_AUTH=true` to require API key auth.

Metrics exposed: `mindkeg_learnings_total`, `mindkeg_tool_invocations_total`, `mindkeg_tool_duration_seconds`, `mindkeg_errors_total`, `mindkeg_uptime_seconds`, `mindkeg_search_latency_seconds`.

### Rate Limiting

HTTP transport enforces per-API-key token bucket rate limits with separate write and read buckets.

```bash
export MINDKEG_RATE_LIMIT_WRITE_RPM=100  # default: 100 write req/min per key
export MINDKEG_RATE_LIMIT_READ_RPM=300   # default: 300 read req/min per key
```

Returns HTTP 429 with `Retry-After` header when exceeded. stdio transport is not rate-limited.

### Supply Chain Security

- npm packages published with `--provenance` (Sigstore attestation via GitHub Actions)
- CycloneDX SBOM generated and uploaded as a release asset on every GitHub release
- Cosign signatures for npm tarballs uploaded as release assets

### Content Integrity

SHA-256 integrity hashes are computed and stored for every learning on write. Verify on demand:

```json
{ "query": "...", "verify_integrity": true }
```

Each result includes `integrity_valid: true | false | null` (`null` for legacy learnings without a stored hash).

Backfill integrity hashes for existing learnings:

```bash
mindkeg backfill-integrity
```

## Data Model

Each learning contains:

| Field             | Type              | Notes                                                       |
|-------------------|-------------------|-------------------------------------------------------------|
| `id`              | UUID              | Auto-generated                                              |
| `content`         | string (max 500)  | The atomic learning text (sanitized on write)               |
| `category`        | enum              | One of 6 categories                                         |
| `tags`            | string[]          | Free-form labels                                            |
| `repository`      | string or null    | Repo path; null = workspace or global                       |
| `workspace`       | string or null    | Workspace path; null = repo-specific or global              |
| `group_id`        | UUID or null      | Link related learnings                                      |
| `source`          | string            | Who created this (e.g., "claude-code")                      |
| `status`          | enum              | `active` or `deprecated`                                    |
| `stale_flag`      | boolean           | Agent-flagged as potentially outdated                       |
| `ttl_days`        | integer or null   | Per-learning TTL; overrides global `MINDKEG_DEFAULT_TTL_DAYS` |
| `source_agent`    | string or null    | Agent name for provenance tracking                          |
| `integrity_hash`  | string or null    | SHA-256 hash of canonical fields for tamper detection       |
| `access_count`    | integer           | Times returned by search/get_context (feeds ranking)        |
| `last_accessed_at`| ISO 8601 or null  | Last time returned by search/get_context                    |
| `staleness_score` | float 0.0–1.0     | Auto-computed from age, access recency, and conflicts       |
| `created_at`      | ISO 8601          | Auto-set on creation                                        |
| `updated_at`      | ISO 8601          | Auto-updated on modification; TTL expiry anchors to this    |

## Scoping

Learnings have three scope levels:

| Scope | `repository` | `workspace` | Visible where |
|-------|-------------|-------------|---------------|
| **Repo-specific** | set | null | Only that repo |
| **Workspace-wide** | null | set | All repos in the same parent folder |
| **Global** | null | null | Everywhere |

**Workspaces are auto-detected** from the parent folder of a repository path. For example, if your repos are organized as:

```
repositories/
  personal/     ← workspace
    app-a/
    app-b/
  work/          ← workspace
    project-x/
```

A workspace learning stored under `repositories/personal/` is shared across `app-a` and `app-b` but not `project-x`.

When searching, results include all three scopes: repo-specific + workspace + global. Each result has a `scope` field indicating its level.

## What Makes a Good Learning?

- **Atomic**: One insight per entry. Max 500 characters.
- **Actionable**: What to DO or AVOID, not just what exists.
- **Specific**: Mentions the concrete context (library, pattern, file).

**Good**: "Always wrap Prisma queries in try/catch — it throws on constraint violations, not returns null."

**Bad**: "Be careful with the database." (too vague)

## Development

```bash
# Clone and install
git clone ...
npm install

# Run tests
npm test

# Build
npm run build

# Development mode (rebuilds on change)
npm run dev

# Type check
npm run typecheck
```

### Running without external APIs

Mind Keg works fully offline by default. FastEmbed provides free, local semantic search using ONNX Runtime — no API keys or network calls required. All CRUD operations and search work out of the box.

## Architecture

```
CLI (Commander.js)
  └── init / stats / serve / api-key / migrate / export / import / dedup-scan
      purge / encrypt-db / decrypt-db / backfill-integrity

src/
  index.ts          Entry point, stdio + HTTP transports
  server.ts         MCP server + tool registration
  config.ts         Config loading (env vars → defaults)
  audit/            Structured JSON lines audit logger
  auth/             API key generation + validation middleware
  crypto/           AES-256-GCM field encryption
  monitoring/       Prometheus metrics + /health endpoint
  security/         Content sanitization, integrity hashing, rate limiter
  tools/            MCP tool handlers (8 consolidated + 19 backwards-compatible aliases)
  services/         LearningService + EmbeddingService + PurgeService + ConflictDetector + StalenessEngine
  storage/          StorageAdapter interface + SQLite impl
  models/           Zod schemas + TypeScript types
  utils/            Logger (pino → stderr) + error classes

templates/
  AGENTS.md         Template for instructing agents to use Mind Keg
```

See `CLAUDE.md` for detailed development conventions.

## License

MIT
