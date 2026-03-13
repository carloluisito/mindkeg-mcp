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

export interface ServerDependencies {
  storage: StorageAdapter;
  embedding: EmbeddingService;
  /** Callback to retrieve the current API key (e.g., from env or HTTP header). */
  getApiKey: () => string | undefined;
}

/**
 * Create and configure the MCP server with all tools registered.
 * The server must still be connected to a transport (stdio or HTTP) by the caller.
 */
export function createMcpServer(deps: ServerDependencies): McpServer {
  const server = new McpServer(
    {
      name: 'mindkeg-mcp',
      version: '0.3.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  const learningService = new LearningService(deps.storage, deps.embedding);

  // Register all 9 MCP tools (AC-16, AC-30, WS-AC-16, GC-AC-1)
  registerStoreLearning(server, learningService, deps.storage, deps.getApiKey);
  registerSearchLearnings(server, learningService, deps.storage, deps.getApiKey);
  registerUpdateLearning(server, learningService, deps.storage, deps.getApiKey);
  registerDeprecateLearning(server, learningService, deps.storage, deps.getApiKey);
  registerDeleteLearning(server, learningService, deps.storage, deps.getApiKey);
  registerListRepositories(server, learningService, deps.storage, deps.getApiKey);
  registerFlagStale(server, learningService, deps.storage, deps.getApiKey);
  registerListWorkspaces(server, learningService);
  registerGetContext(server, learningService, deps.storage, deps.getApiKey);

  return server;
}
