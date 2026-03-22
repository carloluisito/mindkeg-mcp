/**
 * Unit tests for MergeLearningsInputSchema validation.
 * Traces to SKM-AC-1, SKM-AC-7.
 */
import { describe, it, expect } from 'vitest';
import { MergeLearningsInputSchema } from '../../src/models/learning.js';

const UUID_A = '550e8400-e29b-41d4-a716-446655440001';
const UUID_B = '550e8400-e29b-41d4-a716-446655440002';
const UUID_C = '550e8400-e29b-41d4-a716-446655440003';

describe('MergeLearningsInputSchema', () => {
  // -------------------------------------------------------------------------
  // Valid inputs
  // -------------------------------------------------------------------------

  it('parses a minimal valid input (SKM-AC-1)', () => {
    const result = MergeLearningsInputSchema.safeParse({
      canonical_id: UUID_A,
      duplicate_ids: [UUID_B],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.canonical_id).toBe(UUID_A);
      expect(result.data.duplicate_ids).toEqual([UUID_B]);
      expect(result.data.merged_content).toBeUndefined();
    }
  });

  it('parses input with merged_content (SKM-AC-2)', () => {
    const result = MergeLearningsInputSchema.safeParse({
      canonical_id: UUID_A,
      duplicate_ids: [UUID_B],
      merged_content: 'Synthesized content from both learnings.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.merged_content).toBe('Synthesized content from both learnings.');
    }
  });

  it('parses input with multiple duplicate_ids', () => {
    const result = MergeLearningsInputSchema.safeParse({
      canonical_id: UUID_A,
      duplicate_ids: [UUID_B, UUID_C],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.duplicate_ids).toHaveLength(2);
    }
  });

  it('accepts exactly 20 duplicate_ids (max boundary)', () => {
    // Use a canonical that does not collide with the generated duplicate UUIDs
    const canonicalForBoundary = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    // Generate 20 distinct UUIDs in the 550e8400-... space; none will match the canonical
    const dupeUuids = Array.from(
      { length: 20 },
      (_, i) => `550e8400-0000-4000-a000-${String(i).padStart(12, '0')}`
    );
    const result = MergeLearningsInputSchema.safeParse({
      canonical_id: canonicalForBoundary,
      duplicate_ids: dupeUuids,
    });
    expect(result.success).toBe(true);
  });

  it('accepts merged_content of exactly 500 characters (max boundary)', () => {
    const result = MergeLearningsInputSchema.safeParse({
      canonical_id: UUID_A,
      duplicate_ids: [UUID_B],
      merged_content: 'a'.repeat(500),
    });
    expect(result.success).toBe(true);
  });

  // -------------------------------------------------------------------------
  // canonical_id in duplicate_ids — refine rule (SKM-AC-7)
  // -------------------------------------------------------------------------

  it('rejects when canonical_id appears in duplicate_ids (SKM-AC-7)', () => {
    const result = MergeLearningsInputSchema.safeParse({
      canonical_id: UUID_A,
      duplicate_ids: [UUID_A, UUID_B],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(
        'canonical_id must not appear in duplicate_ids'
      );
    }
  });

  it('rejects when canonical_id is the only entry in duplicate_ids (SKM-AC-7)', () => {
    const result = MergeLearningsInputSchema.safeParse({
      canonical_id: UUID_A,
      duplicate_ids: [UUID_A],
    });
    expect(result.success).toBe(false);
  });

  // -------------------------------------------------------------------------
  // UUID validation
  // -------------------------------------------------------------------------

  it('rejects a non-UUID canonical_id', () => {
    const result = MergeLearningsInputSchema.safeParse({
      canonical_id: 'not-a-uuid',
      duplicate_ids: [UUID_B],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-UUID entry in duplicate_ids', () => {
    const result = MergeLearningsInputSchema.safeParse({
      canonical_id: UUID_A,
      duplicate_ids: ['not-a-uuid'],
    });
    expect(result.success).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Array length validation
  // -------------------------------------------------------------------------

  it('rejects empty duplicate_ids (min 1)', () => {
    const result = MergeLearningsInputSchema.safeParse({
      canonical_id: UUID_A,
      duplicate_ids: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects 21 duplicate_ids (max 20)', () => {
    const canonicalForBoundary = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    const uuids = Array.from(
      { length: 21 },
      (_, i) => `550e8400-0000-4000-a000-${String(i).padStart(12, '0')}`
    );
    const result = MergeLearningsInputSchema.safeParse({
      canonical_id: canonicalForBoundary,
      duplicate_ids: uuids,
    });
    expect(result.success).toBe(false);
  });

  // -------------------------------------------------------------------------
  // merged_content validation
  // -------------------------------------------------------------------------

  it('rejects merged_content of empty string (min 1)', () => {
    const result = MergeLearningsInputSchema.safeParse({
      canonical_id: UUID_A,
      duplicate_ids: [UUID_B],
      merged_content: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects merged_content exceeding 500 characters (max 500)', () => {
    const result = MergeLearningsInputSchema.safeParse({
      canonical_id: UUID_A,
      duplicate_ids: [UUID_B],
      merged_content: 'a'.repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it('allows merged_content to be omitted (optional) (SKM-AC-3)', () => {
    const result = MergeLearningsInputSchema.safeParse({
      canonical_id: UUID_A,
      duplicate_ids: [UUID_B],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.merged_content).toBeUndefined();
    }
  });
});
