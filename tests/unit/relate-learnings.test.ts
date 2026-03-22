/**
 * Unit tests for RelateLearningsInputSchema and relationship model types.
 * Traces to SKM-AC-38, SKM-AC-39, SKM-AC-40.
 */
import { describe, it, expect } from 'vitest';
import {
  RelateLearningsInputSchema,
  RELATIONSHIP_TYPES,
} from '../../src/models/learning.js';

const VALID_UUID_A = '550e8400-e29b-41d4-a716-446655440000';
const VALID_UUID_B = '550e8400-e29b-41d4-a716-446655440001';

describe('RELATIONSHIP_TYPES', () => {
  it('contains exactly the four specified types', () => {
    expect(RELATIONSHIP_TYPES).toEqual(['supersedes', 'depends_on', 'related_to', 'caused_by']);
  });
});

describe('RelateLearningsInputSchema', () => {
  it('parses valid input with all four relationship types', () => {
    for (const type of RELATIONSHIP_TYPES) {
      const result = RelateLearningsInputSchema.safeParse({
        source_id: VALID_UUID_A,
        target_id: VALID_UUID_B,
        relationship_type: type,
      });
      expect(result.success, `Expected success for type: ${type}`).toBe(true);
      if (result.success) {
        expect(result.data.relationship_type).toBe(type);
        expect(result.data.created_by).toBeUndefined();
      }
    }
  });

  it('parses valid input with optional created_by', () => {
    const result = RelateLearningsInputSchema.safeParse({
      source_id: VALID_UUID_A,
      target_id: VALID_UUID_B,
      relationship_type: 'supersedes',
      created_by: 'claude-code',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.created_by).toBe('claude-code');
    }
  });

  it('rejects invalid source_id (not a UUID)', () => {
    const result = RelateLearningsInputSchema.safeParse({
      source_id: 'not-a-uuid',
      target_id: VALID_UUID_B,
      relationship_type: 'related_to',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toContain('source_id');
    }
  });

  it('rejects invalid target_id (not a UUID)', () => {
    const result = RelateLearningsInputSchema.safeParse({
      source_id: VALID_UUID_A,
      target_id: 'also-not-a-uuid',
      relationship_type: 'depends_on',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toContain('target_id');
    }
  });

  it('rejects invalid relationship_type', () => {
    const result = RelateLearningsInputSchema.safeParse({
      source_id: VALID_UUID_A,
      target_id: VALID_UUID_B,
      relationship_type: 'invalid_type',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toContain('relationship_type');
    }
  });

  it('rejects missing source_id', () => {
    const result = RelateLearningsInputSchema.safeParse({
      target_id: VALID_UUID_B,
      relationship_type: 'caused_by',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing target_id', () => {
    const result = RelateLearningsInputSchema.safeParse({
      source_id: VALID_UUID_A,
      relationship_type: 'supersedes',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing relationship_type', () => {
    const result = RelateLearningsInputSchema.safeParse({
      source_id: VALID_UUID_A,
      target_id: VALID_UUID_B,
    });
    expect(result.success).toBe(false);
  });
});
