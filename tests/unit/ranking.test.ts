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
    ttl_days: null,
    source_agent: null,
    integrity_hash: null,
    access_count: 0,
    last_accessed_at: null,
    staleness_score: 0.0,
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
  it('in normal mode fresh learnings (staleness_score=0.0) rank before stale ones (staleness_score=1.0)', () => {
    const fresh1 = makeLearning({ category: 'conventions', stale_flag: false, staleness_score: 0.0 });
    const stale = makeLearning({ category: 'conventions', stale_flag: true, staleness_score: 1.0 });
    const fresh2 = makeLearning({ category: 'conventions', stale_flag: false, staleness_score: 0.0 });
    const ranked = rankLearnings([fresh1, stale, fresh2]);
    // In normal mode: fresh (0.0) ranks first, stale (1.0) ranks last within tier
    expect(ranked[2]!.stale_flag).toBe(true);
  });

  it('stale learning does not jump tiers (gotcha without stale still beats conventions stale)', () => {
    const gotcha = makeLearning({ category: 'gotchas', stale_flag: false, staleness_score: 0.0 });
    const staleConvention = makeLearning({ category: 'conventions', stale_flag: true, staleness_score: 1.0 });
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

// ---------------------------------------------------------------------------
// staleness_score continuous sort (SKM-AC-37)
// ---------------------------------------------------------------------------

describe('rankLearnings: staleness_score continuous sort (SKM-AC-37)', () => {
  it('lower staleness_score ranks first in normal mode (0.0 = fresh, sorts before 0.8)', () => {
    const fresh = makeLearning({ category: 'conventions', staleness_score: 0.0 });
    const stale = makeLearning({ category: 'conventions', staleness_score: 0.8 });
    const ranked = rankLearnings([stale, fresh]);
    expect(ranked[0]!.id).toBe(fresh.id);
  });

  it('staleness_score 0.5 ranks between 0.0 and 1.0 in normal mode', () => {
    const fresh = makeLearning({ category: 'conventions', staleness_score: 0.0 });
    const medium = makeLearning({ category: 'conventions', staleness_score: 0.5 });
    const stale = makeLearning({ category: 'conventions', staleness_score: 1.0 });
    const ranked = rankLearnings([stale, fresh, medium]);
    expect(ranked[0]!.id).toBe(fresh.id);
    expect(ranked[1]!.id).toBe(medium.id);
    expect(ranked[2]!.id).toBe(stale.id);
  });

  it('staleness_score does not override category tier', () => {
    const freshConvention = makeLearning({ category: 'conventions', staleness_score: 0.0 });
    const staleGotcha = makeLearning({ category: 'gotchas', staleness_score: 1.0 });
    // gotchas is tier 0 — must rank above conventions even when stale
    const ranked = rankLearnings([freshConvention, staleGotcha]);
    expect(ranked[0]!.category).toBe('gotchas');
  });
});

// ---------------------------------------------------------------------------
// stale_review_mode inverts staleness sort (SKM-AC-37)
// ---------------------------------------------------------------------------

describe('rankLearnings: stale_review_mode (SKM-AC-37)', () => {
  it('higher staleness_score sorts first in stale_review_mode', () => {
    const fresh = makeLearning({ category: 'conventions', staleness_score: 0.1 });
    const veryStale = makeLearning({ category: 'conventions', staleness_score: 0.9 });
    const ranked = rankLearnings([fresh, veryStale], { stale_review_mode: true });
    expect(ranked[0]!.id).toBe(veryStale.id);
  });

  it('stale_review_mode: items ordered 1.0 > 0.5 > 0.0', () => {
    const fresh = makeLearning({ category: 'conventions', staleness_score: 0.0 });
    const medium = makeLearning({ category: 'conventions', staleness_score: 0.5 });
    const stale = makeLearning({ category: 'conventions', staleness_score: 1.0 });
    const ranked = rankLearnings([fresh, medium, stale], { stale_review_mode: true });
    expect(ranked[0]!.id).toBe(stale.id);
    expect(ranked[1]!.id).toBe(medium.id);
    expect(ranked[2]!.id).toBe(fresh.id);
  });

  it('stale_review_mode: false (default) keeps fresh-first order', () => {
    const fresh = makeLearning({ category: 'conventions', staleness_score: 0.0 });
    const stale = makeLearning({ category: 'conventions', staleness_score: 1.0 });
    const ranked = rankLearnings([stale, fresh], { stale_review_mode: false });
    expect(ranked[0]!.id).toBe(fresh.id);
  });
});

// ---------------------------------------------------------------------------
// access_count frequency boost (SKM-AC-12)
// ---------------------------------------------------------------------------

describe('rankLearnings: access_count frequency boost (SKM-AC-12)', () => {
  it('higher access_count ranks first within same tier', () => {
    const lowAccess = makeLearning({ category: 'conventions', access_count: 1 });
    const highAccess = makeLearning({ category: 'conventions', access_count: 50 });
    const ranked = rankLearnings([lowAccess, highAccess]);
    expect(ranked[0]!.id).toBe(highAccess.id);
  });

  it('access_count does not override category tier', () => {
    const highAccessArch = makeLearning({ category: 'architecture', access_count: 100 });
    const noAccessGotcha = makeLearning({ category: 'gotchas', access_count: 0 });
    // gotchas (tier 0) must rank above architecture (tier 2) regardless of access
    const ranked = rankLearnings([highAccessArch, noAccessGotcha]);
    expect(ranked[0]!.category).toBe('gotchas');
  });

  it('access_count does not override staleness_score', () => {
    // fresh learning with zero accesses vs stale learning with many accesses
    const freshNoAccess = makeLearning({ category: 'conventions', staleness_score: 0.0, access_count: 0 });
    const staleHighAccess = makeLearning({ category: 'conventions', staleness_score: 0.8, access_count: 100 });
    // fresh (lower staleness) should rank first in normal mode
    const ranked = rankLearnings([staleHighAccess, freshNoAccess]);
    expect(ranked[0]!.id).toBe(freshNoAccess.id);
  });

  it('zero access_count items rank after non-zero access_count items', () => {
    const neverAccessed = makeLearning({ category: 'conventions', access_count: 0 });
    const accessed = makeLearning({ category: 'conventions', access_count: 5 });
    const ranked = rankLearnings([neverAccessed, accessed]);
    expect(ranked[0]!.id).toBe(accessed.id);
  });
});

// ---------------------------------------------------------------------------
// access recency sort key (SKM-AC-13)
// ---------------------------------------------------------------------------

describe('rankLearnings: access recency (SKM-AC-13)', () => {
  it('more recently accessed learning ranks first within same tier', () => {
    const olderAccess = makeLearning({
      category: 'conventions',
      access_count: 1,
      last_accessed_at: '2023-01-01T00:00:00.000Z',
    });
    const newerAccess = makeLearning({
      category: 'conventions',
      access_count: 1,
      last_accessed_at: '2024-06-01T00:00:00.000Z',
    });
    const ranked = rankLearnings([olderAccess, newerAccess]);
    expect(ranked[0]!.id).toBe(newerAccess.id);
  });

  it('falls back to created_at when last_accessed_at is null', () => {
    // learning with null last_accessed_at but recent created_at
    const neverAccessedRecent = makeLearning({
      category: 'conventions',
      access_count: 0,
      last_accessed_at: null,
      created_at: '2024-06-01T00:00:00.000Z',
    });
    // learning with null last_accessed_at and old created_at
    const neverAccessedOld = makeLearning({
      category: 'conventions',
      access_count: 0,
      last_accessed_at: null,
      created_at: '2020-01-01T00:00:00.000Z',
    });
    const ranked = rankLearnings([neverAccessedOld, neverAccessedRecent]);
    expect(ranked[0]!.id).toBe(neverAccessedRecent.id);
  });

  it('access recency does not override category tier', () => {
    const recentlyAccessedArch = makeLearning({
      category: 'architecture',
      access_count: 10,
      last_accessed_at: '2024-12-01T00:00:00.000Z',
    });
    const neverAccessedGotcha = makeLearning({
      category: 'gotchas',
      access_count: 0,
      last_accessed_at: null,
      created_at: '2020-01-01T00:00:00.000Z',
    });
    // gotchas (tier 0) must rank above architecture (tier 2) regardless of recency
    const ranked = rankLearnings([recentlyAccessedArch, neverAccessedGotcha]);
    expect(ranked[0]!.category).toBe('gotchas');
  });
});
