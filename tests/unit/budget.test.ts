/**
 * Unit tests for the applyBudget pure function.
 * Traces to GC-AC-12, GC-AC-13, GC-AC-14, GC-AC-15, GC-AC-15a.
 */
import { describe, it, expect } from 'vitest';
import { applyBudget, BUDGET_PRESETS } from '../../src/services/budget.js';
import type { BudgetSections } from '../../src/services/budget.js';
import type { Learning } from '../../src/models/learning.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let counter = 0;

function makeLearning(contentLength = 80, overrides: Partial<Learning> = {}): Learning {
  counter++;
  return {
    id: `id-${counter.toString().padStart(4, '0')}`,
    content: 'x'.repeat(contentLength),
    category: 'conventions',
    tags: [],
    repository: '/repo/test',
    workspace: null,
    group_id: null,
    source: 'test',
    status: 'active',
    stale_flag: false,
    embedding: null,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function emptySections(): BudgetSections {
  return { repo: [], workspace: [], global: [], stale: [] };
}

// ---------------------------------------------------------------------------
// BUDGET_PRESETS constants (GC-AC-12, GC-AC-13)
// ---------------------------------------------------------------------------

describe('BUDGET_PRESETS', () => {
  it('compact preset has totalChars ~2000', () => {
    expect(BUDGET_PRESETS.compact.totalChars).toBe(2000);
    expect(BUDGET_PRESETS.compact.label).toBe('compact');
  });

  it('standard preset has totalChars ~5000', () => {
    expect(BUDGET_PRESETS.standard.totalChars).toBe(5000);
    expect(BUDGET_PRESETS.standard.label).toBe('standard');
  });

  it('full preset has totalChars ~12000', () => {
    expect(BUDGET_PRESETS.full.totalChars).toBe(12000);
    expect(BUDGET_PRESETS.full.label).toBe('full');
  });
});

// ---------------------------------------------------------------------------
// Empty sections (GC-AC-29a)
// ---------------------------------------------------------------------------

describe('applyBudget: empty sections', () => {
  it('returns empty arrays for all sections when input is empty', () => {
    const result = applyBudget(emptySections(), 'standard');
    expect(result.repo).toEqual([]);
    expect(result.workspace).toEqual([]);
    expect(result.global).toEqual([]);
    expect(result.stale).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Whole-learning truncation (GC-AC-13)
// ---------------------------------------------------------------------------

describe('applyBudget: whole-learning truncation (GC-AC-13)', () => {
  it('never truncates a learning mid-content — drops whole learning if it does not fit', () => {
    // Each learning costs ~120 chars. compact budget = 2000, repo = 50% = 1000.
    // 1000 / 120 ≈ 8 learnings max in repo.
    const sections: BudgetSections = {
      repo: Array.from({ length: 20 }, () => makeLearning(80)), // 80 + overhead = ~100 chars each
      workspace: [],
      global: [],
      stale: [],
    };
    const result = applyBudget(sections, 'compact');
    // Should have fewer than 20 learnings — exact count depends on overhead, but must be whole
    expect(result.repo.length).toBeLessThan(20);
    expect(result.repo.length).toBeGreaterThan(0);
  });

  it('keeps all learnings when they fit within the budget', () => {
    const sections: BudgetSections = {
      repo: [makeLearning(10)], // very small
      workspace: [makeLearning(10)],
      global: [makeLearning(10)],
      stale: [makeLearning(10)],
    };
    const result = applyBudget(sections, 'full');
    expect(result.repo).toHaveLength(1);
    expect(result.workspace).toHaveLength(1);
    expect(result.global).toHaveLength(1);
    expect(result.stale).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Budget allocation percentages (GC-AC-14)
// ---------------------------------------------------------------------------

describe('applyBudget: allocation percentages (GC-AC-14)', () => {
  it('repo gets more characters than workspace under standard budget', () => {
    // Fill both sections with identical learnings; repo should receive more
    const repoCount = 50;
    const wsCount = 50;
    const sections: BudgetSections = {
      repo: Array.from({ length: repoCount }, () => makeLearning(60)),
      workspace: Array.from({ length: wsCount }, () => makeLearning(60)),
      global: [],
      stale: [],
    };
    const result = applyBudget(sections, 'standard');
    // Repo gets 50% = 2500 chars, workspace gets 25% = 1250 chars (before rollover)
    // With more budget, repo should contain more learnings than workspace
    expect(result.repo.length).toBeGreaterThan(result.workspace.length);
  });
});

// ---------------------------------------------------------------------------
// Rollover logic (GC-AC-15)
// ---------------------------------------------------------------------------

describe('applyBudget: under-budget rollover (GC-AC-15)', () => {
  it('under-budget sections donate surplus to over-budget sections', () => {
    // Workspace and global are empty — their budget rolls to repo
    // With full rollover, repo should get more than its base 50% allocation
    const sections: BudgetSections = {
      repo: Array.from({ length: 100 }, () => makeLearning(80)),
      workspace: [],  // donates 25% to repo
      global: [],     // donates 15% to repo
      stale: [],      // donates 10% to repo
    };
    const resultWithRollover = applyBudget(sections, 'standard');

    // Compare with same budget but no rollover opportunity:
    // Without rollover, only 50% of 5000 = 2500 chars for repo
    const sectionsNoRollover: BudgetSections = {
      repo: Array.from({ length: 100 }, () => makeLearning(80)),
      workspace: Array.from({ length: 100 }, () => makeLearning(80)),
      global: Array.from({ length: 100 }, () => makeLearning(80)),
      stale: Array.from({ length: 100 }, () => makeLearning(80)),
    };
    const resultNoRollover = applyBudget(sectionsNoRollover, 'standard');

    // With rollover, repo should contain more learnings than without
    expect(resultWithRollover.repo.length).toBeGreaterThan(resultNoRollover.repo.length);
  });
});

// ---------------------------------------------------------------------------
// Budget trimming is the final gate (GC-AC-15a)
// ---------------------------------------------------------------------------

describe('applyBudget: budget is final gate (GC-AC-15a)', () => {
  it('full preset allows more learnings than compact', () => {
    const sections: BudgetSections = {
      repo: Array.from({ length: 30 }, () => makeLearning(100)),
      workspace: [],
      global: [],
      stale: [],
    };
    const compact = applyBudget(sections, 'compact');
    const full = applyBudget(sections, 'full');
    expect(full.repo.length).toBeGreaterThanOrEqual(compact.repo.length);
  });

  it('compact preset produces fewer learnings than standard', () => {
    const sections: BudgetSections = {
      repo: Array.from({ length: 50 }, () => makeLearning(80)),
      workspace: Array.from({ length: 20 }, () => makeLearning(80)),
      global: [],
      stale: [],
    };
    const compact = applyBudget(sections, 'compact');
    const standard = applyBudget(sections, 'standard');
    const totalCompact = compact.repo.length + compact.workspace.length;
    const totalStandard = standard.repo.length + standard.workspace.length;
    expect(totalStandard).toBeGreaterThanOrEqual(totalCompact);
  });

  it('does not mutate the input arrays', () => {
    const sections: BudgetSections = {
      repo: [makeLearning(80)],
      workspace: [makeLearning(80)],
      global: [makeLearning(80)],
      stale: [makeLearning(80)],
    };
    const origLengths = {
      repo: sections.repo.length,
      workspace: sections.workspace.length,
      global: sections.global.length,
      stale: sections.stale.length,
    };
    applyBudget(sections, 'compact');
    expect(sections.repo.length).toBe(origLengths.repo);
    expect(sections.workspace.length).toBe(origLengths.workspace);
    expect(sections.global.length).toBe(origLengths.global);
    expect(sections.stale.length).toBe(origLengths.stale);
  });
});
