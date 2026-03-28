/**
 * MCP tool: resolve_finding
 * Marks a code review finding as resolved.
 * Traces to AMU-AC-10.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EntityService } from '../services/entity-service.js';
import { isMindKegError } from '../utils/errors.js';
import { recordToolMetrics } from './tool-utils.js';

/**
 * Register the resolve_finding tool on the MCP server.
 */
export function registerResolveFinding(
  server: McpServer,
  entityService: EntityService
): void {
  server.tool(
    'resolve_finding',
    'Mark a code review finding as resolved. Sets status to "resolved" and records the resolution timestamp. Resolved findings no longer appear in get_open_findings results.',
    {
      finding_id: z
        .string()
        .uuid()
        .describe('UUID of the finding to resolve.'),
      resolved_by: z
        .string()
        .optional()
        .nullable()
        .describe('Optional: who or what resolved this finding (e.g., agent name).'),
    },
    async (args) => {
      const startTime = Date.now();
      try {
        const finding = await entityService.resolveFinding(args.finding_id, args.resolved_by ?? null);

        recordToolMetrics('resolve_finding', 'success', Date.now() - startTime);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: true, finding }, null, 2),
            },
          ],
        };
      } catch (err) {
        if (isMindKegError(err)) {
          recordToolMetrics('resolve_finding', 'error', Date.now() - startTime, err.code);
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
