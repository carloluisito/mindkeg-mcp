/**
 * MCP tool: get_decisions
 * Retrieves active architectural decisions for a repository.
 * Traces to AMU-AC-7.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EntityService } from '../services/entity-service.js';
import type { StorageAdapter } from '../storage/storage-adapter.js';
import { isMindKegError } from '../utils/errors.js';
import { authenticate } from '../auth/middleware.js';
import { recordToolMetrics } from './tool-utils.js';

/**
 * Register the get_decisions tool on the MCP server.
 */
export function registerGetDecisions(
  server: McpServer,
  entityService: EntityService,
  storage: StorageAdapter,
  getApiKey: () => string | undefined
): void {
  server.tool(
    'get_decisions',
    'Retrieve all active architectural decisions for a repository, ordered by most recent first. Optionally filter by category.',
    {
      repository: z
        .string()
        .min(1)
        .describe('Absolute path to the repository.'),
      category: z
        .string()
        .optional()
        .describe('Optional: filter decisions by category (e.g., "database", "auth").'),
    },
    async (args) => {
      const startTime = Date.now();
      try {
        await authenticate(getApiKey(), storage, args.repository);

        const decisions = await entityService.getDecisions(args.repository, args.category);

        recordToolMetrics('get_decisions', 'success', Date.now() - startTime);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ decisions, count: decisions.length }, null, 2),
            },
          ],
        };
      } catch (err) {
        if (isMindKegError(err)) {
          recordToolMetrics('get_decisions', 'error', Date.now() - startTime, err.code);
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify(err.toJSON()) }],
          };
        }
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Unexpected error: ${String(err)}` }],
        };
      }
    }
  );
}
