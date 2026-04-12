/**
 * Consolidated MCP tool: get_context
 * Single retrieval entry point that replaces get_context, get_relevant_context,
 * and search_learnings. Routes based on which parameters are provided:
 *
 * - repository only (no query, no task_description) -> session_primer -> learningService.getContext()
 * - repository + task_description -> entity_context -> entityService.getRelevantContext()
 * - query (with optional filters) -> semantic_search -> learningService.searchLearnings()
 * - repository + task_description + query -> entity_context (task_description takes priority)
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LEARNING_CATEGORIES } from '../../models/learning.js';
import type { LearningService } from '../../services/learning-service.js';
import type { EntityService } from '../../services/entity-service.js';
import type { StorageAdapter } from '../../storage/storage-adapter.js';
import { isMindKegError, ValidationError } from '../../utils/errors.js';
import { authenticate } from '../../auth/middleware.js';
import type { AuditLogger } from '../../audit/audit-logger.js';
import { getActorFromApiKey, recordToolMetrics } from '../tool-utils.js';

/** The three possible routing modes for the consolidated get_context tool. */
export type GetContextRoute = 'session_primer' | 'entity_context' | 'semantic_search';

/** Input shape for routeGetContext — mirrors the tool's Zod schema fields. */
export interface RouteGetContextArgs {
  repository?: string;
  workspace?: string;
  task_description?: string;
  query?: string;
}

/**
 * Pure routing function that determines which service to delegate to
 * based on the combination of parameters provided.
 *
 * @throws ValidationError if no repository, workspace, or query is provided
 * @throws ValidationError if session_primer or entity_context route is selected but repository is missing
 */
export function routeGetContext(args: RouteGetContextArgs): GetContextRoute {
  const hasRepository = !!args.repository;
  const hasWorkspace = !!args.workspace;
  const hasQuery = !!args.query;
  const hasTaskDescription = !!args.task_description;

  // Validation: at least one of repository, workspace, or query must be provided
  if (!hasRepository && !hasWorkspace && !hasQuery) {
    throw new ValidationError('At least one of repository, workspace, or query must be provided.');
  }

  // task_description takes priority -> entity_context
  if (hasTaskDescription) {
    if (!hasRepository) {
      throw new ValidationError('repository is required when task_description is provided.');
    }
    return 'entity_context';
  }

  // query present (no task_description) -> semantic_search
  if (hasQuery) {
    return 'semantic_search';
  }

  // No query, no task_description -> session_primer (requires repository)
  if (!hasRepository) {
    throw new ValidationError('repository is required for session primer mode (no query or task_description provided).');
  }
  return 'session_primer';
}

/**
 * Register the consolidated get_context tool on the MCP server.
 * Replaces the original get_context, get_relevant_context, and search_learnings tools.
 */
export function registerConsolidatedGetContext(
  server: McpServer,
  learningService: LearningService,
  entityService: EntityService,
  storage: StorageAdapter,
  getApiKey: () => string | undefined,
  auditLogger: AuditLogger
): void {
  server.tool(
    'get_context',
    'Retrieve relevant knowledge for your current session. Call this at the start of every session with at least the repository path. Add task_description for task-scoped context across all knowledge types (decisions, findings, gotchas, learnings, run history). Add query for semantic search on a specific topic. Returns knowledge ranked by relevance and trimmed to budget.',
    {
      repository: z
        .string()
        .optional()
        .describe('Absolute path to the current repository.'),
      workspace: z
        .string()
        .optional()
        .describe('Absolute path to the workspace directory.'),
      task_description: z
        .string()
        .optional()
        .describe('Description of the current task. When provided with repository, retrieves context across all knowledge types (decisions, findings, gotchas, learnings, run history).'),
      query: z
        .string()
        .optional()
        .describe('Semantic search query for a specific topic.'),
      category: z
        .enum(LEARNING_CATEGORIES)
        .optional()
        .describe('Filter by category (semantic_search route only).'),
      tags: z
        .array(z.string())
        .optional()
        .describe('Filter by any matching tag (semantic_search route only).'),
      budget: z
        .enum(['compact', 'standard', 'full'])
        .optional()
        .describe('Character budget preset. compact ~2000 chars, standard ~5000 chars (default), full ~12000 chars.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Maximum number of results (semantic_search route only, default 10, max 50).'),
      include_stale: z
        .boolean()
        .optional()
        .describe('When true, stale-flagged learnings are included (session_primer route).'),
      include_deprecated: z
        .boolean()
        .optional()
        .describe('Include deprecated learnings in results (semantic_search route, default false).'),
      verify_integrity: z
        .boolean()
        .optional()
        .default(false)
        .describe('When true, each returned learning includes integrity_valid: boolean.'),
    },
    async (args) => {
      const actor = getActorFromApiKey(getApiKey());
      const startTime = Date.now();
      try {
        await authenticate(getApiKey(), storage, args.repository ?? null);

        const route = routeGetContext({
          repository: args.repository,
          workspace: args.workspace,
          task_description: args.task_description,
          query: args.query,
        });

        let result: unknown;

        switch (route) {
          case 'session_primer': {
            result = await learningService.getContext({
              repository: args.repository!,
              workspace: args.workspace,
              query: args.query,
              budget: args.budget,
              include_stale: args.include_stale,
              verify_integrity: args.verify_integrity,
            });
            break;
          }
          case 'entity_context': {
            result = await entityService.getRelevantContext(
              args.repository!,
              args.task_description!,
              args.budget ?? 'standard'
            );
            break;
          }
          case 'semantic_search': {
            const searchResults = await learningService.searchLearnings({
              query: args.query!,
              repository: args.repository,
              workspace: args.workspace,
              category: args.category,
              tags: args.tags,
              limit: args.limit,
              include_deprecated: args.include_deprecated,
              verify_integrity: args.verify_integrity,
            });
            result = {
              query: args.query,
              count: searchResults.length,
              results: searchResults,
            };
            break;
          }
        }

        auditLogger.logEntry({
          timestamp: new Date().toISOString(),
          action: 'get_context',
          actor,
          resource_id: null,
          result: 'success',
          client: { transport: 'stdio', pid: process.pid },
          metadata: {
            route,
            repository: args.repository ?? null,
            workspace: args.workspace ?? null,
            budget: args.budget ?? 'standard',
            verify_integrity: args.verify_integrity,
          },
        });

        recordToolMetrics('get_context', 'success', Date.now() - startTime);
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
            action: 'get_context',
            actor,
            resource_id: null,
            result: 'error',
            error_code: err.code,
            client: { transport: 'stdio', pid: process.pid },
          });
          recordToolMetrics('get_context', 'error', Date.now() - startTime, err.code);
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
