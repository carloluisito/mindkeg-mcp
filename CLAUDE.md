# Mind Keg MCP — Development Guide for AI Agents

This file provides persistent context for AI agents (Claude Code, Cursor, Windsurf, etc.) working on this codebase.
**This project dogfoods its own concept**: it IS a persistent memory system for agents, and we use it on itself.

## Project Overview

Mind Keg MCP is a TypeScript/Node.js MCP server that stores, searches, and retrieves atomic developer learnings.
It is designed to give AI agents persistent memory across sessions.

- **Transport**: stdio (local) + HTTP+SSE (remote)
- **Storage**: SQLite
- **Search**: Semantic (FastEmbed local ONNX or OpenAI embeddings) with FTS5 fallback when no embedding provider is configured
- **Auth**: API key-based (SHA-256 hashed, never stored in plaintext)

## Architecture at a Glance

```
CLI (Commander.js)
  └── init / stats / serve / api-key / migrate / export / import

src/index.ts            Entry point, transport setup
src/server.ts           MCP server, tool registration
src/config.ts           Config loading (env vars → defaults)
src/auth/               API key generation + middleware
src/tools/              One file per MCP tool (8 tools)
src/services/           Business logic (LearningService, EmbeddingService)
src/storage/            StorageAdapter interface + SQLite impl
src/models/             Zod schemas + TypeScript types
src/utils/              Logger (pino → stderr) + custom error classes
templates/AGENTS.md     Template users copy to their repos
tests/unit/             Vitest unit tests
tests/integration/      Vitest integration tests (SQLite, full flow)
```

## Critical Conventions

### TypeScript
- Strict mode enabled (`strict: true` in tsconfig)
- ESM modules only (`"type": "module"` in package.json)
- No `any` types — use `unknown` then narrow with type guards
- Zod schemas are the source of truth for runtime validation
- All public functions and interfaces have JSDoc comments

### Error Handling
- Always throw typed errors from `src/utils/errors.ts`
- Never throw raw strings or generic `new Error()`
- MCP tool handlers catch all errors and return structured MCP error responses
- Log errors at `error` level before returning to client

### Storage
- All SQL uses parameterized queries (never string interpolation)
- SQLite: Node.js 22 built-in `node:sqlite` (`DatabaseSync`) — no npm install, no native build required
  - Uses `--experimental-sqlite` flag (enabled by default in Node 22+)
  - The module is synchronous, like `better-sqlite3`; do NOT use async/await for DB ops
- Tags stored as JSON text in SQLite
- Embedding stored as JSON text (float array) in SQLite

### Logging
- Logger writes to **stderr** (`fd 2`) — never stdout — because stdout is used for MCP stdio protocol
- Use `getLogger()` from `src/utils/logger.ts`
- Log levels: debug (verbose), info (operational), warn (degraded), error (failure)
- Never log API keys, even partially (except the public prefix)

### Testing
- Test runner: `vitest`
- Run tests: `npm test`
- Watch mode: `npm run test:watch`
- Integration tests use an in-memory or temp-file SQLite database
- Tests should NOT require external services (OpenAI) unless explicitly tagged

### Build
- Build: `npm run build` (uses tsup)
- Output: `dist/` directory
- Two entry points: `dist/index.js` (server) and `dist/cli/index.js` (CLI)
- No external packages excluded from bundling

## MCP Tools Exposed

| Tool               | Description                                      |
|--------------------|--------------------------------------------------|
| store_learning     | Store a new atomic learning                      |
| search_learnings   | Semantic/keyword search for relevant learnings   |
| update_learning    | Update content, category, tags of a learning     |
| deprecate_learning | Mark a learning as deprecated                    |
| flag_stale         | Flag a learning as potentially outdated           |
| delete_learning    | Permanently delete a learning                    |
| list_repositories  | List all repos with learning counts              |
| list_workspaces    | List all workspaces with learning counts         |

## Data Model Key Points

- `content`: max 500 characters (enforced by Zod + DB constraint)
- `category`: exactly one of: architecture, conventions, debugging, gotchas, dependencies, decisions
- `repository`: null = global or workspace-scoped learning; set = repo-specific learning
- `workspace`: null = repo-specific or global learning; set = workspace-scoped learning (mutually exclusive with `repository`)
- Scope truth table: `repository` set → repo-specific; `workspace` set → workspace-wide; both null → global; both set → invalid
- `status`: active (default) | deprecated (excluded from search by default)
- `stale_flag`: boolean, set when an agent thinks a learning may be outdated
- `embedding`: float[] stored as JSON text in SQLite (384 dims for FastEmbed, 1536 dims for OpenAI)

## Configuration (Environment Variables)

| Variable                     | Default                    | Description                     |
|------------------------------|----------------------------|---------------------------------|
| MINDKEG_SQLITE_PATH          | ~/.mindkeg/brain.db        | SQLite database file path       |
| MINDKEG_EMBEDDING_PROVIDER   | fastembed                  | "fastembed", "openai", or "none"|
| OPENAI_API_KEY               | (none)                     | OpenAI API key (when provider=openai) |
| MINDKEG_HOST                 | 127.0.0.1                  | HTTP server bind address        |
| MINDKEG_PORT                 | 52100                      | HTTP server port                |
| MINDKEG_LOG_LEVEL            | info                       | debug / info / warn / error     |
| MINDKEG_API_KEY              | (none)                     | API key for stdio transport     |

## Embedding Providers

- **`fastembed`** (default): Free, local ONNX-based embeddings via `BAAI/bge-small-en-v1.5` (384 dims). No API key needed. Model downloaded on first use (~50MB).
- **`openai`**: OpenAI `text-embedding-3-small` (1536 dims). Requires `OPENAI_API_KEY`. Best semantic quality.
- **`none`**: FTS5 keyword search fallback. No embeddings generated. A warning is logged at startup.

All CRUD operations work identically regardless of provider. Only search quality differs.

## Known Gotchas

- SQLite uses Node.js 22 built-in `node:sqlite` (`DatabaseSync`) — synchronous, do NOT use `await` on DB calls
- `pino` logger destination must be stderr (fd 2) or stdio transport breaks
- API keys are displayed ONCE at creation — they are never retrievable afterward
- FTS5 trigger maintenance: insert/update/delete on `learnings` must sync `learnings_fts`
- Port 52100 is the default HTTP port — document this clearly for firewall rules