/**
 * Unit tests for the rankLearnings pure function.
 * Traces to GC-AC-6, GC-AC-7, GC-AC-8, GC-AC-9.
 */
import { describe, it, expect } from 'vitest';
import { rankLearnings } from '../../src/services/ranking.js';
import type { Learning } from '../../src/models/learning.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let counter = 0;
function makeLearning(overrides: Partial<Learning> = {}): Learning {
  counter++;
  return {
    id: `id-${counter.toString().padStart(4, '0')}`,
    content: `Content ${counter}`,
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

// ---------------------------------------------------------------------------
// Category tier ranking (GC-AC-6)
// ---------------------------------------------------------------------------

describe('rankLearnings: category tier (GC-AC-6)', () => {
  it('places gotchas before conventions before architecture', () => {
    const learnings = [
      makeLearning({ category: 'architecture' }),
      makeLearning({ category: 'conventions' }),
      makeLearning({ category: 'gotchas' }),
    ];
    const ranked = rankLearnings(learnings);
    expect(ranked[0]!.category).toBe('gotchas');
    expect(ranked[1]!.category).toBe('conventions');
    expect(ranked[2]!.category).toBe('architecture');
  });

  it('places debugging at tier 0 (same as gotchas)', () => {
    const debugging = makeLearning({ category: 'debugging' });
    const architecture = makeLearning({ category: 'architecture' });
    const ranked = rankLearnings([architecture, debugging]);
    expect(ranked[0]!.category).toBe('debugging');
  });

  it('places dependencies last (tier 3)', () => {
    const learnings = [
      makeLearning({ category: 'dependencies' }),
      makeLearning({ category: 'gotchas' }),
      makeLearning({ category: 'decisions' }),
      makeLearning({ category: 'conventions' }),
    ];
    const ranked = rankLearnings(learnings);
    expect(ranked[ranked.length - 1]!.category).toBe('dependencies');
  });

  it('places decisions and architecture at tier 2 (after conventions)', () => {
    const learnings = [
      makeLearning({ category: 'decisions' }),
      makeLearning({ category: 'architecture' }),
      makeLearning({ category: 'conventions' }),
    ];
    const ranked = rankLearnings(learnings);
    expect(ranked[0]!.category).toBe('conventions');
    // decisions and architecture both tier 2 — order between them may vary but both after conventions
    expect(['decisions', 'architecture']).toContain(ranked[1]!.category);
    expect(['decisions', 'architecture']).toContain(ranked[2]!.category);
  });

  it('does not mutate the input array', () => {
    const learnings = [
      makeLearning({ category: 'architecture' }),
      makeLearning({ category: 'gotchas' }),
    ];
    const original = [...learnings];
    rankLearnings(learnings);
    expect(learnings[0]!.id).toBe(original[0]!.id);
    expect(learnings[1]!.id).toBe(original[1]!.id);
  });
});

// ---------------------------------------------------------------------------
// Stale flag (GC-AC-7)
// ---------------------------------------------------------------------------

describe('rankLearnings: stale flag (GC-AC-7)', () => {
  it('stale learnings bubble to top within their category tier', () => {
    const learnings = [
      makeLearning({ category: 'conventions', stale_flag: false }),
      makeLearning({ category: 'conventions', stale_flag: true }),
      makeLearning({ category: 'conventions', stale_flag: false }),
    ];
    const ranked = rankLearnings(learnings);
    expect(ranked[0]!.stale_flag).toBe(true);
  });

  it('stale learning does not jump tiers (gotcha without stale still beats conventions stale)', () => {
    const gotcha = makeLearning({ category: 'gotchas', stale_flag: false });
    const staleConvention = makeLearning({ category: 'conventions', stale_flag: true });
    const ranked = rankLearnings([staleConvention, gotcha]);
    expect(ranked[0]!.category).toBe('gotchas');
  });
});

// ---------------------------------------------------------------------------
// Recency tiebreaker (GC-AC-8)
// ---------------------------------------------------------------------------

describe('rankLearnings: recency tiebreaker (GC-AC-8)', () => {
  it('more recently updated learnings rank first within same tier', () => {
    const older = makeLearning({
      category: 'conventions',
      updated_at: '2024-01-01T00:00:00.000Z',
    });
    const newer = makeLearning({
      category: 'conventions',
      updated_at: '2024-06-01T00:00:00.000Z',
    });
    const ranked = rankLearnings([older, newer]);
    expect(ranked[0]!.id).toBe(newer.id);
  });
});

// ---------------------------------------------------------------------------
// Embedding presence (GC-AC-9)
// ---------------------------------------------------------------------------

describe('rankLearnings: embedding presence (GC-AC-9)', () => {
  it('learnings with embeddings rank above those without (same tier)', () => {
    const noEmbed = makeLearning({ category: 'conventions', embedding: null });
    const withEmbed = makeLearning({
      category: 'conventions',
      embedding: [0.1, 0.2],
    });
    const ranked = rankLearnings([noEmbed, withEmbed]);
    expect(ranked[0]!.id).toBe(withEmbed.id);
  });
});

// ---------------------------------------------------------------------------
// path_hint boost (GC-AC-17)
// ---------------------------------------------------------------------------

describe('rankLearnings: path_hint boost (GC-AC-17)', () => {
  it('learnings whose repository contains path_hint rank first', () => {
    const unrelated = makeLearning({
      category: 'gotchas',
      repository: '/repo/frontend',
    });
    const relevant = makeLearning({
      category: 'conventions',
      repository: '/repo/packages/api',
    });
    const ranked = rankLearnings([unrelated, relevant], { path_hint: 'packages/api' });
    expect(ranked[0]!.id).toBe(relevant.id);
  });

  it('path_hint match in content also boosts', () => {
    const unrelated = makeLearning({ content: 'General convention.' });
    const relevant = makeLearning({ content: 'In packages/api always validate input.' });
    const ranked = rankLearnings([unrelated, relevant], { path_hint: 'packages/api' });
    expect(ranked[0]!.id).toBe(relevant.id);
  });

  it('is case-insensitive', () => {
    const relevant = makeLearning({ repository: '/repo/Packages/API' });
    const unrelated = makeLearning({ repository: '/repo/frontend' });
    const ranked = rankLearnings([unrelated, relevant], { path_hint: 'packages/api' });
    expect(ranked[0]!.id).toBe(relevant.id);
  });
});

// ---------------------------------------------------------------------------
// query_scores boost (GC-AC-20)
// ---------------------------------------------------------------------------

describe('rankLearnings: query_scores semantic boost (GC-AC-20)', () => {
  it('higher query similarity boosts ranking within same tier', () => {
    const lowScore = makeLearning({ category: 'conventions' });
    const highScore = makeLearning({ category: 'conventions' });
    const queryScores = new Map([
      [lowScore.id, 0.5],
      [highScore.id, 0.95],
    ]);
    const ranked = rankLearnings([lowScore, highScore], { query_scores: queryScores });
    expect(ranked[0]!.id).toBe(highScore.id);
  });

  it('query_scores do not override category tier', () => {
    const archHighScore = makeLearning({ category: 'architecture' });
    const gotchaLowScore = makeLearning({ category: 'gotchas' });
    const queryScores = new Map([
      [archHighScore.id, 0.99],
      [gotchaLowScore.id, 0.1],
    ]);
    const ranked = rankLearnings([archHighScore, gotchaLowScore], { query_scores: queryScores });
    expect(ranked[0]!.category).toBe('gotchas');
  });
});

// ---------------------------------------------------------------------------
// path_hint_scores boost (GC-AC-18)
// ---------------------------------------------------------------------------

describe('rankLearnings: path_hint_scores semantic boost (GC-AC-18)', () => {
  it('higher path_hint_scores boosts ranking within same tier', () => {
    const lowScore = makeLearning({ category: 'conventions' });
    const highScore = makeLearning({ category: 'conventions' });
    const pathHintScores = new Map([
      [lowScore.id, 0.4],
      [highScore.id, 0.9],
    ]);
    const ranked = rankLearnings([lowScore, highScore], { path_hint_scores: pathHintScores });
    expect(ranked[0]!.id).toBe(highScore.id);
  });

  it('query_scores and path_hint_scores are additive', () => {
    const onlyQuery = makeLearning({ category: 'conventions' });
    const onlyPath = makeLearning({ category: 'conventions' });
    const both = makeLearning({ category: 'conventions' });

    const queryScores = new Map([
      [onlyQuery.id, 0.6],
      [both.id, 0.6],
    ]);
    const pathHintScores = new Map([
      [onlyPath.id, 0.6],
      [both.id, 0.6],
    ]);
    const ranked = rankLearnings([onlyQuery, onlyPath, both], { query_scores: queryScores, path_hint_scores: pathHintScores });
    // 'both' has combined score 1.2, should rank first
    expect(ranked[0]!.id).toBe(both.id);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('rankLearnings: edge cases', () => {
  it('returns empty array for empty input', () => {
    expect(rankLearnings([])).toEqual([]);
  });

  it('returns single learning unchanged', () => {
    const learning = makeLearning();
    const ranked = rankLearnings([learning]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.id).toBe(learning.id);
  });

  it('handles learnings with no options gracefully', () => {
    const learnings = [makeLearning(), makeLearning()];
    expect(() => rankLearnings(learnings)).not.toThrow();
  });
});
