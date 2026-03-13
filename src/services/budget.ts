/**
 * Pure budget allocation and trimming function for get_context.
 * Controls how many learnings fit within an approximate character limit.
 * Truncation is by whole learning (never mid-content). No I/O, no side effects.
 * Traces to GC-AC-12, GC-AC-13, GC-AC-14, GC-AC-15, GC-AC-15a.
 */
import type { Learning } from '../models/learning.js';

/**
 * Budget preset names accepted by the get_context tool.
 * Traces to GC-AC-12.
 */
export type BudgetPreset = 'compact' | 'standard' | 'full';

/**
 * Character limit constants for each budget preset.
 * Traces to GC-AC-13.
 */
export const BUDGET_PRESETS: Record<BudgetPreset, { totalChars: number; label: BudgetPreset }> = {
  compact: { totalChars: 2000, label: 'compact' },
  standard: { totalChars: 5000, label: 'standard' },
  full: { totalChars: 12000, label: 'full' },
};

/**
 * The four sections managed by the budget system.
 * Traces to GC-AC-14.
 */
export interface BudgetSections {
  /** Repo-scoped learnings (50% allocation). */
  repo: Learning[];
  /** Workspace-scoped learnings (25% allocation). */
  workspace: Learning[];
  /** Global learnings (15% allocation). */
  global: Learning[];
  /** Stale-flagged learnings for review (10% allocation). */
  stale: Learning[];
}

/**
 * Percentage allocations for each section.
 * Must sum to 1.0. Traces to GC-AC-14.
 */
const SECTION_ALLOCATIONS: Record<keyof BudgetSections, number> = {
  repo: 0.50,
  workspace: 0.25,
  global: 0.15,
  stale: 0.10,
};

/**
 * Estimate the character cost of a single learning as it would appear in JSON output.
 * Uses content + category + tags as the cost proxy (not the full JSON payload).
 * This is a deliberate approximation — budget trimming is cosmetic, not security-critical.
 */
function learningCharCost(learning: Learning): number {
  // content + category + tags joined (conservative estimate of serialized representation)
  return learning.content.length + learning.category.length + learning.tags.join(', ').length + 20; // +20 for field names/punctuation overhead
}

/**
 * Trim a single section to fit within the given character budget.
 * Learnings are accepted in ranked order (first = most important).
 * Whole-learning truncation: never include a partial learning. (GC-AC-13)
 *
 * @param learnings - Ranked learnings for this section.
 * @param charBudget - Maximum characters available for this section.
 * @returns Subset of learnings that fit within the budget.
 */
function trimSection(learnings: Learning[], charBudget: number): Learning[] {
  if (charBudget <= 0) return [];
  const result: Learning[] = [];
  let used = 0;
  for (const learning of learnings) {
    const cost = learningCharCost(learning);
    if (used + cost > charBudget) break; // whole-learning truncation
    result.push(learning);
    used += cost;
  }
  return result;
}

/**
 * Apply budget trimming to all four sections with rollover redistribution.
 *
 * Algorithm (GC-AC-15):
 * 1. Compute initial per-section allocation from percentages.
 * 2. For each section, compute how many characters it actually needs.
 * 3. Under-budget sections (actual < allocation) donate their surplus.
 * 4. Surplus is redistributed proportionally to over-budget sections.
 * 5. Final trim runs with the adjusted allocations.
 *
 * Budget trimming is the final gate — applied after volume thresholds (GC-AC-15a).
 *
 * @param sections - The four learning sections to trim.
 * @param preset   - Budget preset name (compact/standard/full).
 * @returns New BudgetSections with trimmed arrays (originals not mutated).
 */
export function applyBudget(sections: BudgetSections, preset: BudgetPreset): BudgetSections {
  const { totalChars } = BUDGET_PRESETS[preset];
  const sectionKeys = Object.keys(SECTION_ALLOCATIONS) as Array<keyof BudgetSections>;

  // Step 1: Compute initial allocations
  const initialAllocations = new Map<keyof BudgetSections, number>();
  for (const key of sectionKeys) {
    initialAllocations.set(key, Math.floor(totalChars * SECTION_ALLOCATIONS[key]));
  }

  // Step 2: Compute actual character need for each section
  const actualNeeds = new Map<keyof BudgetSections, number>();
  for (const key of sectionKeys) {
    let need = 0;
    for (const learning of sections[key]) {
      need += learningCharCost(learning);
    }
    actualNeeds.set(key, need);
  }

  // Step 3: Compute surplus (under-budget sections)
  let totalSurplus = 0;
  for (const key of sectionKeys) {
    const alloc = initialAllocations.get(key)!;
    const need = actualNeeds.get(key)!;
    if (need < alloc) {
      totalSurplus += alloc - need;
    }
  }

  // Step 4: Redistribute surplus proportionally to over-budget sections
  const finalAllocations = new Map<keyof BudgetSections, number>();
  const overBudgetKeys = sectionKeys.filter(
    (key) => actualNeeds.get(key)! > initialAllocations.get(key)!
  );
  const totalOverBudgetAlloc = overBudgetKeys.reduce(
    (sum, key) => sum + initialAllocations.get(key)!,
    0
  );

  for (const key of sectionKeys) {
    const alloc = initialAllocations.get(key)!;
    const need = actualNeeds.get(key)!;
    if (need < alloc) {
      // Under-budget: cap at actual need
      finalAllocations.set(key, need);
    } else if (totalSurplus > 0 && totalOverBudgetAlloc > 0) {
      // Over-budget: get proportional share of surplus
      const extraShare = Math.floor((alloc / totalOverBudgetAlloc) * totalSurplus);
      finalAllocations.set(key, alloc + extraShare);
    } else {
      finalAllocations.set(key, alloc);
    }
  }

  // Step 5: Trim each section to its final allocation
  return {
    repo: trimSection(sections.repo, finalAllocations.get('repo')!),
    workspace: trimSection(sections.workspace, finalAllocations.get('workspace')!),
    global: trimSection(sections.global, finalAllocations.get('global')!),
    stale: trimSection(sections.stale, finalAllocations.get('stale')!),
  };
}
