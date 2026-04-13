/**
 * MCP server setup: creates the McpServer instance and registers all tools.
 *
 * 8 consolidated tools (primary API surface):
 *   get_context, store, update, resolve, complete_run, query, list_scopes, relate_learnings
 *
 * 19 backwards-compatible aliases (old tool names, will be removed in next major version):
 *   store_learning, search_learnings, update_learning, deprecate_learning, delete_learning,
 *   list_repositories, flag_stale, list_workspaces, merge_learnings,
 *   store_decision, get_decisions, supersede_decision, store_finding, resolve_finding,
 *   get_open_findings, store_gotcha, get_gotchas, get_run_history, get_relevant_context
 *
 * Note: The old get_context tool is NOT registered as an alias because the consolidated
 * get_context tool uses the same name. All other old tools have unique names and coexist.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StorageAdapter } from './storage/storage-adapter.js';
import type { EmbeddingService } from './services/embedding-service.js';
import { LearningService } from './services/learning-service.js';
import { EntityService } from './services/entity-service.js';
// Consolidated tool imports
import { registerConsolidatedGetContext } from './tools/consolidated/get-context.js';
import { registerConsolidatedStore } from './tools/consolidated/store.js';
import { registerConsolidatedUpdate } from './tools/consolidated/update.js';
import { registerConsolidatedResolve } from './tools/consolidated/resolve.js';
import { registerConsolidatedQuery } from './tools/consolidated/query.js';
import { registerConsolidatedListScopes } from './tools/consolidated/list-scopes.js';
// Old tool imports (backwards-compatible aliases)
import { registerStoreLearning } from './tools/store-learning.js';
import { registerSearchLearnings } from './tools/search-learnings.js';
import { registerUpdateLearning } from './tools/update-learning.js';
import { registerDeprecateLearning } from './tools/deprecate-learning.js';
import { registerDeleteLearning } from './tools/delete-learning.js';
import { registerListRepositories } from './tools/list-repositories.js';
import { registerFlagStale } from './tools/flag-stale.js';
import { registerListWorkspaces } from './tools/list-workspaces.js';
import { registerMergeLearnings } from './tools/merge-learnings.js';
import { registerRelateLearnings } from './tools/relate-learnings.js';
import { registerStoreDecision } from './tools/store-decision.js';
import { registerGetDecisions } from './tools/get-decisions.js';
import { registerSupersedeDecision } from './tools/supersede-decision.js';
import { registerStoreFinding } from './tools/store-finding.js';
import { registerResolveFinding } from './tools/resolve-finding.js';
import { registerGetOpenFindings } from './tools/get-open-findings.js';
import { registerStoreGotcha } from './tools/store-gotcha.js';
import { registerGetGotchas } from './tools/get-gotchas.js';
import { registerCompleteRun } from './tools/complete-run.js';
import { registerGetRunHistory } from './tools/get-run-history.js';
import { registerGetRelevantContext } from './tools/get-relevant-context.js';
import type { AuditLogger } from './audit/audit-logger.js';
import { createNoopAuditLogger } from './audit/audit-logger.js';

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
- For scope, ask the user; default suggestion: this repo unless the insight clearly applies cross-project.
- At session end, if you made multiple discoveries, summarize them and offer to save the ones the user wants to keep.`;

export interface ServerDependencies {
  storage: StorageAdapter;
  embedding: EmbeddingService;
  /** Callback to retrieve the current API key (e.g., from env or HTTP header). */
  getApiKey: () => string | undefined;
  /**
   * Audit logger for structured audit trail. (ESH-AC-5)
   * Defaults to no-op logger if not provided.
   */
  auditLogger?: AuditLogger;
}

/**
 * Create and configure the MCP server with all tools registered.
 * Registers 8 consolidated tools as the primary API surface, plus 19
 * backwards-compatible aliases using the old tool names.
 * The server must still be connected to a transport (stdio or HTTP) by the caller.
 */
export function createMcpServer(deps: ServerDependencies): McpServer {
  const server = new McpServer(
    {
      name: 'mindkeg-mcp',
      version: '0.7.2',
    },
    {
      capabilities: {
        tools: {},
      },
      instructions: MINDKEG_SERVER_INSTRUCTIONS,
    }
  );

  const learningService = new LearningService(deps.storage, deps.embedding);
  const entityService = new EntityService(deps.storage, deps.embedding);
  const auditLogger = deps.auditLogger ?? createNoopAuditLogger();

  // --- Consolidated tools (8 primary tools) ---
  registerConsolidatedGetContext(server, learningService, entityService, deps.storage, deps.getApiKey, auditLogger);
  registerConsolidatedStore(server, learningService, entityService, deps.storage, deps.getApiKey, auditLogger);
  registerConsolidatedUpdate(server, learningService, deps.storage, deps.getApiKey, auditLogger);
  registerConsolidatedResolve(server, entityService, deps.storage, deps.getApiKey, auditLogger);
  registerCompleteRun(server, entityService, deps.storage, deps.getApiKey);
  registerConsolidatedQuery(server, entityService, deps.storage, deps.getApiKey, auditLogger);
  registerConsolidatedListScopes(server, learningService, deps.storage, deps.getApiKey, auditLogger);
  registerRelateLearnings(server, learningService, deps.storage, deps.getApiKey, auditLogger);

  // --- Backwards-compatible aliases (old tool names, removed in next major version) ---
  // These are the original tool files — they call the same service methods.
  // NOT registering old get_context (replaced by consolidated get_context above).
  registerStoreLearning(server, learningService, deps.storage, deps.getApiKey, auditLogger);
  registerSearchLearnings(server, learningService, deps.storage, deps.getApiKey, auditLogger);
  registerUpdateLearning(server, learningService, deps.storage, deps.getApiKey, auditLogger);
  registerDeprecateLearning(server, learningService, deps.storage, deps.getApiKey, auditLogger);
  registerDeleteLearning(server, learningService, deps.storage, deps.getApiKey, auditLogger);
  registerListRepositories(server, learningService, deps.storage, deps.getApiKey, auditLogger);
  registerFlagStale(server, learningService, deps.storage, deps.getApiKey, auditLogger);
  registerListWorkspaces(server, learningService, auditLogger);
  registerMergeLearnings(server, learningService, deps.storage, deps.getApiKey, auditLogger);
  registerStoreDecision(server, entityService, deps.storage, deps.getApiKey);
  registerGetDecisions(server, entityService, deps.storage, deps.getApiKey);
  registerSupersedeDecision(server, entityService);
  registerStoreFinding(server, entityService, deps.storage, deps.getApiKey);
  registerResolveFinding(server, entityService);
  registerGetOpenFindings(server, entityService, deps.storage, deps.getApiKey);
  registerStoreGotcha(server, entityService, deps.storage, deps.getApiKey);
  registerGetGotchas(server, entityService, deps.storage, deps.getApiKey);
  registerGetRunHistory(server, entityService, deps.storage, deps.getApiKey);
  registerGetRelevantContext(server, entityService, deps.storage, deps.getApiKey);

  return server;
}
