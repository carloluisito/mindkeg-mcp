/**
 * MCP tool: store_learning
 * Stores a new atomic learning in the brain.
 * Traces to AC-1, AC-16.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LEARNING_CATEGORIES } from '../models/learning.js';
import type { LearningService } from '../services/learning-service.js';
import type { StorageAdapter } from '../storage/storage-adapter.js';
import { isMindKegError } from '../utils/errors.js';
import { authenticate } from '../auth/middleware.js';
import type { AuditLogger } from '../audit/audit-logger.js';
import { getActorFromApiKey, recordToolMetrics } from './tool-utils.js';

/**
 * Register the store_learning tool on the MCP server.
 */
export function registerStoreLearning(
  server: McpServer,
  learningService: LearningService,
  storage: StorageAdapter,
  getApiKey: () => string | undefined,
  auditLogger: AuditLogger
): void {
  server.tool(
    'store_learning',
    'Store a new atomic learning in the brain. Learnings are short, factual insights about a codebase or development pattern (max 500 characters).',
    {
      content: z
        .string()
        .min(1)
        .max(500)
        .describe('The learning text. Must be atomic — one insight per entry, 1-3 sentences, max 500 characters.'),
      category: z
        .enum(LEARNING_CATEGORIES)
        .optional()
        .nullable()
        .describe('Category: architecture, conventions, debugging, gotchas, dependencies, or decisions. Omit or pass null to auto-categorize via KNN voting (requires an embedding provider; SKM-AC-17).'),
      tags: z
        .array(z.string())
        .optional()
        .describe('Free-form labels for organization (e.g., ["typescript", "async"]).'),
      repository: z
        .string()
        .optional()
        .nullable()
        .describe('Absolute path to the repository this learning belongs to. Mutually exclusive with workspace. Omit or null for global learnings.'),
      workspace: z
        .string()
        .optional()
        .nullable()
        .describe('Absolute path to the workspace directory (parent of the repo). Use this for workspace-wide learnings that apply to all repos in this folder. Mutually exclusive with repository.'),
      group_id: z
        .string()
        .uuid()
        .optional()
        .nullable()
        .describe('UUID to link related learnings into a group.'),
      source: z
        .string()
        .optional()
        .describe('Who or what created this learning (e.g., "claude-code", "human"). Defaults to "agent".'),
      source_agent: z
        .string()
        .optional()
        .nullable()
        .describe('Provenance identifier: which agent or system created this learning (ESH-AC-25). Free-form string. E.g., "claude-code-3.7", "cursor-0.45".'),
      ttl_days: z
        .number()
        .int()
        .positive()
        .optional()
        .nullable()
        .describe('Time-to-live in days. Learning will be automatically purged after this many days from its last update (ESH-AC-15). Null or omit for no expiration.'),
    },
    async (args) => {
      const actor = getActorFromApiKey(getApiKey());
      const startTime = Date.now();
      try {
        // Authenticate before executing (AC-21)
        await authenticate(getApiKey(), storage, args.repository ?? null);

        const { learning, auto_categorized, conflicts } = await learningService.storeLearning({
          content: args.content,
          category: args.category ?? null,
          tags: args.tags,
          repository: args.repository ?? null,
          workspace: args.workspace ?? null,
          group_id: args.group_id ?? null,
          source: args.source,
          source_agent: args.source_agent ?? null,
          ttl_days: args.ttl_days ?? null,
        });

        auditLogger.logEntry({
          timestamp: new Date().toISOString(),
          action: 'store_learning',
          actor,
          resource_id: learning.id,
          result: 'success',
          client: { transport: 'stdio', pid: process.pid },
          metadata: {
            category: learning.category,
            auto_categorized,
            repository: args.repository ?? null,
            workspace: args.workspace ?? null,
            ttl_days: args.ttl_days ?? null,
          },
        });

        recordToolMetrics('store_learning', 'success', Date.now() - startTime);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                learning: {
                  id: learning.id,
                  content: learning.content,
                  category: learning.category,
                  tags: learning.tags,
                  repository: learning.repository,
                  workspace: learning.workspace,
                  group_id: learning.group_id,
                  source: learning.source,
                  source_agent: learning.source_agent,
                  status: learning.status,
                  created_at: learning.created_at,
                  embedding_generated: learning.embedding !== null,
                },
                auto_categorized,
                // SKM-AC-26: include detected conflicts in response
                conflicts: conflicts.map((c) => ({
                  conflict_id: c.id,
                  conflicting_learning_id: c.learning_id_a === learning.id ? c.learning_id_b : c.learning_id_a,
                  similarity: c.similarity,
                  conflict_type: c.conflict_type,
                })),
              }, null, 2),
            },
          ],
        };
      } catch (err) {
        if (isMindKegError(err)) {
          auditLogger.logEntry({
            timestamp: new Date().toISOString(),
            action: 'store_learning',
            actor,
            resource_id: null,
            result: 'error',
            error_code: err.code,
            client: { transport: 'stdio', pid: process.pid },
          });
          recordToolMetrics('store_learning', 'error', Date.now() - startTime, err.code);
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
