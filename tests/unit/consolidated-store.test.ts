/**
 * Unit tests for the consolidated store validation function.
 * Tests the pure validateStoreInput() function which checks required
 * fields based on the type discriminator.
 */
import { describe, it, expect } from 'vitest';
import { validateStoreInput } from '../../src/tools/consolidated/store.js';
import { ValidationError } from '../../src/utils/errors.js';

describe('validateStoreInput', () => {
  it('throws ValidationError when type=learning without content', () => {
    expect(() => validateStoreInput({ type: 'learning' })).toThrow(ValidationError);
    expect(() => validateStoreInput({ type: 'learning' })).toThrow(
      'content is required for type=learning'
    );
  });

  it('throws ValidationError when type=decision without choice', () => {
    expect(() =>
      validateStoreInput({
        type: 'decision',
        rationale: 'because',
        repository: '/repo',
      })
    ).toThrow(ValidationError);
    expect(() =>
      validateStoreInput({
        type: 'decision',
        rationale: 'because',
        repository: '/repo',
      })
    ).toThrow('choice is required for type=decision');
  });

  it('throws ValidationError when type=decision without rationale', () => {
    expect(() =>
      validateStoreInput({
        type: 'decision',
        choice: 'use React',
        repository: '/repo',
      })
    ).toThrow(ValidationError);
    expect(() =>
      validateStoreInput({
        type: 'decision',
        choice: 'use React',
        repository: '/repo',
      })
    ).toThrow('rationale is required for type=decision');
  });

  it('throws ValidationError when type=decision without repository', () => {
    expect(() =>
      validateStoreInput({
        type: 'decision',
        choice: 'use React',
        rationale: 'because',
      })
    ).toThrow(ValidationError);
    expect(() =>
      validateStoreInput({
        type: 'decision',
        choice: 'use React',
        rationale: 'because',
      })
    ).toThrow('repository is required for type=decision');
  });

  it('throws ValidationError when type=finding without issue', () => {
    expect(() =>
      validateStoreInput({
        type: 'finding',
        severity: 'warning',
        repository: '/repo',
      })
    ).toThrow(ValidationError);
    expect(() =>
      validateStoreInput({
        type: 'finding',
        severity: 'warning',
        repository: '/repo',
      })
    ).toThrow('issue is required for type=finding');
  });

  it('throws ValidationError when type=finding without severity', () => {
    expect(() =>
      validateStoreInput({
        type: 'finding',
        issue: 'unused import',
        repository: '/repo',
      })
    ).toThrow(ValidationError);
    expect(() =>
      validateStoreInput({
        type: 'finding',
        issue: 'unused import',
        repository: '/repo',
      })
    ).toThrow('severity is required for type=finding');
  });

  it('throws ValidationError when type=finding without repository', () => {
    expect(() =>
      validateStoreInput({
        type: 'finding',
        issue: 'unused import',
        severity: 'warning',
      })
    ).toThrow(ValidationError);
    expect(() =>
      validateStoreInput({
        type: 'finding',
        issue: 'unused import',
        severity: 'warning',
      })
    ).toThrow('repository is required for type=finding');
  });

  it('throws ValidationError when type=gotcha without description', () => {
    expect(() =>
      validateStoreInput({
        type: 'gotcha',
        repository: '/repo',
      })
    ).toThrow(ValidationError);
    expect(() =>
      validateStoreInput({
        type: 'gotcha',
        repository: '/repo',
      })
    ).toThrow('description is required for type=gotcha');
  });

  it('throws ValidationError when type=gotcha without repository', () => {
    expect(() =>
      validateStoreInput({
        type: 'gotcha',
        description: 'SQLite is synchronous',
      })
    ).toThrow(ValidationError);
    expect(() =>
      validateStoreInput({
        type: 'gotcha',
        description: 'SQLite is synchronous',
      })
    ).toThrow('repository is required for type=gotcha');
  });

  it('returns input for valid learning', () => {
    const input = {
      type: 'learning' as const,
      content: 'Always use parameterized queries',
      category: 'conventions' as const,
      tags: ['sql', 'security'],
      repository: '/repo',
    };
    expect(validateStoreInput(input)).toEqual(input);
  });

  it('returns input for valid decision', () => {
    const input = {
      type: 'decision' as const,
      choice: 'Use SQLite over PostgreSQL',
      rationale: 'Simpler deployment, no external dependencies',
      repository: '/repo',
      decision_category: 'architecture',
    };
    expect(validateStoreInput(input)).toEqual(input);
  });
});

describe('store tool description', () => {
  it('contains proactive storage cues', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(
      resolve(__dirname, '..', '..', 'src', 'tools', 'consolidated', 'store.ts'),
      'utf-8'
    );

    expect(source).toContain('Call this proactively');
    expect(source).toContain('Always ask the user first');
    expect(source).toContain('scope (this repo / workspace / global)');
  });
});
