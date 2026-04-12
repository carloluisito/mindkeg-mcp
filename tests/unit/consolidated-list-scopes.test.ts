/**
 * Unit tests for the consolidated list_scopes tool.
 * Minimal tests — verify the registration function exports exist.
 */
import { describe, it, expect } from 'vitest';

describe('registerConsolidatedListScopes', () => {
  it('exports the registration function', async () => {
    const mod = await import('../../src/tools/consolidated/list-scopes.js');
    expect(typeof mod.registerConsolidatedListScopes).toBe('function');
  });

  it('exports only the registration function', async () => {
    const mod = await import('../../src/tools/consolidated/list-scopes.js');
    const exportedFunctions = Object.entries(mod).filter(
      ([_, v]) => typeof v === 'function'
    );
    expect(exportedFunctions.length).toBe(1);
    expect(exportedFunctions[0]![0]).toBe('registerConsolidatedListScopes');
  });
});
