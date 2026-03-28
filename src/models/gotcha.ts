/**
 * Gotcha model: type definitions and Zod validation schemas.
 * Gotchas represent non-obvious behaviors with automatic frequency tracking.
 * Traces to AMU-AC-3, AMU-AC-12, AMU-AC-13, AMU-AC-30, AMU-AC-31.
 */
import { z } from 'zod';
import { stripControlChars } from '../security/sanitize.js';

/** Full Gotcha entity as stored in and returned from the database (AMU-AC-3). */
export interface Gotcha {
  id: string;
  repository: string;
  description: string;
  tags: string[];
  technology: string | null;
  /** Embedding vector (float array) stored as JSON text. Used for similarity dedup (AMU-AC-30). */
  embedding: number[] | null;
  times_encountered: number;
  first_seen: string;
  last_seen: string;
  created_at: string;
  updated_at: string;
}

/** Zod schema for creating or deduplicating a gotcha (AMU-AC-12). */
export const CreateGotchaInputSchema = z.object({
  /** Repository path for scoping. Required. */
  repository: z.string().min(1, 'repository must not be empty'),

  /**
   * Description of the non-obvious behavior or footgun. Max 1000 characters (OQ-3).
   * Control characters are stripped.
   */
  description: z
    .string()
    .min(1, 'description must not be empty')
    .max(1000, 'description must not exceed 1000 characters')
    .transform((val) => stripControlChars(val))
    .superRefine((val, ctx) => {
      if (val.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'description must not be entirely whitespace',
        });
      }
    }),

  /** Free-form labels for organization and search. */
  tags: z.array(z.string()),

  /** Optional: technology this gotcha applies to (e.g., "react", "prisma", "sqlite"). */
  technology: z.string().optional().nullable(),
});

export type CreateGotchaInput = z.infer<typeof CreateGotchaInputSchema>;

/** Input for creating a gotcha record in storage (already validated). */
export interface CreateGotchaRecord {
  id: string;
  repository: string;
  description: string;
  tags: string[];
  technology?: string | null;
  embedding?: number[] | null;
}

/** Input for updating a gotcha record in storage. */
export interface UpdateGotchaRecord {
  times_encountered?: number;
  last_seen?: string;
  embedding?: number[] | null;
  updated_at?: string;
}
