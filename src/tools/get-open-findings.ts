/**
 * MCP tool: get_open_findings
 * Retrieves open (unresolved) code review findings for a repository.
 * Traces to AMU-AC-11.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EntityService } from '../services/entity-service.js';
import type { StorageAdapter } from '../storage/storage-adapter.js';
import { FINDING_SEVERITIES } from '../models/finding.js';
import { isMindKegError } from '../utils/errors.js';
import { authenticate } from '../auth/middleware.js';
import { recordToolMetrics } from './tool-utils.js';

/**
 * Register the get_open_findings tool on the MCP server.
 */
export function registerGetOpenFindings(
  server: McpServer,
  entityService: EntityService,
  storage: StorageAdapter,
  getApiKey: () => string | undefined
): void {
  server.tool(
    'get_open_findings',
    'Retrieve all open (unresolved) code review findings for a repository, ordered by severity (critical first) then most recent. Optionally filter by severity level.',
    {
      repository: z
        .string()
        .min(1)
        .describe('Absolute path to the repository.'),
      severity: z
        .enum(FINDING_SEVERITIES)
        .optional()
        .describe('Optional: filter by severity level ("critical", "warning", or "suggestion").'),
    },
    async (args) => {
      const startTime = Date.now();
      try {
        await authenticate(getApiKey(), storage, args.repository);

        const findings = await entityService.getOpenFindings(args.repository, args.severity);

        recordToolMetrics('get_open_findings', 'success', Date.now() - startTime);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ findings, count: findings.length }, null, 2),
            },
          ],
        };
      } catch (err) {
        if (isMindKegError(err)) {
          recordToolMetrics('get_open_findings', 'error', Date.now() - startTime, err.code);
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
