/**
 * Unit tests for conflict-detector.ts.
 * Tests the pure detectConflicts function and associated constants.
 * Traces to SKM-AC-22, SKM-AC-23, SKM-AC-24, SKM-AC-29.
 */
import { describe, it, expect } from 'vitest';
import {
  detectConflicts,
  NEGATION_MARKERS,
  ASSERTION_MARKERS,
  CONFLICT_SIMILARITY_THRESHOLD,
} from '../../src/services/conflict-detector.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCandidate(
  overrides: Partial<{ id: string; content: string; category: string; similarity: number }> = {}
) {
  return {
    id: 'candidate-001',
    content: 'Always use X.',
    category: 'gotchas',
    similarity: 0.9,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('NEGATION_MARKERS', () => {
  it('includes expected negation keywords (SKM-AC-23)', () => {
    expect(NEGATION_MARKERS).toContain("don't");
    expect(NEGATION_MARKERS).toContain('avoid');
    expect(NEGATION_MARKERS).toContain('never');
    expect(NEGATION_MARKERS).toContain('not');
    expect(NEGATION_MARKERS).toContain('stop');
    expect(NEGATION_MARKERS).toContain('remove');
    expect(NEGATION_MARKERS).toContain('disable');
    expect(NEGATION_MARKERS).toContain("shouldn't");
    expect(NEGATION_MARKERS).toContain("won't");
  });
});

describe('ASSERTION_MARKERS', () => {
  it('includes expected assertion keywords (SKM-AC-23)', () => {
    expect(ASSERTION_MARKERS).toContain('always');
    expect(ASSERTION_MARKERS).toContain('must');
    expect(ASSERTION_MARKERS).toContain('prefer');
    expect(ASSERTION_MARKERS).toContain('use');
    expect(ASSERTION_MARKERS).toContain('enable');
    expect(ASSERTION_MARKERS).toContain('require');
    expect(ASSERTION_MARKERS).toContain('ensure');
    expect(ASSERTION_MARKERS).toContain('should');
    expect(ASSERTION_MARKERS).toContain('recommend');
  });
});

describe('CONFLICT_SIMILARITY_THRESHOLD', () => {
  it('is 0.85 (SKM-AC-22)', () => {
    expect(CONFLICT_SIMILARITY_THRESHOLD).toBe(0.85);
  });
});

// ---------------------------------------------------------------------------
// detectConflicts — basic cases
// ---------------------------------------------------------------------------

describe('detectConflicts', () => {
  describe('cross-signal detection (SKM-AC-24)', () => {
    it('detects conflict: new has negation, candidate has assertion', () => {
      const conflicts = detectConflicts(
        "never use X, it causes issues",
        [],
        'gotchas',
        [makeCandidate({ content: 'Always use X.', category: 'gotchas', similarity: 0.9 })]
      );

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]!.learning_id).toBe('candidate-001');
      expect(conflicts[0]!.conflict_type).toBe('keyword_heuristic');
      expect(conflicts[0]!.similarity).toBe(0.9);
    });

    it('detects conflict: new has assertion, candidate has negation', () => {
      const conflicts = detectConflicts(
        'Always use X for best results.',
        [],
        'gotchas',
        [makeCandidate({ content: "don't use X, it causes issues", category: 'gotchas', similarity: 0.9 })]
      );

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]!.learning_id).toBe('candidate-001');
    });

    it('detects conflict with "must" vs "avoid"', () => {
      const conflicts = detectConflicts(
        'Must configure SSL on all services.',
        [],
        'architecture',
        [makeCandidate({ content: 'Avoid SSL overhead in internal services.', category: 'architecture', similarity: 0.88 })]
      );

      expect(conflicts).toHaveLength(1);
    });

    it('detects conflict with "should" vs "never"', () => {
      const conflicts = detectConflicts(
        'Should enable caching.',
        [],
        'decisions',
        [makeCandidate({ content: 'Never enable caching in dev.', category: 'decisions', similarity: 0.87 })]
      );

      expect(conflicts).toHaveLength(1);
    });
  });

  describe('same-signal (not a conflict) (SKM-AC-24)', () => {
    it('does not flag conflict when both have negation markers (no assertion marker present)', () => {
      // "avoid X" and "never X" — both negation, no assertion markers
      const conflicts = detectConflicts(
        "avoid X at all costs.",
        [],
        'gotchas',
        [makeCandidate({ content: "never do X, it breaks things.", category: 'gotchas', similarity: 0.9 })]
      );

      expect(conflicts).toHaveLength(0);
    });

    it('does not flag conflict when both have assertion markers', () => {
      const conflicts = detectConflicts(
        'Always use X.',
        [],
        'gotchas',
        [makeCandidate({ content: 'Must use X.', category: 'gotchas', similarity: 0.9 })]
      );

      expect(conflicts).toHaveLength(0);
    });
  });

  describe('no signal (not a conflict)', () => {
    it('does not flag conflict when new content has no markers', () => {
      const conflicts = detectConflicts(
        'X is the main library for this project.',
        [],
        'gotchas',
        [makeCandidate({ content: 'Always prefer X.', category: 'gotchas', similarity: 0.9 })]
      );

      expect(conflicts).toHaveLength(0);
    });

    it('does not flag conflict when candidate has no markers', () => {
      const conflicts = detectConflicts(
        'Always use X.',
        [],
        'gotchas',
        [makeCandidate({ content: 'X is the main library.', category: 'gotchas', similarity: 0.9 })]
      );

      expect(conflicts).toHaveLength(0);
    });

    it('returns empty array when candidates list is empty', () => {
      const conflicts = detectConflicts('never use X.', [], 'gotchas', []);
      expect(conflicts).toHaveLength(0);
    });
  });

  describe('scope gate: category must match (SKM-AC-29)', () => {
    it('does not flag conflict when categories differ', () => {
      const conflicts = detectConflicts(
        "never use X.",
        [],
        'gotchas',
        [makeCandidate({ content: 'Always use X.', category: 'architecture', similarity: 0.9 })]
      );

      expect(conflicts).toHaveLength(0);
    });

    it('does flag conflict when categories match', () => {
      const conflicts = detectConflicts(
        "never use X.",
        [],
        'conventions',
        [makeCandidate({ content: 'Always use X.', category: 'conventions', similarity: 0.9 })]
      );

      expect(conflicts).toHaveLength(1);
    });
  });

  describe('case insensitivity (SKM-AC-23)', () => {
    it('matches markers case-insensitively', () => {
      const conflicts = detectConflicts(
        'NEVER use X.',
        [],
        'gotchas',
        [makeCandidate({ content: 'ALWAYS use X.', category: 'gotchas', similarity: 0.9 })]
      );

      expect(conflicts).toHaveLength(1);
    });

    it('matches mixed-case markers', () => {
      const conflicts = detectConflicts(
        'Never use X.',
        [],
        'gotchas',
        [makeCandidate({ content: 'Always use X.', category: 'gotchas', similarity: 0.9 })]
      );

      expect(conflicts).toHaveLength(1);
    });
  });

  describe('word boundary matching (SKM-AC-23)', () => {
    it('does not match "not" inside "note" or "nothing"', () => {
      // "note" contains "not" as a substring but not at a word boundary
      const conflicts = detectConflicts(
        'Note the following pattern.',  // "note" should not match "not"
        [],
        'conventions',
        [makeCandidate({ content: 'Always use X.', category: 'conventions', similarity: 0.9 })]
      );

      // "note" should NOT trigger negation — no conflict expected
      expect(conflicts).toHaveLength(0);
    });

    it('matches "not" when it is a standalone word', () => {
      const conflicts = detectConflicts(
        'This is not recommended.',
        [],
        'conventions',
        [makeCandidate({ content: 'Always use this pattern.', category: 'conventions', similarity: 0.9 })]
      );

      expect(conflicts).toHaveLength(1);
    });

    it('does not match "use" inside "reuse" or "misuse"', () => {
      // "reuse" contains "use" but at a word boundary test
      const conflicts = detectConflicts(
        "don't reuse sessions.",  // "reuse" should not match "use" marker
        [],
        'conventions',
        [makeCandidate({ content: "avoid using globals.", category: 'conventions', similarity: 0.9 })]
      );

      // "don't" triggers negation; "avoid" triggers negation — same signal, no conflict
      // "reuse" does NOT trigger assertion marker "use"
      expect(conflicts).toHaveLength(0);
    });
  });

  describe('multiple candidates', () => {
    it('returns multiple conflicts when multiple candidates qualify', () => {
      // New content: pure negation only — "avoid X" (has "avoid"=negation, no assertion markers)
      // c1 and c2: pure assertion — conflict expected
      // c3: pure negation — same signal, no conflict
      const candidates = [
        makeCandidate({ id: 'c1', content: 'Always do X.', category: 'gotchas', similarity: 0.91 }),
        makeCandidate({ id: 'c2', content: 'Must prefer X.', category: 'gotchas', similarity: 0.88 }),
        makeCandidate({ id: 'c3', content: "also avoid Y entirely.", category: 'gotchas', similarity: 0.86 }), // same signal: both negation
      ];

      const conflicts = detectConflicts("avoid X at all costs.", [], 'gotchas', candidates);

      // c1 and c2 conflict (assertion vs negation); c3 does not (negation vs negation)
      expect(conflicts).toHaveLength(2);
      expect(conflicts.map((c) => c.learning_id)).toContain('c1');
      expect(conflicts.map((c) => c.learning_id)).toContain('c2');
      expect(conflicts.map((c) => c.learning_id)).not.toContain('c3');
    });

    it('preserves similarity in returned ConflictCandidate', () => {
      const conflicts = detectConflicts(
        "never use X.",
        [],
        'gotchas',
        [makeCandidate({ id: 'c1', content: 'Always use X.', category: 'gotchas', similarity: 0.87 })]
      );

      expect(conflicts[0]!.similarity).toBe(0.87);
    });

    it('preserves content in returned ConflictCandidate', () => {
      const conflicts = detectConflicts(
        "never use X.",
        [],
        'gotchas',
        [makeCandidate({ id: 'c1', content: 'Always use X for performance.', category: 'gotchas', similarity: 0.9 })]
      );

      expect(conflicts[0]!.content).toBe('Always use X for performance.');
    });
  });

  describe('mixed signals in single learning (edge cases)', () => {
    it('treats content with both negation and assertion markers as having both signals', () => {
      // "don't forget to always..." has both signals — new has negation AND assertion
      // This can match candidates that have EITHER signal, which is a known false-positive
      // acknowledged in the spec (advisory, not blocking).
      const conflicts = detectConflicts(
        "don't forget to always validate inputs.",
        [],
        'conventions',
        [makeCandidate({ content: "avoid validation boilerplate.", category: 'conventions', similarity: 0.9 })]
      );

      // New has assertion (always) + candidate has negation (avoid) → cross-signal → conflict
      expect(conflicts).toHaveLength(1);
    });
  });
});
