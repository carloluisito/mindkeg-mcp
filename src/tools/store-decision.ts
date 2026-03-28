/**
 * MCP tool: store_decision
 * Stores a new architectural decision with rationale and lifecycle tracking.
 * Traces to AMU-AC-6.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EntityService } from '../services/entity-service.js';
import type { StorageAdapter } from '../storage/storage-adapter.js';
import { isMindKegError } from '../utils/errors.js';
import { authenticate } from '../auth/middleware.js';
import { getActorFromApiKey, recordToolMetrics } from './tool-utils.js';

/**
 * Register the store_decision tool on the MCP server.
 */
export function registerStoreDecision(
  server: McpServer,
  entityService: EntityService,
  storage: StorageAdapter,
  getApiKey: () => string | undefined
): void {
  server.tool(
    'store_decision',
    'Store an architectural decision with rationale. Decisions capture WHY a choice was made, not just what exists. Use this for technology selections, design patterns, API design choices, and other significant decisions that future sessions should understand.',
    {
      repository: z
        .string()
        .min(1)
        .describe('Absolute path to the repository this decision belongs to.'),
      category: z
        .string()
        .min(1)
        .describe('Category of the decision (e.g., "database", "auth", "api-design", "architecture").'),
      choice: z
        .string()
        .min(1)
        .max(1000)
        .describe('The decision made. Be concise — max 1000 characters. State what was chosen, not why (use rationale for that).'),
      rationale: z
        .string()
        .min(1)
        .max(2000)
        .describe('Why this choice was made. Include constraints, alternatives considered, and trade-offs. Max 2000 characters.'),
      made_by: z
        .string()
        .optional()
        .nullable()
        .describe('Optional: who or what made this decision (e.g., agent name, team name).'),
    },
    async (args) => {
      const actor = getActorFromApiKey(getApiKey());
      const startTime = Date.now();
      try {
        await authenticate(getApiKey(), storage, args.repository);

        const decision = await entityService.storeDecision({
          repository: args.repository,
          category: args.category,
          choice: args.choice,
          rationale: args.rationale,
          made_by: args.made_by ?? null,
        });

        recordToolMetrics('store_decision', 'success', Date.now() - startTime);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: true, decision }, null, 2),
            },
          ],
        };
      } catch (err) {
        if (isMindKegError(err)) {
          recordToolMetrics('store_decision', 'error', Date.now() - startTime, err.code);
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify(err.toJSON()) }],
          };
        }
        // Log actor to avoid unused variable warning
        void actor;
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Unexpected error: ${String(err)}` }],
        };
      }
    }
  );
}
