/**
 * MCP tool: relate_learnings
 * Create a typed relationship between two learnings, building the knowledge graph.
 * Traces to SKM-AC-39, SKM-AC-40, SKM-AC-46.
 */
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LearningService } from '../services/learning-service.js';
import type { StorageAdapter } from '../storage/storage-adapter.js';
import { RelateLearningsInputSchema, RELATIONSHIP_TYPES } from '../models/learning.js';
import { isMindKegError, NotFoundError, ValidationError, StorageError } from '../utils/errors.js';
import { authenticate } from '../auth/middleware.js';
import type { AuditLogger } from '../audit/audit-logger.js';
import { getActorFromApiKey, recordToolMetrics } from './tool-utils.js';
import { z } from 'zod';

export function registerRelateLearnings(
  server: McpServer,
  _learningService: LearningService,
  storage: StorageAdapter,
  getApiKey: () => string | undefined,
  auditLogger: AuditLogger
): void {
  server.tool(
    'relate_learnings',
    'Create a typed relationship between two learnings to build a knowledge graph. ' +
      'Relationship types: supersedes (source replaces target), depends_on (source requires target), ' +
      'related_to (general association), caused_by (source was caused by target). ' +
      'Returns the created relationship record.',
    {
      source_id: z
        .string()
        .uuid()
        .describe('UUID of the source learning (the one that has the relationship).'),
      target_id: z
        .string()
        .uuid()
        .describe('UUID of the target learning (the one being related to).'),
      relationship_type: z
        .enum(RELATIONSHIP_TYPES)
        .describe(
          "Type of relationship. One of: 'supersedes', 'depends_on', 'related_to', 'caused_by'."
        ),
      created_by: z
        .string()
        .optional()
        .describe('Optional: agent name creating this relationship (provenance).'),
    },
    async (args) => {
      const actor = getActorFromApiKey(getApiKey());
      const startTime = Date.now();
      try {
        // Validate input schema (catches invalid relationship_type)
        const parseResult = RelateLearningsInputSchema.safeParse(args);
        if (!parseResult.success) {
          throw new ValidationError(
            `Invalid relate_learnings input: ${parseResult.error.issues
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join(', ')}`
          );
        }
        const input = parseResult.data;

        // source_id and target_id must be different
        if (input.source_id === input.target_id) {
          throw new ValidationError(
            'source_id and target_id must be different — a learning cannot relate to itself'
          );
        }

        // Validate source learning exists (SKM-AC-40)
        const sourceLearning = await storage.getLearning(input.source_id);
        if (!sourceLearning) {
          throw new NotFoundError(`Source learning not found: ${input.source_id}`);
        }

        // Validate target learning exists (SKM-AC-40)
        const targetLearning = await storage.getLearning(input.target_id);
        if (!targetLearning) {
          throw new NotFoundError(`Target learning not found: ${input.target_id}`);
        }

        // Authenticate against source learning's repository scope
        await authenticate(getApiKey(), storage, sourceLearning.repository);

        // Create the relationship (storage enforces unique constraint per SKM-AC-40)
        let relationship;
        try {
          relationship = await storage.createRelationship({
            id: randomUUID(),
            source_id: input.source_id,
            target_id: input.target_id,
            relationship_type: input.relationship_type,
            created_by: input.created_by ?? null,
          });
        } catch (storageErr) {
          // Re-wrap duplicate constraint as a ValidationError for cleaner client messaging (SKM-AC-40)
          if (
            storageErr instanceof StorageError &&
            storageErr.message.includes('already exists')
          ) {
            throw new ValidationError(storageErr.message);
          }
          throw storageErr;
        }

        auditLogger.logEntry({
          timestamp: new Date().toISOString(),
          action: 'relate_learnings',
          actor,
          resource_id: relationship.id,
          result: 'success',
          client: { transport: 'stdio', pid: process.pid },
          metadata: {
            source_id: input.source_id,
            target_id: input.target_id,
            relationship_type: input.relationship_type,
          },
        });

        recordToolMetrics('relate_learnings', 'success', Date.now() - startTime);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  relationship,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        if (isMindKegError(err)) {
          auditLogger.logEntry({
            timestamp: new Date().toISOString(),
            action: 'relate_learnings',
            actor,
            resource_id: null,
            result: 'error',
            error_code: err.code,
            client: { transport: 'stdio', pid: process.pid },
          });
          recordToolMetrics('relate_learnings', 'error', Date.now() - startTime, err.code);
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
