/**
 * Consolidated MCP tool: update
 * Single entry point for modifying existing knowledge. Routes based on the `action` discriminator:
 *
 * - update -> learningService.updateLearning()
 * - deprecate -> learningService.deprecateLearning()
 * - flag_stale -> learningService.flagStale()
 * - delete -> learningService.deleteLearning()
 * - merge -> fetch canonical + duplicates, optionally update content, deprecate duplicates
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LEARNING_CATEGORIES } from '../../models/learning.js';
import type { LearningService } from '../../services/learning-service.js';
import type { StorageAdapter } from '../../storage/storage-adapter.js';
import { isMindKegError, ValidationError, NotFoundError } from '../../utils/errors.js';
import { authenticate } from '../../auth/middleware.js';
import type { AuditLogger } from '../../audit/audit-logger.js';
import { getActorFromApiKey, recordToolMetrics } from '../tool-utils.js';

/** The five actions supported by the consolidated update tool. */
export type UpdateAction = 'update' | 'deprecate' | 'flag_stale' | 'delete' | 'merge';

/** Input shape for validateUpdateInput. */
export interface UpdateInput {
  action: UpdateAction;
  id: string;
  content?: string;
  category?: string;
  tags?: string[];
  source_agent?: string | null;
  reason?: string;
  duplicate_ids?: string[];
  merged_content?: string;
}

/**
 * Pure validation function that checks required fields based on the `action` discriminator.
 * Throws ValidationError if any required field is missing or invalid.
 *
 * @returns The input unchanged if valid.
 */
export function validateUpdateInput(input: UpdateInput): UpdateInput {
  if (input.action === 'merge') {
    if (!input.duplicate_ids || input.duplicate_ids.length === 0) {
      throw new ValidationError('duplicate_ids is required for merge action');
    }
    if (input.duplicate_ids.includes(input.id)) {
      throw new ValidationError('canonical_id must not appear in duplicate_ids');
    }
  }
  return input;
}

/**
 * Register the consolidated update tool on the MCP server.
 * Replaces the original update_learning, deprecate_learning, flag_stale,
 * delete_learning, and merge_learnings tools.
 */
export function registerConsolidatedUpdate(
  server: McpServer,
  learningService: LearningService,
  storage: StorageAdapter,
  getApiKey: () => string | undefined,
  auditLogger: AuditLogger
): void {
  server.tool(
    'update',
    'Modify or manage existing knowledge. Actions: update (change content/tags), deprecate (mark outdated — preferred over delete), flag_stale (soft flag when unsure), delete (permanent), merge (consolidate duplicates). When you find a stored learning that contradicts current reality, proactively offer to deprecate or flag it. Use deprecate when certain, flag_stale when unsure.',
    {
      action: z.enum(['update', 'deprecate', 'flag_stale', 'delete', 'merge']).describe('Action to perform.'),
      id: z.string().uuid().describe('Target learning ID.'),
      content: z.string().min(1).max(500).optional().describe('New content (action=update).'),
      category: z.enum(LEARNING_CATEGORIES).optional().describe('New category (action=update).'),
      tags: z.array(z.string()).optional().describe('New tags (action=update).'),
      source_agent: z.string().optional().nullable().describe('Agent name for provenance (action=update).'),
      reason: z.string().optional().describe('Reason for deprecation or stale flag (action=deprecate, flag_stale).'),
      duplicate_ids: z.array(z.string().uuid()).min(1).max(20).optional().describe('IDs of duplicates to merge into canonical (action=merge).'),
      merged_content: z.string().min(1).max(500).optional().describe('Synthesized content for canonical after merge (action=merge).'),
    },
    async (args) => {
      const actor = getActorFromApiKey(getApiKey());
      const startTime = Date.now();
      try {
        // Fetch target learning and authenticate
        const existing = await storage.getLearning(args.id);
        if (!existing) {
          throw new NotFoundError(`Learning not found: ${args.id}`);
        }
        await authenticate(getApiKey(), storage, existing.repository);

        validateUpdateInput({
          action: args.action,
          id: args.id,
          content: args.content,
          category: args.category,
          tags: args.tags,
          source_agent: args.source_agent,
          reason: args.reason,
          duplicate_ids: args.duplicate_ids,
          merged_content: args.merged_content,
        });

        let result: unknown;

        switch (args.action) {
          case 'update': {
            const updated = await learningService.updateLearning({
              id: args.id,
              content: args.content,
              category: args.category,
              tags: args.tags,
              source_agent: args.source_agent,
            });
            result = { success: true, action: 'update' as const, learning: updated };
            break;
          }
          case 'deprecate': {
            const deprecated = await learningService.deprecateLearning({
              id: args.id,
              reason: args.reason,
            });
            result = { success: true, action: 'deprecate' as const, learning: deprecated };
            break;
          }
          case 'flag_stale': {
            const flagged = await learningService.flagStale({ id: args.id });
            result = { success: true, action: 'flag_stale' as const, learning: flagged };
            break;
          }
          case 'delete': {
            await learningService.deleteLearning({ id: args.id });
            result = { success: true, action: 'delete' as const, id: args.id };
            break;
          }
          case 'merge': {
            // Verify canonical is not deprecated
            if (existing.status === 'deprecated') {
              throw new ValidationError(`Canonical learning is already deprecated: ${args.id}`);
            }

            // Verify all duplicate IDs exist and are not deprecated
            for (const dupId of args.duplicate_ids!) {
              const dup = await storage.getLearning(dupId);
              if (!dup) {
                throw new NotFoundError(`Duplicate learning not found: ${dupId}`);
              }
              if (dup.status === 'deprecated') {
                throw new ValidationError(`Duplicate learning is already deprecated: ${dupId}`);
              }
            }

            // Step 1: optionally update canonical content
            let updatedCanonical = existing;
            if (args.merged_content !== undefined) {
              updatedCanonical = await learningService.updateLearning({
                id: args.id,
                content: args.merged_content,
              });
            }

            // Step 2: deprecate all duplicates
            for (const dupId of args.duplicate_ids!) {
              await learningService.deprecateLearning({ id: dupId });
            }

            result = {
              success: true,
              action: 'merge' as const,
              canonical: {
                id: updatedCanonical.id,
                content: updatedCanonical.content,
                category: updatedCanonical.category,
                tags: updatedCanonical.tags,
                repository: updatedCanonical.repository,
                workspace: updatedCanonical.workspace,
                status: updatedCanonical.status,
                created_at: updatedCanonical.created_at,
                updated_at: updatedCanonical.updated_at,
              },
              deprecated_count: args.duplicate_ids!.length,
            };
            break;
          }
        }

        auditLogger.logEntry({
          timestamp: new Date().toISOString(),
          action: 'update',
          actor,
          resource_id: args.id,
          result: 'success',
          client: { transport: 'stdio', pid: process.pid },
          metadata: {
            update_action: args.action,
          },
        });

        recordToolMetrics('update', 'success', Date.now() - startTime);
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
            action: 'update',
            actor,
            resource_id: args.id,
            result: 'error',
            error_code: err.code,
            client: { transport: 'stdio', pid: process.pid },
          });
          recordToolMetrics('update', 'error', Date.now() - startTime, err.code);
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
