/**
 * Shared utilities for MCP tool handlers.
 * Traces to ESH-AC-6, ESH-AC-22.
 */
import {
  mindkegToolInvocationsTotal,
  mindkegToolDurationSeconds,
  mindkegErrorsTotal,
  mindkegSearchLatencySeconds,
} from '../monitoring/metrics.js';
import { STDIO_LOCAL_SENTINEL } from '../auth/middleware.js';

/**
 * Derive the audit actor string from an API key.
 * - Returns "stdio-local" for the stdio sentinel key (local transport, no real key).
 * - Returns the first 8 characters of the key as a non-sensitive prefix for real keys.
 * - Returns "stdio" when no key is present.
 *
 * IMPORTANT: Never log the full API key (ESH-AC-9).
 */
export function getActorFromApiKey(apiKey: string | undefined): string {
  if (!apiKey) return 'stdio';
  if (apiKey === STDIO_LOCAL_SENTINEL) return 'stdio-local';
  // Use first 8 chars as prefix — enough to identify the key without exposing it
  return apiKey.slice(0, 8);
}

/**
 * Record metrics for a completed tool invocation (ESH-AC-22).
 *
 * @param tool - Tool name (e.g., "store_learning")
 * @param result - "success" or "error"
 * @param durationMs - Duration of the invocation in milliseconds
 * @param errorCode - Error code string if result is "error"
 */
export function recordToolMetrics(
  tool: string,
  result: 'success' | 'error',
  durationMs: number,
  errorCode?: string
): void {
  const durationSeconds = durationMs / 1000;

  mindkegToolInvocationsTotal.inc({ tool, result });
  mindkegToolDurationSeconds.observe({ tool }, durationSeconds);

  if (tool === 'search_learnings') {
    mindkegSearchLatencySeconds.observe(durationSeconds);
  }

  if (result === 'error' && errorCode) {
    mindkegErrorsTotal.inc({ code: errorCode });
  }
}
