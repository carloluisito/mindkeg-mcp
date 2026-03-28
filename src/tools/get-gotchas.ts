/**
 * MCP tool: get_gotchas
 * Retrieves gotchas for a repository, ordered by frequency (most common first).
 * Traces to AMU-AC-13.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EntityService } from '../services/entity-service.js';
import type { StorageAdapter } from '../storage/storage-adapter.js';
import { isMindKegError } from '../utils/errors.js';
import { authenticate } from '../auth/middleware.js';
import { recordToolMetrics } from './tool-utils.js';

/**
 * Register the get_gotchas tool on the MCP server.
 */
export function registerGetGotchas(
  server: McpServer,
  entityService: EntityService,
  storage: StorageAdapter,
  getApiKey: () => string | undefined
): void {
  server.tool(
    'get_gotchas',
    'Retrieve gotchas for a repository, ordered by times_encountered descending (most common first). Optionally filter by technology.',
    {
      repository: z
        .string()
        .min(1)
        .describe('Absolute path to the repository.'),
      technology: z
        .string()
        .optional()
        .describe('Optional: filter by technology (e.g., "react", "prisma", "sqlite").'),
    },
    async (args) => {
      const startTime = Date.now();
      try {
        await authenticate(getApiKey(), storage, args.repository);

        const gotchas = await entityService.getGotchas(args.repository, args.technology);

        recordToolMetrics('get_gotchas', 'success', Date.now() - startTime);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ gotchas, count: gotchas.length }, null, 2),
            },
          ],
        };
      } catch (err) {
        if (isMindKegError(err)) {
          recordToolMetrics('get_gotchas', 'error', Date.now() - startTime, err.code);
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
