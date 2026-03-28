/**
 * Decision model: type definitions and Zod validation schemas.
 * Decisions represent architectural choices with rationale and lifecycle tracking.
 * Traces to AMU-AC-1, AMU-AC-6, AMU-AC-7, AMU-AC-8.
 */
import { z } from 'zod';
import { stripControlChars } from '../security/sanitize.js';

/** The three allowed decision statuses (AMU-AC-1). */
export const DECISION_STATUSES = ['active', 'superseded', 'reverted'] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

/** Full Decision entity as stored in and returned from the database (AMU-AC-1). */
export interface Decision {
  id: string;
  repository: string;
  category: string;
  choice: string;
  rationale: string;
  made_by: string | null;
  made_at: string;
  status: DecisionStatus;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Zod schema for creating a new decision (AMU-AC-6). */
export const CreateDecisionInputSchema = z.object({
  /** Repository path for scoping. Required. */
  repository: z.string().min(1, 'repository must not be empty'),

  /**
   * Category of the decision (e.g., "database", "auth", "api-design"). Required.
   */
  category: z.string().min(1, 'category must not be empty'),

  /**
   * The decision made. Max 1000 characters (OQ-3).
   * Control characters are stripped.
   */
  choice: z
    .string()
    .min(1, 'choice must not be empty')
    .max(1000, 'choice must not exceed 1000 characters')
    .transform((val) => stripControlChars(val))
    .superRefine((val, ctx) => {
      if (val.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'choice must not be entirely whitespace',
        });
      }
    }),

  /**
   * Rationale explaining why this choice was made. Max 2000 characters (OQ-3).
   * Control characters are stripped.
   */
  rationale: z
    .string()
    .min(1, 'rationale must not be empty')
    .max(2000, 'rationale must not exceed 2000 characters')
    .transform((val) => stripControlChars(val))
    .superRefine((val, ctx) => {
      if (val.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'rationale must not be entirely whitespace',
        });
      }
    }),

  /** Optional: who or what made this decision (e.g., agent name). */
  made_by: z.string().optional().nullable(),
});

export type CreateDecisionInput = z.infer<typeof CreateDecisionInputSchema>;

/** Input for creating a decision record in storage (already validated). */
export interface CreateDecisionRecord {
  id: string;
  repository: string;
  category: string;
  choice: string;
  rationale: string;
  made_by?: string | null;
}

/** Input for updating a decision record in storage. */
export interface UpdateDecisionRecord {
  status?: DecisionStatus;
  superseded_by?: string | null;
  updated_at?: string;
}
