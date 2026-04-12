/**
 * Consolidated MCP tool: query
 * List stored knowledge by type. Routes based on the `type` discriminator:
 *
 * - decisions -> entityService.getDecisions()
 * - findings -> entityService.getOpenFindings()
 * - gotchas -> entityService.getGotchas()
 * - runs -> entityService.getRunHistory()
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EntityService } from '../../services/entity-service.js';
import type { StorageAdapter } from '../../storage/storage-adapter.js';
import { isMindKegError } from '../../utils/errors.js';
import { authenticate } from '../../auth/middleware.js';
import type { AuditLogger } from '../../audit/audit-logger.js';
import { getActorFromApiKey, recordToolMetrics } from '../tool-utils.js';

/** The four query types supported by the consolidated query tool. */
export type QueryType = 'decisions' | 'findings' | 'gotchas' | 'runs';

/**
 * Register the consolidated query tool on the MCP server.
 * Replaces the original get_decisions, get_open_findings, get_gotchas, and get_run_history tools.
 */
export function registerConsolidatedQuery(
  server: McpServer,
  entityService: EntityService,
  storage: StorageAdapter,
  getApiKey: () => string | undefined,
  auditLogger: AuditLogger
): void {
  server.tool(
    'query',
    'List stored knowledge by type. Use to browse decisions, open findings, gotchas, or run history for a repository. For searching by topic, use get_context with a query instead.',
    {
      type: z.enum(['decisions', 'findings', 'gotchas', 'runs']).describe('Type of knowledge to list.'),
      repository: z.string().min(1).describe('Repository path.'),
      category: z.string().optional().describe('Filter decisions by category.'),
      severity: z.enum(['critical', 'warning', 'suggestion']).optional().describe('Filter findings by severity.'),
      technology: z.string().optional().describe('Filter gotchas by technology.'),
      limit: z.number().int().min(1).max(50).optional().describe('Max results (type=runs).'),
    },
    async (args) => {
      const actor = getActorFromApiKey(getApiKey());
      const startTime = Date.now();
      try {
        await authenticate(getApiKey(), storage, args.repository);

        let result: unknown;

        switch (args.type) {
          case 'decisions': {
            const decisions = await entityService.getDecisions(args.repository, args.category);
            result = { type: 'decisions' as const, count: decisions.length, results: decisions };
            break;
          }
          case 'findings': {
            const findings = await entityService.getOpenFindings(args.repository, args.severity);
            result = { type: 'findings' as const, count: findings.length, results: findings };
            break;
          }
          case 'gotchas': {
            const gotchas = await entityService.getGotchas(args.repository, args.technology);
            result = { type: 'gotchas' as const, count: gotchas.length, results: gotchas };
            break;
          }
          case 'runs': {
            const runs = await entityService.getRunHistory(args.repository, args.limit ?? 10);
            result = { type: 'runs' as const, count: runs.length, results: runs };
            break;
          }
        }

        auditLogger.logEntry({
          timestamp: new Date().toISOString(),
          action: 'query',
          actor,
          resource_id: null,
          result: 'success',
          client: { transport: 'stdio', pid: process.pid },
          metadata: {
            query_type: args.type,
            repository: args.repository,
          },
        });

        recordToolMetrics('query', 'success', Date.now() - startTime);
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
            action: 'query',
            actor,
            resource_id: null,
            result: 'error',
            error_code: err.code,
            client: { transport: 'stdio', pid: process.pid },
          });
          recordToolMetrics('query', 'error', Date.now() - startTime, err.code);
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
