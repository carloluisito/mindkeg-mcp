/**
 * Consolidated MCP tool: store
 * Single storage entry point that replaces store_learning, store_decision,
 * store_finding, and store_gotcha. Routes based on the `type` discriminator field.
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

/** The four knowledge types supported by the consolidated store tool. */
export type StoreType = 'learning' | 'decision' | 'finding' | 'gotcha';

/** Input shape for validateStoreInput. */
export interface StoreInput {
  type: StoreType;
  repository?: string | null;
  workspace?: string | null;
  // learning fields
  content?: string;
  category?: string | null;
  tags?: string[];
  source_agent?: string | null;
  ttl_days?: number | null;
  source?: string;
  group_id?: string | null;
  // decision fields
  choice?: string;
  rationale?: string;
  decision_category?: string;
  made_by?: string | null;
  // finding fields
  file_path?: string;
  severity?: 'critical' | 'warning' | 'suggestion';
  issue?: string;
  suggestion?: string;
  found_by?: string | null;
  // gotcha fields
  description?: string;
  technology?: string;
}

/**
 * Pure validation function that checks required fields based on the `type` discriminator.
 * Throws ValidationError if any required field is missing.
 *
 * @returns The input unchanged if valid.
 */
export function validateStoreInput(input: StoreInput): StoreInput {
  switch (input.type) {
    case 'learning': {
      if (!input.content) {
        throw new ValidationError('content is required for type=learning');
      }
      break;
    }
    case 'decision': {
      if (!input.choice) {
        throw new ValidationError('choice is required for type=decision');
      }
      if (!input.rationale) {
        throw new ValidationError('rationale is required for type=decision');
      }
      if (!input.repository) {
        throw new ValidationError('repository is required for type=decision');
      }
      break;
    }
    case 'finding': {
      if (!input.issue) {
        throw new ValidationError('issue is required for type=finding');
      }
      if (!input.severity) {
        throw new ValidationError('severity is required for type=finding');
      }
      if (!input.repository) {
        throw new ValidationError('repository is required for type=finding');
      }
      break;
    }
    case 'gotcha': {
      if (!input.description) {
        throw new ValidationError('description is required for type=gotcha');
      }
      if (!input.repository) {
        throw new ValidationError('repository is required for type=gotcha');
      }
      break;
    }
  }
  return input;
}

/**
 * Register the consolidated store tool on the MCP server.
 * Replaces the original store_learning, store_decision, store_finding, and store_gotcha tools.
 */
export function registerConsolidatedStore(
  server: McpServer,
  learningService: LearningService,
  entityService: EntityService,
  storage: StorageAdapter,
  getApiKey: () => string | undefined,
  auditLogger: AuditLogger
): void {
  server.tool(
    'store',
    'Save a piece of knowledge. Types: learning (short insight, max 500 chars), decision (architectural choice with rationale), finding (code review issue), gotcha (non-obvious behavior). Before calling this, ask the user if they want to save it and which scope — this repo, workspace, or global.',
    {
      type: z.enum(['learning', 'decision', 'finding', 'gotcha']).describe('Type of knowledge to store.'),
      repository: z.string().optional().nullable().describe('Repository path. Required for decision, finding, gotcha. Optional for learning.'),
      workspace: z.string().optional().nullable().describe('Workspace path. Mutually exclusive with repository.'),
      // learning fields
      content: z.string().min(1).max(500).optional().describe('Learning text (type=learning). Max 500 chars.'),
      category: z.enum(LEARNING_CATEGORIES).optional().nullable().describe('Category (type=learning). Omit for auto-categorization.'),
      tags: z.array(z.string()).optional().describe('Tags for organization.'),
      source_agent: z.string().optional().nullable().describe('Agent name for provenance.'),
      ttl_days: z.number().int().positive().optional().nullable().describe('Time-to-live in days (type=learning).'),
      source: z.string().optional().describe('Who created this. Defaults to "agent".'),
      group_id: z.string().uuid().optional().nullable().describe('Group UUID (type=learning).'),
      // decision fields
      choice: z.string().min(1).max(1000).optional().describe('What was decided (type=decision).'),
      rationale: z.string().min(1).max(2000).optional().describe('Why (type=decision).'),
      decision_category: z.string().min(1).optional().describe('Decision category (type=decision).'),
      made_by: z.string().optional().nullable().describe('Who made this decision.'),
      // finding fields
      file_path: z.string().optional().describe('File path (type=finding).'),
      severity: z.enum(['critical', 'warning', 'suggestion']).optional().describe('Severity (type=finding).'),
      issue: z.string().min(1).max(1000).optional().describe('The issue (type=finding).'),
      suggestion: z.string().max(1000).optional().describe('How to fix (type=finding).'),
      found_by: z.string().optional().nullable().describe('Who found this.'),
      // gotcha fields
      description: z.string().optional().describe('The behavior (type=gotcha).'),
      technology: z.string().optional().describe('Technology (type=gotcha).'),
    },
    async (args) => {
      const actor = getActorFromApiKey(getApiKey());
      const startTime = Date.now();
      try {
        await authenticate(getApiKey(), storage, args.repository ?? null);

        validateStoreInput({
          type: args.type,
          repository: args.repository,
          workspace: args.workspace,
          content: args.content,
          category: args.category,
          tags: args.tags,
          source_agent: args.source_agent,
          ttl_days: args.ttl_days,
          source: args.source,
          group_id: args.group_id,
          choice: args.choice,
          rationale: args.rationale,
          decision_category: args.decision_category,
          made_by: args.made_by,
          file_path: args.file_path,
          severity: args.severity,
          issue: args.issue,
          suggestion: args.suggestion,
          found_by: args.found_by,
          description: args.description,
          technology: args.technology,
        });

        let result: unknown;

        switch (args.type) {
          case 'learning': {
            const storeResult = await learningService.storeLearning({
              content: args.content!,
              category: args.category ?? null,
              tags: args.tags,
              repository: args.repository ?? null,
              workspace: args.workspace ?? null,
              group_id: args.group_id ?? null,
              source: args.source,
              source_agent: args.source_agent ?? null,
              ttl_days: args.ttl_days ?? null,
            });
            result = {
              success: true,
              type: 'learning' as const,
              learning: {
                id: storeResult.learning.id,
                content: storeResult.learning.content,
                category: storeResult.learning.category,
                tags: storeResult.learning.tags,
                repository: storeResult.learning.repository,
                workspace: storeResult.learning.workspace,
                status: storeResult.learning.status,
                created_at: storeResult.learning.created_at,
              },
              auto_categorized: storeResult.auto_categorized,
              conflicts: storeResult.conflicts,
            };
            break;
          }
          case 'decision': {
            const decision = await entityService.storeDecision({
              repository: args.repository!,
              category: args.decision_category ?? 'general',
              choice: args.choice!,
              rationale: args.rationale!,
              made_by: args.made_by ?? null,
            });
            result = {
              success: true,
              type: 'decision' as const,
              decision,
            };
            break;
          }
          case 'finding': {
            const finding = await entityService.storeFinding({
              repository: args.repository!,
              file_path: args.file_path ?? '',
              severity: args.severity!,
              issue: args.issue!,
              suggestion: args.suggestion ?? '',
              found_by: args.found_by ?? null,
            });
            result = {
              success: true,
              type: 'finding' as const,
              finding,
            };
            break;
          }
          case 'gotcha': {
            const gotchaResult = await entityService.storeGotcha({
              repository: args.repository!,
              description: args.description!,
              tags: args.tags ?? [],
              technology: args.technology ?? null,
            });
            result = {
              success: true,
              type: 'gotcha' as const,
              gotcha: gotchaResult.gotcha,
              incremented: gotchaResult.incremented,
            };
            break;
          }
        }

        auditLogger.logEntry({
          timestamp: new Date().toISOString(),
          action: 'store',
          actor,
          resource_id: null,
          result: 'success',
          client: { transport: 'stdio', pid: process.pid },
          metadata: {
            type: args.type,
            repository: args.repository ?? null,
            workspace: args.workspace ?? null,
          },
        });

        recordToolMetrics('store', 'success', Date.now() - startTime);
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
            action: 'store',
            actor,
            resource_id: null,
            result: 'error',
            error_code: err.code,
            client: { transport: 'stdio', pid: process.pid },
          });
          recordToolMetrics('store', 'error', Date.now() - startTime, err.code);
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
