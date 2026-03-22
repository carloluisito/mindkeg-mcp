/**
 * MCP tool: merge_learnings
 * Merges near-duplicate learnings into one canonical entry.
 * Deprecated duplicates are preserved in the database (soft delete via deprecation).
 * Traces to SKM-AC-1 through SKM-AC-7.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LearningService } from '../services/learning-service.js';
import type { StorageAdapter } from '../storage/storage-adapter.js';
import { isMindKegError, NotFoundError, ValidationError } from '../utils/errors.js';
import { authenticate } from '../auth/middleware.js';
import type { AuditLogger } from '../audit/audit-logger.js';
import { getActorFromApiKey, recordToolMetrics } from './tool-utils.js';

/**
 * Register the merge_learnings tool on the MCP server.
 * Signature matches the existing tool registration pattern.
 */
export function registerMergeLearnings(
  server: McpServer,
  learningService: LearningService,
  storage: StorageAdapter,
  getApiKey: () => string | undefined,
  auditLogger?: AuditLogger
): void {
  server.tool(
    'merge_learnings',
    'Merge near-duplicate learnings into one canonical entry. All duplicates are deprecated (not deleted), preserving history. Optionally provide merged_content to synthesize the best of both.',
    {
      canonical_id: z
        .string()
        .uuid()
        .describe('UUID of the learning to keep as the canonical entry.'),
      duplicate_ids: z
        .array(z.string().uuid())
        .min(1)
        .max(20)
        .describe('UUIDs of the duplicate learnings to deprecate. Min 1, max 20.'),
      merged_content: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe(
          'Optional merged content. When provided, the canonical learning is updated with this content and its embedding is regenerated. When omitted, the canonical learning is unchanged.'
        ),
    },
    async (args) => {
      const actor = getActorFromApiKey(getApiKey());
      const startTime = Date.now();
      try {
        // --- Input validation (SKM-AC-7) ---
        if (args.duplicate_ids.includes(args.canonical_id)) {
          throw new ValidationError('canonical_id must not appear in duplicate_ids');
        }

        // Fetch and verify canonical learning exists (SKM-AC-7)
        const canonical = await storage.getLearning(args.canonical_id);
        if (!canonical) {
          throw new NotFoundError(`Canonical learning not found: ${args.canonical_id}`);
        }
        if (canonical.status === 'deprecated') {
          throw new ValidationError(
            `Canonical learning is already deprecated: ${args.canonical_id}`
          );
        }

        // Authenticate against canonical learning's repository scope
        await authenticate(getApiKey(), storage, canonical.repository);

        // Verify all duplicate IDs exist and are not deprecated (SKM-AC-7)
        for (const dupId of args.duplicate_ids) {
          const dup = await storage.getLearning(dupId);
          if (!dup) {
            throw new NotFoundError(`Duplicate learning not found: ${dupId}`);
          }
          if (dup.status === 'deprecated') {
            throw new ValidationError(
              `Duplicate learning is already deprecated: ${dupId}`
            );
          }
        }

        // --- Merge: step 1 — optionally update canonical content (SKM-AC-2, SKM-AC-3) ---
        let updatedCanonical = canonical;
        if (args.merged_content !== undefined) {
          updatedCanonical = await learningService.updateLearning({
            id: args.canonical_id,
            content: args.merged_content,
          });
        }

        // --- Merge: step 2 — deprecate all duplicates (SKM-AC-4, SKM-AC-5) ---
        // deprecateLearning calls cleanupDuplicateCandidates internally (SKM-AC-5)
        for (const dupId of args.duplicate_ids) {
          await learningService.deprecateLearning({ id: dupId });
        }

        const deprecatedCount = args.duplicate_ids.length;

        // --- Audit entry (never include content in audit) ---
        if (auditLogger) {
          auditLogger.logEntry({
            timestamp: new Date().toISOString(),
            action: 'merge_learnings',
            actor,
            resource_id: args.canonical_id,
            result: 'success',
            client: { transport: 'stdio', pid: process.pid },
            metadata: {
              canonical_id: args.canonical_id,
              duplicate_count: deprecatedCount,
              merged_content_provided: args.merged_content !== undefined,
            },
          });
        }

        recordToolMetrics('merge_learnings', 'success', Date.now() - startTime);

        // --- Response (SKM-AC-6) ---
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  canonical: {
                    id: updatedCanonical.id,
                    content: updatedCanonical.content,
                    category: updatedCanonical.category,
                    tags: updatedCanonical.tags,
                    repository: updatedCanonical.repository,
                    workspace: updatedCanonical.workspace,
                    group_id: updatedCanonical.group_id,
                    source: updatedCanonical.source,
                    source_agent: updatedCanonical.source_agent,
                    status: updatedCanonical.status,
                    stale_flag: updatedCanonical.stale_flag,
                    created_at: updatedCanonical.created_at,
                    updated_at: updatedCanonical.updated_at,
                    ttl_days: updatedCanonical.ttl_days,
                    integrity_hash: updatedCanonical.integrity_hash,
                  },
                  deprecated_count: deprecatedCount,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        if (isMindKegError(err)) {
          if (auditLogger) {
            auditLogger.logEntry({
              timestamp: new Date().toISOString(),
              action: 'merge_learnings',
              actor,
              resource_id: args.canonical_id,
              result: 'error',
              error_code: err.code,
              client: { transport: 'stdio', pid: process.pid },
            });
          }
          recordToolMetrics('merge_learnings', 'error', Date.now() - startTime, err.code);
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
