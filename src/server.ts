/**
 * MCP server setup: creates the McpServer instance and registers all 22 tools.
 * 11 existing learning tools + 11 new Agent Memory Upgrade (AMU) tools.
 * Traces to AC-16 (all tools), AC-17 (stdio), AC-18 (HTTP+SSE), AMU-AC-6 through AMU-AC-18.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StorageAdapter } from './storage/storage-adapter.js';
import type { EmbeddingService } from './services/embedding-service.js';
import { LearningService } from './services/learning-service.js';
import { EntityService } from './services/entity-service.js';
import { registerStoreLearning } from './tools/store-learning.js';
import { registerSearchLearnings } from './tools/search-learnings.js';
import { registerUpdateLearning } from './tools/update-learning.js';
import { registerDeprecateLearning } from './tools/deprecate-learning.js';
import { registerDeleteLearning } from './tools/delete-learning.js';
import { registerListRepositories } from './tools/list-repositories.js';
import { registerFlagStale } from './tools/flag-stale.js';
import { registerListWorkspaces } from './tools/list-workspaces.js';
import { registerGetContext } from './tools/get-context.js';
import { registerMergeLearnings } from './tools/merge-learnings.js';
import { registerRelateLearnings } from './tools/relate-learnings.js';
// AMU tools (AMU-AC-6 through AMU-AC-18)
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
 * The server must still be connected to a transport (stdio or HTTP) by the caller.
 */
export function createMcpServer(deps: ServerDependencies): McpServer {
  const server = new McpServer(
    {
      name: 'mindkeg-mcp',
      version: '0.5.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  const learningService = new LearningService(deps.storage, deps.embedding);
  const entityService = new EntityService(deps.storage, deps.embedding);
  const auditLogger = deps.auditLogger ?? createNoopAuditLogger();

  // Register all 11 existing MCP tools (AC-16, AC-30, WS-AC-16, GC-AC-1, SKM-AC-1, SKM-AC-39)
  registerStoreLearning(server, learningService, deps.storage, deps.getApiKey, auditLogger);
  registerSearchLearnings(server, learningService, deps.storage, deps.getApiKey, auditLogger);
  registerUpdateLearning(server, learningService, deps.storage, deps.getApiKey, auditLogger);
  registerDeprecateLearning(server, learningService, deps.storage, deps.getApiKey, auditLogger);
  registerDeleteLearning(server, learningService, deps.storage, deps.getApiKey, auditLogger);
  registerListRepositories(server, learningService, deps.storage, deps.getApiKey, auditLogger);
  registerFlagStale(server, learningService, deps.storage, deps.getApiKey, auditLogger);
  registerListWorkspaces(server, learningService, auditLogger);
  registerGetContext(server, learningService, deps.storage, deps.getApiKey, auditLogger);
  registerMergeLearnings(server, learningService, deps.storage, deps.getApiKey, auditLogger);
  registerRelateLearnings(server, learningService, deps.storage, deps.getApiKey, auditLogger);

  // Register 11 new AMU tools (AMU-AC-6 through AMU-AC-18)
  registerStoreDecision(server, entityService, deps.storage, deps.getApiKey);
  registerGetDecisions(server, entityService, deps.storage, deps.getApiKey);
  registerSupersedeDecision(server, entityService);
  registerStoreFinding(server, entityService, deps.storage, deps.getApiKey);
  registerResolveFinding(server, entityService);
  registerGetOpenFindings(server, entityService, deps.storage, deps.getApiKey);
  registerStoreGotcha(server, entityService, deps.storage, deps.getApiKey);
  registerGetGotchas(server, entityService, deps.storage, deps.getApiKey);
  registerCompleteRun(server, entityService, deps.storage, deps.getApiKey);
  registerGetRunHistory(server, entityService, deps.storage, deps.getApiKey);
  registerGetRelevantContext(server, entityService, deps.storage, deps.getApiKey);

  return server;
}
