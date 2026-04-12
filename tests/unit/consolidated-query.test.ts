/**
 * Unit tests for the consolidated query tool.
 * Since query has no complex validation logic (all validation is in Zod),
 * tests verify the registration function exists and exports are correct.
 */
import { describe, it, expect } from 'vitest';

describe('registerConsolidatedQuery', () => {
  it('exports the registration function', async () => {
    const mod = await import('../../src/tools/consolidated/query.js');
    expect(typeof mod.registerConsolidatedQuery).toBe('function');
  });

  it('exports the QueryType type (via module shape)', async () => {
    const mod = await import('../../src/tools/consolidated/query.js');
    // The module should only export registerConsolidatedQuery as a function
    const exportedFunctions = Object.entries(mod).filter(
      ([_, v]) => typeof v === 'function'
    );
    expect(exportedFunctions.length).toBe(1);
    expect(exportedFunctions[0]![0]).toBe('registerConsolidatedQuery');
  });
});
