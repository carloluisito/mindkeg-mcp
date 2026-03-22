/**
 * MCP server setup: creates the McpServer instance and registers all 9 tools.
 * Traces to AC-16 (all 9 tools), AC-17 (stdio), AC-18 (HTTP+SSE).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StorageAdapter } from './storage/storage-adapter.js';
import type { EmbeddingService } from './services/embedding-service.js';
import { LearningService } from './services/learning-service.js';
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
  const auditLogger = deps.auditLogger ?? createNoopAuditLogger();

  // Register all 11 MCP tools (AC-16, AC-30, WS-AC-16, GC-AC-1, SKM-AC-1, SKM-AC-39)
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

  return server;
}
