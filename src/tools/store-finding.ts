/**
 * MCP tool: store_finding
 * Stores a new code review finding with severity and tracking.
 * Traces to AMU-AC-9.
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
 * Register the store_finding tool on the MCP server.
 */
export function registerStoreFinding(
  server: McpServer,
  entityService: EntityService,
  storage: StorageAdapter,
  getApiKey: () => string | undefined
): void {
  server.tool(
    'store_finding',
    'Store a code review finding with severity and suggested fix. Findings track issues across sessions — use resolve_finding when the issue is addressed.',
    {
      repository: z
        .string()
        .min(1)
        .describe('Absolute path to the repository.'),
      file_path: z
        .string()
        .min(1)
        .describe('File path where the finding was identified (relative or absolute).'),
      severity: z
        .enum(FINDING_SEVERITIES)
        .describe('Severity: "critical" (must fix), "warning" (should fix), "suggestion" (nice to fix).'),
      issue: z
        .string()
        .min(1)
        .max(1000)
        .describe('What the issue is. Max 1000 characters. Be specific about what is wrong.'),
      suggestion: z
        .string()
        .min(1)
        .max(1000)
        .describe('What to do about it. Max 1000 characters. Be specific about the fix or improvement.'),
      found_by: z
        .string()
        .optional()
        .nullable()
        .describe('Optional: who or what found this issue (e.g., agent name).'),
    },
    async (args) => {
      const startTime = Date.now();
      try {
        await authenticate(getApiKey(), storage, args.repository);

        const finding = await entityService.storeFinding({
          repository: args.repository,
          file_path: args.file_path,
          severity: args.severity,
          issue: args.issue,
          suggestion: args.suggestion,
          found_by: args.found_by ?? null,
        });

        recordToolMetrics('store_finding', 'success', Date.now() - startTime);
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
          recordToolMetrics('store_finding', 'error', Date.now() - startTime, err.code);
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
