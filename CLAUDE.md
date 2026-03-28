# Mind Keg MCP — Development Guide for AI Agents

This file provides persistent context for AI agents (Claude Code, Cursor, Windsurf, etc.) working on this codebase.
**This project dogfoods its own concept**: it IS a persistent memory system for agents, and we use it on itself.

## Project Overview

Mind Keg MCP is a TypeScript/Node.js MCP server that stores, searches, and retrieves atomic developer learnings.
It is designed to give AI agents persistent memory across sessions.

- **Version**: 0.6.1
- **Runtime**: Node.js >= 22 (uses built-in `node:sqlite`)
- **Transport**: stdio (local) + HTTP+SSE (remote)
- **Storage**: SQLite via `node:sqlite` (`DatabaseSync` — synchronous)
- **Search**: Semantic (FastEmbed local ONNX or OpenAI embeddings) with FTS5 fallback when no embedding provider is configured
- **Auth**: API key-based (SHA-256 hashed, never stored in plaintext)
- **License**: MIT

### Repository Layout

```
cli/
  index.ts              CLI entry point (Commander.js)
  commands/
    api-key.ts          API key management (generate, list, revoke)
    backfill-integrity.ts Compute and store integrity hashes for existing learnings
    decrypt-db.ts       Decrypt database content/embedding fields in-place
    dedup-scan.ts       Backfill duplicate_candidates for existing learnings
    encrypt-db.ts       Encrypt database content/embedding fields in-place
    export.ts           Export learnings to JSON
    import.ts           Import learnings from JSON
    init.ts             Project setup (copies AGENTS.md template)
    migrate.ts          Run database migrations
    purge.ts            Purge expired or filtered learnings
    serve.ts            Start stdio or HTTP server
    stats.ts            Database statistics

src/
  index.ts              Server entry point, transport setup
  server.ts             MCP server, tool registration
  config.ts             Config loading (env vars → Zod-validated defaults)
  audit/
    audit-logger.ts     Structured JSON lines audit log writer (AuditLogger class)
    index.ts            Audit barrel export
  auth/
    api-key.ts          API key generation (crypto.randomBytes + SHA-256)
    middleware.ts        API key validation middleware
  crypto/
    encryption.ts       AES-256-GCM field encryption (encrypt, decrypt, isEncrypted, parseEncryptionKey)
    index.ts            Crypto barrel export
  monitoring/
    health.ts           GET /health handler (status, version, uptime, DB connectivity)
    metrics.ts          Prometheus metrics registry and metric definitions (prom-client)
    index.ts            Monitoring barrel export
  security/
    integrity.ts        SHA-256 integrity hash computation and verification
    rate-limiter.ts     In-memory token bucket rate limiter (per-key, read/write buckets)
    sanitize.ts         Content sanitization (strip control chars, reject whitespace-only)
    index.ts            Security barrel export
  tools/                One file per MCP tool (11 tools)
    store-learning.ts
    search-learnings.ts
    update-learning.ts
    deprecate-learning.ts
    delete-learning.ts
    flag-stale.ts
    list-repositories.ts
    list-workspaces.ts
    get-context.ts
    merge-learnings.ts  MCP tool: merge_learnings
    relate-learnings.ts MCP tool: relate_learnings
    tool-utils.ts       Shared tool utilities (getActorFromApiKey, recordToolMetrics)
  services/
    learning-service.ts Business logic for CRUD + search + getContext
    embedding-service.ts Embedding provider abstraction
    purge-service.ts    Orchestrates TTL-based and filter-based purge operations
    conflict-detector.ts Keyword-heuristic conflict detection
    staleness-engine.ts Staleness score computation and periodic recomputation
    ranking.ts          Pure ranking function for get_context
    budget.ts           Pure budget allocation/trimming for get_context
    index.ts            Service barrel export
  storage/
    storage-adapter.ts  StorageAdapter interface
    sqlite-adapter.ts   SQLite implementation
    storage-factory.ts  Factory for creating adapters
    migrations/
      001-initial.ts    Initial schema + FTS5 triggers
      002-duplicate-candidates.ts  Near-duplicate detection table
      003-ttl-and-provenance.ts    ttl_days, source_agent, integrity_hash columns
      004-smarter-knowledge-management.ts  SKM schema migration (access tracking, conflicts, relationships, staleness)
  models/
    learning.ts         Zod schemas + TypeScript types (core entity)
    repository.ts       Repository model
    workspace.ts        Workspace model (WS-AC-4)
    index.ts            Model barrel export
  utils/
    errors.ts           Typed error classes (MindKegError hierarchy)
    logger.ts           Pino logger → stderr
    index.ts            Utils barrel export

templates/
  AGENTS.md             Template users copy to their repos via `mindkeg init`

tests/
  unit/
    audit-logger.test.ts
    auth.test.ts
    budget.test.ts
    embedding-service.test.ts
    encryption.test.ts
    get-context.test.ts
    init.test.ts
    integrity.test.ts
    learning-service.test.ts
    migration-003.test.ts
    models.test.ts
    monitoring.test.ts
    purge-service.test.ts
    ranking.test.ts
    rate-limiter.test.ts
    sanitize.test.ts
    stats.test.ts
    workspace.test.ts
  integration/
    audit.test.ts
    backfill-integrity.test.ts
    e2e-sqlite.test.ts
    encryption.test.ts
    get-context.test.ts
    migration-003.test.ts
    provenance.test.ts
    purge.test.ts
    sqlite-adapter.test.ts

.github/workflows/
  ci.yml                CI: typecheck → lint → test → build (Node 22, ubuntu + windows)
  publish.yml           Publish to npm on GitHub release (with provenance)
```

## Code Conventions

### TypeScript
- Strict mode enabled (`strict: true`, `noUncheckedIndexedAccess: true` in tsconfig)
- ESM modules only (`"type": "module"` in package.json)
- Target: ES2022, module: ESNext, moduleResolution: bundler
- No `any` types — use `unknown` then narrow with type guards. ESLint warns on `@typescript-eslint/no-explicit-any`.
- Zod schemas are the source of truth for runtime validation
- All public functions and interfaces have JSDoc comments
- Path alias: `@/*` maps to `./src/*` (configured in tsconfig, resolved by tsup)

### Naming Patterns
- **Files**: kebab-case (`learning-service.ts`, `store-learning.ts`, `api-key.ts`)
- **Functions**: camelCase (`createMcpServer`, `registerStoreLearning`, `loadConfig`)
- **Interfaces/Types**: PascalCase (`StorageAdapter`, `Learning`, `LearningWithScore`)
- **Constants**: UPPER_SNAKE_CASE (`LEARNING_CATEGORIES`, `LEARNING_STATUSES`)
- **Zod schemas**: PascalCase with `Schema` suffix (`CreateLearningInputSchema`, `ConfigSchema`)
- **Test files**: Same name as source + `.test.ts` suffix (`models.test.ts`, `auth.test.ts`)

### Error Handling
- Always throw typed errors from `src/utils/errors.ts` — never raw strings or generic `new Error()`
- Error hierarchy: `MindKegError` (base) → `ValidationError`, `AuthError`, `AccessError`, `NotFoundError`, `EmbeddingError`, `StorageError`
- Each error has a `code` field (`ErrorCode` union type) and optional `details`
- MCP tool handlers catch all errors and return structured MCP error responses
- Log errors at `error` level before returning to client
- Type guard: `isMindKegError(err)` for narrowing

### Import Ordering
- Node.js built-ins first (`node:sqlite`, `node:crypto`, `node:path`)
- External packages second (`zod`, `commander`, `pino`, `@modelcontextprotocol/sdk`)
- Internal imports third with `.js` extension (required for ESM: `./tools/store-learning.js`)

### Module Organization
- One MCP tool per file in `src/tools/`
- Each tool file exports a `register*` function that takes `(server, learningService, storage, getApiKey)`
- Services hold business logic; tools are thin wrappers that parse input, call service, format response
- Storage adapter is interface-based for backend swappability
- Barrel exports (`index.ts`) in `services/`, `models/`, `utils/`

## Style & Formatting

- **ESLint config**: `.eslintrc.cjs` — extends `eslint:recommended` + `@typescript-eslint/recommended`
- **Key rules**:
  - `@typescript-eslint/no-explicit-any`: warn
  - `@typescript-eslint/explicit-function-return-type`: off
  - `@typescript-eslint/no-unused-vars`: error (with `argsIgnorePattern: '^_'` — prefix unused args with `_`)
  - `no-console`: off
- **No Prettier config** — formatting follows ESLint defaults and editor settings
- **No `.editorconfig`** detected

## Build, Run & Test Commands

### Prerequisites
- Node.js >= 22
- npm (package manager)
- Set `ONNX_RUNTIME_NODE_INSTALL_CUDA=skip` during `npm ci` to avoid CUDA binary download failures

### Commands

| Task | Command |
|---|---|
| Install dependencies | `npm ci` (CI) or `npm install` (dev) |
| Build | `npm run build` (uses tsup) |
| Dev (watch mode) | `npm run dev` (tsup --watch) |
| Run tests | `npm test` (vitest run) |
| Test watch mode | `npm run test:watch` (vitest) |
| Test with coverage | `npm run test:coverage` (vitest --coverage, v8 provider) |
| Lint | `npm run lint` (eslint src cli tests) |
| Typecheck | `npm run typecheck` (tsc --noEmit) |
| Serve (stdio) | `npm run serve:stdio` |
| Serve (HTTP) | `npm run serve:http` |

### Build Details
- **Bundler**: tsup (`tsup.config.ts`)
- **Format**: ESM only
- **Target**: node22
- **Output**: `dist/` directory
- **Entry points**: `src/index.ts` (server), `cli/index.ts` (CLI), plus subpath exports for `storage`, `services`, `models`, `utils`, `server`
- **DTS**: true (generates `.d.ts` files)
- **Sourcemaps**: true
- **Splitting**: false
- **Bundle**: true (all dependencies bundled)

### CLI Commands
The `mindkeg` CLI (`dist/cli/index.js`) provides:

| Command | Description |
|---|---|
| `mindkeg serve --stdio` | Start MCP server over stdio |
| `mindkeg serve --http` | Start MCP server over HTTP+SSE |
| `mindkeg api-key` | Generate, list, or revoke API keys |
| `mindkeg migrate` | Run database migrations |
| `mindkeg export` | Export learnings to JSON |
| `mindkeg import` | Import learnings from JSON |
| `mindkeg init` | Set up a project (copies AGENTS.md template) |
| `mindkeg stats` | Display database statistics |
| `mindkeg dedup-scan` | Backfill duplicate_candidates table for existing learnings |
| `mindkeg purge` | Purge expired or filtered learnings (`--older-than`, `--repository`, `--workspace`, `--all`, `--confirm`) |
| `mindkeg encrypt-db` | Encrypt all content/embedding fields in-place (backup + transaction, requires `MINDKEG_ENCRYPTION_KEY`) |
| `mindkeg decrypt-db` | Decrypt all content/embedding fields in-place (backup + transaction, requires `MINDKEG_ENCRYPTION_KEY`) |
| `mindkeg backfill-integrity` | Compute and store SHA-256 integrity hashes for learnings that have `integrity_hash = NULL` |

## Testing Standards

- **Runner**: Vitest
- **Test locations**: `tests/unit/` and `tests/integration/`
- **Naming**: `<module>.test.ts` matching source module names
- **Integration tests**: Use in-memory or temp-file SQLite databases — no external services required
- **Coverage provider**: `@vitest/coverage-v8`
- **Mocking**: Tests should NOT require external services (OpenAI) unless explicitly tagged
- **Running a single test file**: `npx vitest run tests/unit/models.test.ts`
- **Running a single test by name**: `npx vitest run -t "test name pattern"`

## Git & PR Conventions

### Commit Messages
Conventional Commits style observed in recent history:
- `feat:` — new feature (`feat: add mindkeg stats command`)
- `fix:` — bug fix (`fix: skip CUDA binary download in CI`)
- `docs:` — documentation changes
- `ci:` — CI configuration
- `release:` — version releases

### Branch Strategy
- Main branch: `main`
- Feature branches merged to `main`

### CI Pipeline
CI runs on push to `main` and pull requests to `main`:
1. Typecheck (`npm run typecheck`)
2. Lint (`npm run lint`)
3. Test (`npm test`)
4. Build (`npm run build`)

Matrix: Ubuntu + Windows, Node.js 22.

### Publishing
- npm publish triggered by GitHub release events
- Includes `--provenance` flag for supply chain security
- Published with `--access public`

## Architecture & Patterns

### Design Patterns
- **Interface-based storage**: `StorageAdapter` interface with SQLite implementation. Allows future backend swaps.
- **Service layer**: `LearningService` encapsulates business logic (validation, embedding generation, CRUD orchestration). Tools are thin.
- **Factory pattern**: `storage-factory.ts` creates the appropriate adapter based on config.
- **Dependency injection**: `createMcpServer(deps)` receives storage, embedding, auth, audit, and metrics dependencies.
- **Zod validation**: All external input validated through Zod schemas before reaching business logic.
- **Shared tool utilities**: `src/tools/tool-utils.ts` provides `getActorFromApiKey` and `recordToolMetrics` used by all tool handlers.

### Encryption at Rest
- Implemented in `src/crypto/encryption.ts` using `node:crypto` AES-256-GCM (no native dependencies)
- Only `content` and `embedding` fields are encrypted; metadata (category, tags, timestamps) remains plaintext
- Storage format: `<iv_b64>:<ciphertext_b64>:<auth_tag_b64>` — each write gets a unique random 12-byte IV
- Conditioned on `MINDKEG_ENCRYPTION_KEY` presence — no performance penalty when key is not set
- FTS5 keyword search does NOT work with encrypted content; requires semantic search via embeddings (see Common Pitfalls)
- `mindkeg encrypt-db` / `mindkeg decrypt-db` CLI commands migrate existing databases; both create a backup before operating inside a single transaction

### Audit Logging
- Implemented in `src/audit/audit-logger.ts` as the `AuditLogger` class
- Structured JSON lines (one entry per line, ISO 8601 timestamps) — SIEM-compatible
- Destination configurable via `MINDKEG_AUDIT_LOG`: file path (append-only), `"stderr"`, or `"none"` (disabled)
- `AuditEntry` fields: `timestamp`, `action`, `actor` (API key prefix or "stdio"), `resource_id`, `result`, `error_code`, `client`, `metadata`
- Sensitive fields (`content`, `embedding`) are never included in audit entries
- Audit failures are non-fatal: logged as warnings, never propagate to the primary operation

### Monitoring
- Implemented in `src/monitoring/` using `prom-client` (Prometheus client library)
- `/health` endpoint (GET): returns JSON with `status`, `version`, `uptime`, `database` connectivity — HTTP 200 or 503
- `/metrics` endpoint (GET): returns Prometheus text format scrape output
- Both endpoints bypass API key authentication by default; set `MINDKEG_METRICS_AUTH=true` to require auth
- Metrics defined: `mindkeg_learnings_total` (gauge), `mindkeg_tool_invocations_total` (counter), `mindkeg_tool_duration_seconds` (histogram), `mindkeg_errors_total` (counter), `mindkeg_uptime_seconds` (gauge), `mindkeg_search_latency_seconds` (histogram)

### Rate Limiting
- Implemented in `src/security/rate-limiter.ts` as the `RateLimiter` class (token bucket algorithm)
- HTTP transport only — stdio transport is local and does not need rate limiting
- Per-API-key-prefix isolation: each key has independent write and read buckets
- Write tools (`store_learning`, `update_learning`, `delete_learning`, `deprecate_learning`, `flag_stale`): governed by `MINDKEG_RATE_LIMIT_WRITE_RPM` (default 100)
- Read tools (`search_learnings`, `get_context`, `list_repositories`, `list_workspaces`): governed by `MINDKEG_RATE_LIMIT_READ_RPM` (default 300)
- Returns HTTP 429 with `Retry-After` header when a bucket is exhausted
- State is in-memory and resets on server restart

### Content Security
- Sanitization (`src/security/sanitize.ts`): strips control characters (U+0000-U+001F except LF/CR), rejects whitespace-only content; integrated into Zod `CreateLearningInputSchema` and `UpdateLearningInputSchema` via `.transform()` / `.superRefine()`
- Integrity hashing (`src/security/integrity.ts`): SHA-256 over `content|category|sorted_tags_json|repository|workspace`; computed on every store/update and stored as `integrity_hash`; verifiable on-demand via `verify_integrity` parameter on `search_learnings` and `get_context`
- Provenance tracking: `source_agent` field on learnings records which agent created/updated the entry

### Storage
- All SQL uses parameterized queries (never string interpolation)
- SQLite: Node.js 22 built-in `node:sqlite` (`DatabaseSync`) — synchronous, like `better-sqlite3`
  - Uses `--experimental-sqlite` flag (enabled by default in Node 22+)
  - Do NOT use `async/await` for DB operations
- Tags stored as JSON text in SQLite
- Embedding stored as JSON text (float array) in SQLite
- FTS5 triggers maintain `learnings_fts` table on insert/update/delete

### MCP Tools Exposed

| Tool | Description |
|---|---|
| store_learning | Store a new atomic learning |
| search_learnings | Semantic/keyword search for relevant learnings |
| update_learning | Update content, category, tags of a learning |
| deprecate_learning | Mark a learning as deprecated |
| flag_stale | Flag a learning as potentially outdated |
| delete_learning | Permanently delete a learning |
| list_repositories | List all repos with learning counts |
| list_workspaces | List all workspaces with learning counts |
| get_context | Prime an agent session with all relevant learnings — ranked, partitioned by scope, and budget-trimmed |
| merge_learnings | Merge near-duplicate learnings into a canonical entry |
| relate_learnings | Create typed relationships between learnings |

### Data Model

- `content`: max 500 characters (enforced by Zod + DB constraint); sanitized to strip control characters on write
- `category`: optional; one of: `architecture`, `conventions`, `debugging`, `gotchas`, `dependencies`, `decisions`; omitting triggers auto-categorization (requires an embedding provider — see Common Pitfalls)
- `repository`: null = global or workspace-scoped; set = repo-specific
- `workspace`: null = repo-specific or global; set = workspace-scoped (mutually exclusive with `repository`)
- Scope truth table: `repository` set → repo-specific; `workspace` set → workspace-wide; both null → global; both set → invalid (Zod refine rejects)
- `status`: `active` (default) | `deprecated` (excluded from search by default)
- `stale_flag`: boolean, set when an agent thinks a learning may be outdated
- `embedding`: float[] stored as JSON text (384 dims for FastEmbed, 1536 dims for OpenAI)
- `scope` field on `LearningWithScore`: `'repo' | 'workspace' | 'global'` — annotated on search results
- `ttl_days`: nullable integer; overrides global default TTL for this learning; null = use global default or no expiry
- `source_agent`: nullable string; agent name that created/last updated the learning (provenance tracking)
- `integrity_hash`: nullable string; SHA-256 hex hash of canonical fields for tamper detection; null for legacy learnings
- `access_count`: integer (default 0); incremented each time the learning is returned by `search_learnings` or `get_context`; feeds ranking and staleness scoring
- `last_accessed_at`: nullable ISO 8601 timestamp; set on every search/get_context hit; null if the learning has never been returned
- `staleness_score`: float 0.0–1.0 (default 0.0); computed from three weighted signals — age (weight 0.3), access recency (weight 0.4), and unresolved conflicts (weight 0.3); recomputed periodically; learnings with score ≥ 0.7 are auto-flagged as stale; manually calling `flag_stale` sets score to 1.0
- `learning_conflicts` table: stores keyword-heuristic contradictions between two learnings; fields: `id`, `learning_id_a`, `learning_id_b`, `similarity`, `conflict_type`, `resolved`, `resolved_by`, `created_at`; foreign keys ON DELETE CASCADE; unique pair index enforces one row per ordered pair
- `learning_relationships` table: typed directed edges between learnings; fields: `id`, `source_id`, `target_id`, `relationship_type` (one of `supersedes`, `depends_on`, `related_to`, `caused_by`), `created_at`, `created_by`; foreign keys ON DELETE CASCADE; unique index on `(source_id, target_id, relationship_type)` prevents duplicate relationships

### Conflict Detection
- Implemented in `src/services/conflict-detector.ts` as a pure `detectConflicts()` function (no side effects)
- Keyword heuristic: checks for opposing negation vs. assertion signal words (e.g., "never" vs. "always") within learning content
- Similarity threshold: only candidates with cosine similarity ≥ 0.85 (from `findScopedNeighbors`) are passed to the detector
- Scope gate: candidate must share at least one tag with the new learning OR belong to the same category — prevents cross-domain false positives
- Detected conflicts are stored in the `learning_conflicts` table and returned in the `store_learning` response
- Auto-resolution: when a learning with unresolved conflicts is deprecated or its content is updated, conflicts are automatically resolved or re-evaluated
- `get_context` surfaces unresolved conflicts for all returned learnings in a top-level `conflicts` array

### Smart Staleness
- Implemented in `src/services/staleness-engine.ts`
- Weighted three-signal formula: `staleness_score = 0.3 * age_factor + 0.4 * access_factor + 0.3 * conflict_factor`
- `age_factor`: days since `updated_at`, normalized
- `access_factor`: days since `last_accessed_at` (falls back to `created_at` if never accessed), normalized
- `conflict_factor`: presence and count of unresolved conflicts
- Periodic recomputation: `recomputeAllStalenessScores()` runs on the same interval as the TTL purge (`MINDKEG_PURGE_INTERVAL_HOURS`, default 24h) and once at server startup
- Auto-flag: when recomputed `staleness_score >= 0.7`, `stale_flag` is also set to `true`
- Manual override: calling `flag_stale` sets `staleness_score = 1.0` immediately

### Access Tracking
- `access_count` and `last_accessed_at` are updated via a single `recordAccess(ids)` call after every `search_learnings` or `get_context` response
- Access tracking is non-fatal: errors are caught and logged as warnings; they never block the search/context response
- Both fields are included in all search and get_context responses so consumers can observe access patterns
- Access data feeds two ranking signals in `ranking.ts`: access frequency boost (higher `access_count` = ranked higher) and access recency boost (more recently accessed = ranked higher)

### Auto-Categorization
- When `category` is omitted from `store_learning`, the service runs KNN voting using the top K=5 nearest neighbors from `findScopedNeighbors`
- Voting: the category with the most votes among the 5 neighbors wins; ties are broken by highest average cosine similarity among tied-category neighbors
- Minimum neighbor threshold: if fewer than 3 neighbors are available, a `ValidationError` is thrown — the caller must supply an explicit category
- Requires an embedding provider: auto-categorization fails with `ValidationError` when `MINDKEG_EMBEDDING_PROVIDER=none`
- `store_learning` response includes `auto_categorized: boolean` to indicate whether the category was inferred
- `findScopedNeighbors` (implemented in `sqlite-adapter.ts`) performs a single embedding scan that is shared by dedup detection, conflict detection, and auto-categorization — no redundant scans

### Logging
- Logger writes to **stderr** (`fd 2`) — never stdout — because stdout is used for MCP stdio protocol
- Use `getLogger()` from `src/utils/logger.ts`
- Log levels: debug (verbose), info (operational), warn (degraded), error (failure)
- Never log API keys, even partially (except the public prefix)

## Configuration (Environment Variables)

| Variable | Default | Description |
|---|---|---|
| MINDKEG_SQLITE_PATH | ~/.mindkeg/brain.db | SQLite database file path |
| MINDKEG_EMBEDDING_PROVIDER | fastembed | `"fastembed"`, `"openai"`, or `"none"` |
| OPENAI_API_KEY | (none) | OpenAI API key (when provider=openai) |
| MINDKEG_HOST | 127.0.0.1 | HTTP server bind address |
| MINDKEG_PORT | 52100 | HTTP server port |
| MINDKEG_LOG_LEVEL | info | debug / info / warn / error |
| MINDKEG_API_KEY | (none) | API key for stdio transport |
| MINDKEG_ENCRYPTION_KEY | (none) | Base64-encoded 256-bit key for AES-256-GCM content/embedding encryption |
| MINDKEG_AUDIT_LOG | ~/.mindkeg/audit.jsonl | Audit log destination: file path, `"stderr"`, or `"none"` |
| MINDKEG_DEFAULT_TTL_DAYS | (none) | Global default TTL in days; null = no automatic expiration |
| MINDKEG_PURGE_INTERVAL_HOURS | 24 | How often (hours) the server runs automatic purge of expired learnings |
| MINDKEG_RATE_LIMIT_WRITE_RPM | 100 | Max write requests per minute per API key (HTTP transport only) |
| MINDKEG_RATE_LIMIT_READ_RPM | 300 | Max read requests per minute per API key (HTTP transport only) |
| MINDKEG_METRICS_AUTH | false | Require API key auth on `/health` and `/metrics` endpoints |

### Embedding Providers

- **`fastembed`** (default): Free, local ONNX-based embeddings via `BAAI/bge-small-en-v1.5` (384 dims). No API key needed. Model downloaded on first use (~50MB).
- **`openai`**: OpenAI `text-embedding-3-small` (1536 dims). Requires `OPENAI_API_KEY`. Best semantic quality.
- **`none`**: FTS5 keyword search fallback. No embeddings generated. A warning is logged at startup.

All CRUD operations work identically regardless of provider. Only search quality differs.

## Common Pitfalls

- **SQLite is synchronous**: `node:sqlite` (`DatabaseSync`) is synchronous. Do NOT use `await` on DB calls. This is different from most Node.js database libraries. The purge methods (`purgeExpired`, `purgeByFilter`) follow the same synchronous pattern — never make them async.
- **Logger must use stderr**: `pino` logger destination must be `fd 2` (stderr) or the MCP stdio transport breaks. Never write to stdout from server code.
- **API keys are displayed ONCE**: At creation time only. They are SHA-256 hashed and never retrievable afterward.
- **FTS5 trigger maintenance**: Insert/update/delete on `learnings` must sync the `learnings_fts` shadow table. The triggers are set up in `001-initial.ts` migration.
- **FTS5 + encryption incompatibility**: When `MINDKEG_ENCRYPTION_KEY` is set, the `content` field is stored as encrypted ciphertext. FTS5 full-text search cannot match against ciphertext — keyword search returns no results. Semantic search (FastEmbed or OpenAI) works correctly because it operates on the in-memory plaintext vector. Always use an embedding provider when encryption is enabled.
- **Encryption key validation**: `MINDKEG_ENCRYPTION_KEY` must be a base64-encoded 256-bit (32-byte) value. The server fails to start if the key is present but invalid. Generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
- **TTL anchor on `updated_at`**: TTL expiry is computed as `updated_at + ttl_days`. Updating a learning resets its TTL clock. Use `created_at` if you need immutable expiry — but the current schema anchors on `updated_at`.
- **Port 52100**: Default HTTP port. Document this clearly for firewall rules.
- **ESM imports need `.js` extension**: Internal imports must use `.js` extension (e.g., `./tools/store-learning.js`) even though source files are `.ts`. This is required for ESM resolution.
- **Scope mutual exclusivity**: `repository` and `workspace` are mutually exclusive on learnings. Setting both is rejected by Zod validation. Check the refine rule in `CreateLearningInputSchema`.
- **CUDA skip in CI**: Set `ONNX_RUNTIME_NODE_INSTALL_CUDA=skip` during `npm ci` to prevent transient 502 failures when downloading CUDA binaries.
- **CLI version hardcoded**: The CLI displays version `0.1.0` in `cli/index.ts` line 19, but `package.json` is at `0.2.0`. These are out of sync.
- **Auto-categorization requires an embedding provider**: When `MINDKEG_EMBEDDING_PROVIDER=none`, omitting `category` in `store_learning` throws a `ValidationError`. Auto-categorization depends on vector similarity — it cannot run without embeddings.
- **Conflict detection produces false positives**: The keyword-heuristic approach in `conflict-detector.ts` is intentionally simple for v1. Expect false positives when negation/assertion words appear in different semantic contexts. Review detected conflicts before acting on them.
- **Staleness recomputation runs on the purge interval**: `recomputeAllStalenessScores()` is scheduled alongside TTL purge (default every 24h). Staleness scores are not updated in real time — they reflect the state at the last recomputation cycle.
- **Access tracking is non-fatal**: Failures in `recordAccess` (e.g., DB write errors) are swallowed and logged as warnings. A search or get_context response will succeed even if access counts were not incremented. Do not rely on access counts being perfectly consistent.
- **`category` is now optional in `store_learning`**: Breaking change from 0.4.x. Callers that previously relied on a validation error when `category` was absent will instead trigger auto-categorization. Pass an explicit category to retain the old behavior.

## Agent Workflow

See [AGENTS.md](./AGENTS.md) for full agent documentation and delegation map.

**Project agents (from `.claude/agents/`):**
No project agents defined yet.

**Personal agents (from `~/.claude-personal/agents/`):**
- architecture-design
- bug-fixer
- bug-investigator
- commercialization-readiness-auditor
- docs-drift-auditor
- feature-executor
- implementation-planner
- mind-keg
- open-source-readiness-auditor
- oss-commercial-strategy
- platform-architecture-auditor
- product-spec-designer
- refactor-executor
- repo-auditor
- repo-docs-generator
- requirements-clarifier
- saas-pricing-strategist
- seo-strategy-analyst
- ui-spec-generator
- workflow-orchestrator

When working on tasks:
1. Check if the task maps to an existing agent from either list above.
2. If it does, delegate to that agent per its defined scope and constraints.
3. If no agent matches, work as the generalist with full repo context.
4. Always verify changes against the conventions in this file before committing.
5. Multi-agent tasks: execute sequentially per the ordering in AGENTS.md.

## Knowledge Capture

When studying, researching, or learning new technologies, frameworks, or concepts — **always store learnings in Mind Keg** using the `mind-keg` agent. This ensures knowledge is persisted across sessions and searchable later.

**When to invoke `mind-keg`:**
- After reading documentation, blog posts, or release notes
- After completing a study session or tutorial
- When discovering non-obvious patterns, gotchas, or best practices
- When the user explicitly asks to "remember" or "save" a learning
- At the end of any research or learning task — proactively offer to store learnings

**How to invoke:**
- Use the `mind-keg` agent via the Agent tool
- Ask the user for preferred scope (repository, workspace, or global) before storing
- Group related learnings logically rather than storing one at a time when possible
