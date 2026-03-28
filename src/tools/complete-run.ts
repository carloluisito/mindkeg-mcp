/**
 * MCP tool: complete_run
 * Records a completed execution run with summary and outcome.
 * Traces to AMU-AC-14.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EntityService } from '../services/entity-service.js';
import type { StorageAdapter } from '../storage/storage-adapter.js';
import { RUN_OUTCOMES } from '../models/run-summary.js';
import { isMindKegError } from '../utils/errors.js';
import { authenticate } from '../auth/middleware.js';
import { recordToolMetrics } from './tool-utils.js';

/**
 * Register the complete_run tool on the MCP server.
 */
export function registerCompleteRun(
  server: McpServer,
  entityService: EntityService,
  storage: StorageAdapter,
  getApiKey: () => string | undefined
): void {
  server.tool(
    'complete_run',
    'Record a completed execution run. Call this at the end of an orchestration run or significant work session to track what happened, which files changed, and the outcome.',
    {
      repository: z
        .string()
        .min(1)
        .describe('Absolute path to the repository this run operated on.'),
      summary: z
        .string()
        .min(1)
        .describe('Free-form summary of what happened in this run. What was accomplished, what was attempted, key decisions made.'),
      files_changed: z
        .array(z.string())
        .optional()
        .describe('Optional: list of file paths that were created or modified during this run.'),
      outcome: z
        .enum(RUN_OUTCOMES)
        .optional()
        .describe('Run outcome: "success" (all tasks completed), "partial" (some tasks completed), "failed" (run did not complete). Defaults to "success".'),
      duration_seconds: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .nullable()
        .describe('Optional: total duration of the run in seconds.'),
    },
    async (args) => {
      const startTime = Date.now();
      try {
        await authenticate(getApiKey(), storage, args.repository);

        const runSummary = await entityService.completeRun({
          repository: args.repository,
          summary: args.summary,
          files_changed: args.files_changed,
          outcome: args.outcome,
          duration_seconds: args.duration_seconds ?? null,
        });

        recordToolMetrics('complete_run', 'success', Date.now() - startTime);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: true, run_summary: runSummary }, null, 2),
            },
          ],
        };
      } catch (err) {
        if (isMindKegError(err)) {
          recordToolMetrics('complete_run', 'error', Date.now() - startTime, err.code);
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
