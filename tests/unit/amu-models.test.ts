/**
 * Unit tests for AMU Zod models: decision, finding, gotcha, run-summary.
 * Traces to AMU-AC-1, AMU-AC-2, AMU-AC-3, AMU-AC-4.
 */
import { describe, it, expect } from 'vitest';
import { CreateDecisionInputSchema } from '../../src/models/decision.js';
import { CreateFindingInputSchema } from '../../src/models/finding.js';
import { CreateGotchaInputSchema } from '../../src/models/gotcha.js';
import { CompleteRunInputSchema } from '../../src/models/run-summary.js';

// ---------------------------------------------------------------------------
// Decision model
// ---------------------------------------------------------------------------

describe('CreateDecisionInputSchema', () => {
  const valid = {
    repository: '/repo/test',
    category: 'database',
    choice: 'Use SQLite for local storage',
    rationale: 'Zero external dependencies, built-in to Node.js 22+',
  };

  it('accepts valid input', () => {
    const result = CreateDecisionInputSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.repository).toBe('/repo/test');
      expect(result.data.category).toBe('database');
      expect(result.data.choice).toBe('Use SQLite for local storage');
      expect(result.data.rationale).toBe('Zero external dependencies, built-in to Node.js 22+');
      expect(result.data.made_by).toBeUndefined();
    }
  });

  it('accepts optional made_by', () => {
    const result = CreateDecisionInputSchema.safeParse({ ...valid, made_by: 'claude-code' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.made_by).toBe('claude-code');
  });

  it('rejects empty repository', () => {
    const result = CreateDecisionInputSchema.safeParse({ ...valid, repository: '' });
    expect(result.success).toBe(false);
  });

  it('rejects empty category', () => {
    const result = CreateDecisionInputSchema.safeParse({ ...valid, category: '' });
    expect(result.success).toBe(false);
  });

  it('rejects choice exceeding 1000 chars', () => {
    const result = CreateDecisionInputSchema.safeParse({ ...valid, choice: 'a'.repeat(1001) });
    expect(result.success).toBe(false);
  });

  it('rejects rationale exceeding 2000 chars', () => {
    const result = CreateDecisionInputSchema.safeParse({ ...valid, rationale: 'a'.repeat(2001) });
    expect(result.success).toBe(false);
  });

  it('accepts rationale exactly 2000 chars', () => {
    const result = CreateDecisionInputSchema.safeParse({ ...valid, rationale: 'a'.repeat(2000) });
    expect(result.success).toBe(true);
  });

  it('strips control characters from choice', () => {
    const choiceWithControl = 'Use SQLite\x00 for storage';
    const result = CreateDecisionInputSchema.safeParse({ ...valid, choice: choiceWithControl });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.choice).toBe('Use SQLite for storage');
  });

  it('rejects whitespace-only choice', () => {
    const result = CreateDecisionInputSchema.safeParse({ ...valid, choice: '   ' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Finding model
// ---------------------------------------------------------------------------

describe('CreateFindingInputSchema', () => {
  const valid = {
    repository: '/repo/test',
    file_path: 'src/auth.ts',
    severity: 'critical' as const,
    issue: 'JWT secret hardcoded',
    suggestion: 'Move to environment variable',
  };

  it('accepts valid input', () => {
    const result = CreateFindingInputSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.severity).toBe('critical');
      expect(result.data.file_path).toBe('src/auth.ts');
    }
  });

  it('accepts all severity values', () => {
    for (const severity of ['critical', 'warning', 'suggestion'] as const) {
      const result = CreateFindingInputSchema.safeParse({ ...valid, severity });
      expect(result.success).toBe(true);
    }
  });

  it('rejects invalid severity', () => {
    const result = CreateFindingInputSchema.safeParse({ ...valid, severity: 'blocker' });
    expect(result.success).toBe(false);
  });

  it('rejects issue exceeding 1000 chars', () => {
    const result = CreateFindingInputSchema.safeParse({ ...valid, issue: 'a'.repeat(1001) });
    expect(result.success).toBe(false);
  });

  it('rejects suggestion exceeding 1000 chars', () => {
    const result = CreateFindingInputSchema.safeParse({ ...valid, suggestion: 'a'.repeat(1001) });
    expect(result.success).toBe(false);
  });

  it('accepts optional found_by', () => {
    const result = CreateFindingInputSchema.safeParse({ ...valid, found_by: 'reviewer-agent' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.found_by).toBe('reviewer-agent');
  });

  it('strips control characters from issue', () => {
    const result = CreateFindingInputSchema.safeParse({ ...valid, issue: 'JWT\x00 secret hardcoded' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.issue).toBe('JWT secret hardcoded');
  });

  it('rejects whitespace-only suggestion', () => {
    const result = CreateFindingInputSchema.safeParse({ ...valid, suggestion: '\t\n  ' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Gotcha model
// ---------------------------------------------------------------------------

describe('CreateGotchaInputSchema', () => {
  const valid = {
    repository: '/repo/test',
    description: 'node:sqlite is synchronous — do not use await',
    tags: ['sqlite', 'async'],
  };

  it('accepts valid input', () => {
    const result = CreateGotchaInputSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tags).toEqual(['sqlite', 'async']);
      expect(result.data.technology).toBeUndefined();
    }
  });

  it('accepts optional technology', () => {
    const result = CreateGotchaInputSchema.safeParse({ ...valid, technology: 'sqlite' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.technology).toBe('sqlite');
  });

  it('accepts empty tags array', () => {
    const result = CreateGotchaInputSchema.safeParse({ ...valid, tags: [] });
    expect(result.success).toBe(true);
  });

  it('rejects description exceeding 1000 chars', () => {
    const result = CreateGotchaInputSchema.safeParse({ ...valid, description: 'a'.repeat(1001) });
    expect(result.success).toBe(false);
  });

  it('strips control characters from description', () => {
    const result = CreateGotchaInputSchema.safeParse({ ...valid, description: 'node:sqlite\x01 is sync' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.description).toBe('node:sqlite is sync');
  });

  it('rejects whitespace-only description', () => {
    const result = CreateGotchaInputSchema.safeParse({ ...valid, description: '   ' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RunSummary model
// ---------------------------------------------------------------------------

describe('CompleteRunInputSchema', () => {
  const valid = {
    repository: '/repo/test',
    summary: 'Implemented authentication',
  };

  it('accepts minimal valid input', () => {
    const result = CompleteRunInputSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.outcome).toBe('success'); // default
      expect(result.data.files_changed).toBeUndefined();
      expect(result.data.duration_seconds).toBeUndefined();
    }
  });

  it('accepts all outcome values', () => {
    for (const outcome of ['success', 'partial', 'failed'] as const) {
      const result = CompleteRunInputSchema.safeParse({ ...valid, outcome });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.outcome).toBe(outcome);
    }
  });

  it('defaults outcome to success', () => {
    const result = CompleteRunInputSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.outcome).toBe('success');
  });

  it('rejects invalid outcome', () => {
    const result = CompleteRunInputSchema.safeParse({ ...valid, outcome: 'errored' });
    expect(result.success).toBe(false);
  });

  it('accepts files_changed array', () => {
    const result = CompleteRunInputSchema.safeParse({
      ...valid,
      files_changed: ['src/auth.ts', 'tests/auth.test.ts'],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.files_changed).toEqual(['src/auth.ts', 'tests/auth.test.ts']);
  });

  it('accepts duration_seconds', () => {
    const result = CompleteRunInputSchema.safeParse({ ...valid, duration_seconds: 120 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.duration_seconds).toBe(120);
  });

  it('rejects negative duration_seconds', () => {
    const result = CompleteRunInputSchema.safeParse({ ...valid, duration_seconds: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects empty repository', () => {
    const result = CompleteRunInputSchema.safeParse({ ...valid, repository: '' });
    expect(result.success).toBe(false);
  });
});
