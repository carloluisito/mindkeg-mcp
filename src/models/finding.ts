/**
 * Finding model: type definitions and Zod validation schemas.
 * Findings represent code review issues with severity and resolution tracking.
 * Traces to AMU-AC-2, AMU-AC-9, AMU-AC-10, AMU-AC-11.
 */
import { z } from 'zod';
import { stripControlChars } from '../security/sanitize.js';

/** The three allowed finding severities (AMU-AC-2). */
export const FINDING_SEVERITIES = ['critical', 'warning', 'suggestion'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** The three allowed finding statuses (AMU-AC-2). */
export const FINDING_STATUSES = ['open', 'resolved', 'wont_fix'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/** Full Finding entity as stored in and returned from the database (AMU-AC-2). */
export interface Finding {
  id: string;
  repository: string;
  file_path: string;
  severity: FindingSeverity;
  issue: string;
  suggestion: string;
  status: FindingStatus;
  found_by: string | null;
  found_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Zod schema for creating a new finding (AMU-AC-9). */
export const CreateFindingInputSchema = z.object({
  /** Repository path for scoping. Required. */
  repository: z.string().min(1, 'repository must not be empty'),

  /** File path where the finding was identified. Required. */
  file_path: z.string().min(1, 'file_path must not be empty'),

  /** Severity level of the finding (AMU-AC-2). */
  severity: z.enum(FINDING_SEVERITIES),

  /**
   * Description of the issue found. Max 1000 characters (OQ-3).
   * Control characters are stripped.
   */
  issue: z
    .string()
    .min(1, 'issue must not be empty')
    .max(1000, 'issue must not exceed 1000 characters')
    .transform((val) => stripControlChars(val))
    .superRefine((val, ctx) => {
      if (val.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'issue must not be entirely whitespace',
        });
      }
    }),

  /**
   * Suggested fix or action. Max 1000 characters (OQ-3).
   * Control characters are stripped.
   */
  suggestion: z
    .string()
    .min(1, 'suggestion must not be empty')
    .max(1000, 'suggestion must not exceed 1000 characters')
    .transform((val) => stripControlChars(val))
    .superRefine((val, ctx) => {
      if (val.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'suggestion must not be entirely whitespace',
        });
      }
    }),

  /** Optional: who or what found this issue (e.g., agent name). */
  found_by: z.string().optional().nullable(),
});

export type CreateFindingInput = z.infer<typeof CreateFindingInputSchema>;

/** Input for creating a finding record in storage (already validated). */
export interface CreateFindingRecord {
  id: string;
  repository: string;
  file_path: string;
  severity: FindingSeverity;
  issue: string;
  suggestion: string;
  found_by?: string | null;
}

/** Input for updating a finding record in storage. */
export interface UpdateFindingRecord {
  status?: FindingStatus;
  resolved_at?: string | null;
  resolved_by?: string | null;
  updated_at?: string;
}
