/**
 * MCP tool: get_relevant_context
 * Returns task-scoped context across all entity types for the current task.
 * Traces to AMU-AC-16, AMU-AC-17, AMU-AC-18.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EntityService } from '../services/entity-service.js';
import type { StorageAdapter } from '../storage/storage-adapter.js';
import { isMindKegError } from '../utils/errors.js';
import { authenticate } from '../auth/middleware.js';
import { recordToolMetrics } from './tool-utils.js';

/**
 * Register the get_relevant_context tool on the MCP server.
 */
export function registerGetRelevantContext(
  server: McpServer,
  entityService: EntityService,
  storage: StorageAdapter,
  getApiKey: () => string | undefined
): void {
  server.tool(
    'get_relevant_context',
    'Get task-scoped context for your current task in one call. Returns the most relevant decisions, open findings, gotchas, learnings, and recent run history — all scored by relevance to what you are about to do. Use this at session start instead of (or in addition to) get_context for structured agent knowledge.',
    {
      repository: z
        .string()
        .min(1)
        .describe('Absolute path to the repository.'),
      task_description: z
        .string()
        .min(1)
        .describe('What you are about to do. 1-3 sentences describing the task. Used for relevance scoring — be specific (e.g., "Implement OAuth 2.0 authentication with PKCE for the API").'),
      budget: z
        .enum(['compact', 'standard', 'full'])
        .optional()
        .describe('Context budget: "compact" (~2000 chars, quick check), "standard" (~4000 chars, default), "full" (~8000 chars, large tasks).'),
    },
    async (args) => {
      const startTime = Date.now();
      try {
        await authenticate(getApiKey(), storage, args.repository);

        const context = await entityService.getRelevantContext(
          args.repository,
          args.task_description,
          args.budget ?? 'standard'
        );

        recordToolMetrics('get_relevant_context', 'success', Date.now() - startTime);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(context, null, 2),
            },
          ],
        };
      } catch (err) {
        if (isMindKegError(err)) {
          recordToolMetrics('get_relevant_context', 'error', Date.now() - startTime, err.code);
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
