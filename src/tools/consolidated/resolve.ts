/**
 * Consolidated MCP tool: resolve
 * Close out a decision or finding. Routes based on the `type` discriminator:
 *
 * - decision -> entityService.supersedeDecision()
 * - finding -> entityService.resolveFinding()
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EntityService } from '../../services/entity-service.js';
import type { StorageAdapter } from '../../storage/storage-adapter.js';
import { isMindKegError, ValidationError } from '../../utils/errors.js';
import type { AuditLogger } from '../../audit/audit-logger.js';
import { getActorFromApiKey, recordToolMetrics } from '../tool-utils.js';

/** The two resolve types supported by the consolidated resolve tool. */
export type ResolveType = 'decision' | 'finding';

/** Input shape for validateResolveInput. */
export interface ResolveInput {
  type: ResolveType;
  id: string;
  new_decision_id?: string;
  resolved_by?: string | null;
}

/**
 * Pure validation function that checks required fields based on the `type` discriminator.
 * Throws ValidationError if any required field is missing.
 *
 * @returns The input unchanged if valid.
 */
export function validateResolveInput(input: ResolveInput): ResolveInput {
  if (input.type === 'decision') {
    if (!input.new_decision_id) {
      throw new ValidationError('new_decision_id is required for type=decision');
    }
  }
  return input;
}

/**
 * Register the consolidated resolve tool on the MCP server.
 * Replaces the original supersede_decision and resolve_finding tools.
 */
export function registerConsolidatedResolve(
  server: McpServer,
  entityService: EntityService,
  _storage: StorageAdapter,
  getApiKey: () => string | undefined,
  auditLogger: AuditLogger
): void {
  server.tool(
    'resolve',
    'Close out a decision or finding. For decisions: supersede an old decision with a new one (store the new decision first, then call resolve). For findings: mark a code review finding as resolved after it\'s been addressed.',
    {
      type: z.enum(['decision', 'finding']).describe('Type of entity to resolve.'),
      id: z.string().uuid().describe('ID to resolve/supersede.'),
      new_decision_id: z.string().uuid().optional().describe('New decision ID (type=decision).'),
      resolved_by: z.string().optional().nullable().describe('Who resolved (type=finding).'),
    },
    async (args) => {
      const actor = getActorFromApiKey(getApiKey());
      const startTime = Date.now();
      try {
        validateResolveInput({
          type: args.type,
          id: args.id,
          new_decision_id: args.new_decision_id,
          resolved_by: args.resolved_by,
        });

        let result: unknown;

        switch (args.type) {
          case 'decision': {
            const superseded = await entityService.supersedeDecision(args.id, args.new_decision_id!);
            result = {
              success: true,
              type: 'decision' as const,
              old_decision: superseded.old_decision,
              new_decision: superseded.new_decision,
            };
            break;
          }
          case 'finding': {
            const resolved = await entityService.resolveFinding(args.id, args.resolved_by ?? null);
            result = {
              success: true,
              type: 'finding' as const,
              finding: resolved,
            };
            break;
          }
        }

        auditLogger.logEntry({
          timestamp: new Date().toISOString(),
          action: 'resolve',
          actor,
          resource_id: args.id,
          result: 'success',
          client: { transport: 'stdio', pid: process.pid },
          metadata: {
            resolve_type: args.type,
          },
        });

        recordToolMetrics('resolve', 'success', Date.now() - startTime);
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
            action: 'resolve',
            actor,
            resource_id: args.id,
            result: 'error',
            error_code: err.code,
            client: { transport: 'stdio', pid: process.pid },
          });
          recordToolMetrics('resolve', 'error', Date.now() - startTime, err.code);
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
