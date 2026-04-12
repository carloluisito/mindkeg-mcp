/**
 * Unit tests for the consolidated resolve tool's validateResolveInput function.
 */
import { describe, it, expect } from 'vitest';
import { validateResolveInput } from '../../src/tools/consolidated/resolve.js';
import { ValidationError } from '../../src/utils/errors.js';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const NEW_UUID = '660e8400-e29b-41d4-a716-446655440001';

describe('validateResolveInput', () => {
  it('throws when type=decision and new_decision_id is missing', () => {
    expect(() =>
      validateResolveInput({
        type: 'decision',
        id: VALID_UUID,
      })
    ).toThrow(ValidationError);
    expect(() =>
      validateResolveInput({
        type: 'decision',
        id: VALID_UUID,
      })
    ).toThrow('new_decision_id is required for type=decision');
  });

  it('returns input when type=decision with valid new_decision_id', () => {
    const input = {
      type: 'decision' as const,
      id: VALID_UUID,
      new_decision_id: NEW_UUID,
    };
    const result = validateResolveInput(input);
    expect(result).toBe(input);
  });

  it('returns input when type=finding with valid input', () => {
    const input = {
      type: 'finding' as const,
      id: VALID_UUID,
      resolved_by: 'developer@example.com',
    };
    const result = validateResolveInput(input);
    expect(result).toBe(input);
  });

  it('returns input when type=finding without resolved_by', () => {
    const input = {
      type: 'finding' as const,
      id: VALID_UUID,
    };
    const result = validateResolveInput(input);
    expect(result).toBe(input);
  });
});

describe('registerConsolidatedResolve', () => {
  it('exports the registration function', async () => {
    const mod = await import('../../src/tools/consolidated/resolve.js');
    expect(typeof mod.registerConsolidatedResolve).toBe('function');
  });
});
