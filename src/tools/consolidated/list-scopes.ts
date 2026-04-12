/**
 * Consolidated MCP tool: list_scopes
 * Lists all repositories and workspaces that have stored knowledge, with counts.
 * Replaces the original list_repositories and list_workspaces tools.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LearningService } from '../../services/learning-service.js';
import type { StorageAdapter } from '../../storage/storage-adapter.js';
import { isMindKegError } from '../../utils/errors.js';
import { authenticate } from '../../auth/middleware.js';
import type { AuditLogger } from '../../audit/audit-logger.js';
import { getActorFromApiKey, recordToolMetrics } from '../tool-utils.js';

/**
 * Register the consolidated list_scopes tool on the MCP server.
 * Replaces the original list_repositories and list_workspaces tools.
 */
export function registerConsolidatedListScopes(
  server: McpServer,
  learningService: LearningService,
  storage: StorageAdapter,
  getApiKey: () => string | undefined,
  auditLogger: AuditLogger
): void {
  server.tool(
    'list_scopes',
    'List all repositories and workspaces that have stored knowledge, with counts. Use to understand what knowledge exists across your projects.',
    {},
    async () => {
      const actor = getActorFromApiKey(getApiKey());
      const startTime = Date.now();
      try {
        await authenticate(getApiKey(), storage);

        const repositories = await learningService.listRepositories();
        const workspaces = await learningService.listWorkspaces();

        const result = { repositories, workspaces };

        auditLogger.logEntry({
          timestamp: new Date().toISOString(),
          action: 'list_scopes',
          actor,
          resource_id: null,
          result: 'success',
          client: { transport: 'stdio', pid: process.pid },
        });

        recordToolMetrics('list_scopes', 'success', Date.now() - startTime);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        if (isMindKegError(err)) {
          auditLogger.logEntry({
            timestamp: new Date().toISOString(),
            action: 'list_scopes',
            actor,
            resource_id: null,
            result: 'error',
            error_code: err.code,
            client: { transport: 'stdio', pid: process.pid },
          });
          recordToolMetrics('list_scopes', 'error', Date.now() - startTime, err.code);
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify(err.toJSON()) }],
          };
        }
        return {
          isError: true,
          content: [
            { type: 'text' as const, text: `Unexpected error: ${String(err)}` },
          ],
        };
      }
    }
  );
}
