/**
 * MCP tool: supersede_decision
 * Marks an old decision as superseded by a newer one.
 * Traces to AMU-AC-8.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EntityService } from '../services/entity-service.js';
import { isMindKegError } from '../utils/errors.js';
import { recordToolMetrics } from './tool-utils.js';

/**
 * Register the supersede_decision tool on the MCP server.
 */
export function registerSupersedeDecision(
  server: McpServer,
  entityService: EntityService
): void {
  server.tool(
    'supersede_decision',
    'Mark an existing active decision as superseded by a newer decision. Use this when you store a new decision that replaces an old one — call store_decision first to get the new ID, then call supersede_decision.',
    {
      decision_id: z
        .string()
        .uuid()
        .describe('UUID of the decision to supersede. Must be active.'),
      new_decision_id: z
        .string()
        .uuid()
        .describe('UUID of the new decision that replaces it. Must already exist.'),
    },
    async (args) => {
      const startTime = Date.now();
      try {
        const result = await entityService.supersedeDecision(args.decision_id, args.new_decision_id);

        recordToolMetrics('supersede_decision', 'success', Date.now() - startTime);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: true, ...result }, null, 2),
            },
          ],
        };
      } catch (err) {
        if (isMindKegError(err)) {
          recordToolMetrics('supersede_decision', 'error', Date.now() - startTime, err.code);
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
