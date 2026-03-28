/**
 * RunSummary model: type definitions and Zod validation schemas.
 * Run summaries record what happened in each execution run.
 * Traces to AMU-AC-4, AMU-AC-14, AMU-AC-15.
 * Note: No decisions_made/findings_found columns per OQ-1 resolution.
 */
import { z } from 'zod';

/** The three allowed run outcomes (AMU-AC-4). */
export const RUN_OUTCOMES = ['success', 'partial', 'failed'] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/** Full RunSummary entity as stored in and returned from the database (AMU-AC-4). */
export interface RunSummary {
  id: string;
  repository: string;
  summary: string;
  /** Array of file paths changed during the run. Stored as JSON text. */
  files_changed: string[];
  started_at: string;
  duration_seconds: number | null;
  outcome: RunOutcome;
  created_at: string;
}

/** Zod schema for completing a run (AMU-AC-14). */
export const CompleteRunInputSchema = z.object({
  /** Repository path for scoping. Required. */
  repository: z.string().min(1, 'repository must not be empty'),

  /** Free-form summary of what happened in this run. Required. */
  summary: z.string().min(1, 'summary must not be empty'),

  /** Optional: list of file paths changed during this run. */
  files_changed: z.array(z.string()).optional(),

  /** Optional: run outcome. Defaults to "success" (AMU-AC-14). */
  outcome: z.enum(RUN_OUTCOMES).default('success'),

  /** Optional: total duration in seconds. */
  duration_seconds: z.number().int().nonnegative().optional().nullable(),
});

export type CompleteRunInput = z.infer<typeof CompleteRunInputSchema>;

/** Input for creating a run summary record in storage (already validated). */
export interface CreateRunSummaryRecord {
  id: string;
  repository: string;
  summary: string;
  files_changed: string[];
  outcome: RunOutcome;
  duration_seconds?: number | null;
}
