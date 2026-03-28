/**
 * MCP tool: store_gotcha
 * Stores a non-obvious behavior or footgun with automatic deduplication.
 * If a similar gotcha exists, increments its times_encountered counter instead of creating a duplicate.
 * Traces to AMU-AC-12, AMU-AC-30, AMU-AC-31.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EntityService } from '../services/entity-service.js';
import type { StorageAdapter } from '../storage/storage-adapter.js';
import { isMindKegError } from '../utils/errors.js';
import { authenticate } from '../auth/middleware.js';
import { recordToolMetrics } from './tool-utils.js';

/**
 * Register the store_gotcha tool on the MCP server.
 */
export function registerStoreGotcha(
  server: McpServer,
  entityService: EntityService,
  storage: StorageAdapter,
  getApiKey: () => string | undefined
): void {
  server.tool(
    'store_gotcha',
    'Store a non-obvious behavior, footgun, or recurring trap. Automatically detects similar gotchas (cosine similarity >= 0.85) and increments their frequency counter instead of creating duplicates. High-frequency gotchas are surfaced first in context retrieval.',
    {
      repository: z
        .string()
        .min(1)
        .describe('Absolute path to the repository.'),
      description: z
        .string()
        .min(1)
        .max(1000)
        .describe('What the gotcha is. Be specific — describe the surprising behavior and what breaks. Max 1000 characters.'),
      tags: z
        .array(z.string())
        .describe('Labels for searchability (e.g., ["prisma", "async", "typescript"]).'),
      technology: z
        .string()
        .optional()
        .nullable()
        .describe('Optional: primary technology this gotcha applies to (e.g., "react", "prisma", "sqlite").'),
    },
    async (args) => {
      const startTime = Date.now();
      try {
        await authenticate(getApiKey(), storage, args.repository);

        const result = await entityService.storeGotcha({
          repository: args.repository,
          description: args.description,
          tags: args.tags,
          technology: args.technology ?? null,
        });

        recordToolMetrics('store_gotcha', 'success', Date.now() - startTime);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  gotcha: result.gotcha,
                  incremented: result.incremented,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        if (isMindKegError(err)) {
          recordToolMetrics('store_gotcha', 'error', Date.now() - startTime, err.code);
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
