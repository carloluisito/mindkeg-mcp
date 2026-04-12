/**
 * Unit tests for the consolidated update tool's validateUpdateInput function.
 */
import { describe, it, expect } from 'vitest';
import { validateUpdateInput } from '../../src/tools/consolidated/update.js';
import { ValidationError } from '../../src/utils/errors.js';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const OTHER_UUID = '660e8400-e29b-41d4-a716-446655440001';

describe('validateUpdateInput', () => {
  it('throws when action=merge and duplicate_ids is missing', () => {
    expect(() =>
      validateUpdateInput({
        action: 'merge',
        id: VALID_UUID,
      })
    ).toThrow(ValidationError);
    expect(() =>
      validateUpdateInput({
        action: 'merge',
        id: VALID_UUID,
      })
    ).toThrow('duplicate_ids is required for merge action');
  });

  it('throws when action=merge and duplicate_ids is empty', () => {
    expect(() =>
      validateUpdateInput({
        action: 'merge',
        id: VALID_UUID,
        duplicate_ids: [],
      })
    ).toThrow('duplicate_ids is required for merge action');
  });

  it('throws when action=merge and id is in duplicate_ids', () => {
    expect(() =>
      validateUpdateInput({
        action: 'merge',
        id: VALID_UUID,
        duplicate_ids: [VALID_UUID, OTHER_UUID],
      })
    ).toThrow('canonical_id must not appear in duplicate_ids');
  });

  it('returns input when action=update with valid input', () => {
    const input = {
      action: 'update' as const,
      id: VALID_UUID,
      content: 'Updated content',
    };
    const result = validateUpdateInput(input);
    expect(result).toBe(input);
  });

  it('returns input when action=deprecate with valid input', () => {
    const input = {
      action: 'deprecate' as const,
      id: VALID_UUID,
      reason: 'No longer relevant',
    };
    const result = validateUpdateInput(input);
    expect(result).toBe(input);
  });

  it('returns input when action=flag_stale with valid input', () => {
    const input = {
      action: 'flag_stale' as const,
      id: VALID_UUID,
    };
    const result = validateUpdateInput(input);
    expect(result).toBe(input);
  });

  it('returns input when action=delete with valid input', () => {
    const input = {
      action: 'delete' as const,
      id: VALID_UUID,
    };
    const result = validateUpdateInput(input);
    expect(result).toBe(input);
  });

  it('returns input when action=merge with valid duplicate_ids', () => {
    const input = {
      action: 'merge' as const,
      id: VALID_UUID,
      duplicate_ids: [OTHER_UUID],
      merged_content: 'Combined content',
    };
    const result = validateUpdateInput(input);
    expect(result).toBe(input);
  });
});

describe('registerConsolidatedUpdate', () => {
  it('exports the registration function', async () => {
    const mod = await import('../../src/tools/consolidated/update.js');
    expect(typeof mod.registerConsolidatedUpdate).toBe('function');
  });
});
