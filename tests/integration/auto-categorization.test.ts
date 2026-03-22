/**
 * Integration tests for Phase 5: Auto-Categorization (SKM-AC-17 through SKM-AC-21).
 * Uses an in-memory SQLite database with a mock embedding service.
 * Tests the full store → auto-categorize path through LearningService.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { LearningService } from '../../src/services/learning-service.js';
import { ValidationError } from '../../src/utils/errors.js';
import type { EmbeddingService } from '../../src/services/embedding-service.js';

// ---------------------------------------------------------------------------
// Fake embedding service: returns deterministic vectors
// ---------------------------------------------------------------------------

/**
 * Creates a mock EmbeddingService that returns a fixed embedding vector.
 * This simulates a real embedding provider without requiring network calls.
 */
function makeFakeEmbeddingService(vector: number[] | null = [0.1, 0.2, 0.3]): EmbeddingService {
  return {
    generateEmbedding: vi.fn().mockResolvedValue(vector),
    getDimensions: vi.fn().mockReturnValue(vector?.length ?? 0),
    getProviderName: vi.fn().mockReturnValue(vector === null ? 'none' : 'fake'),
  };
}

describe('Auto-categorization integration (SKM-AC-17 through SKM-AC-21)', () => {
  let storage: SqliteAdapter;
  let service: LearningService;

  beforeEach(async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
  });

  // -------------------------------------------------------------------------
  // SKM-AC-21: Explicit category always works unchanged
  // -------------------------------------------------------------------------

  it('SKM-AC-21: explicit category is used as-is, auto_categorized=false', async () => {
    const embeddingService = makeFakeEmbeddingService([0.1, 0.2, 0.3]);
    service = new LearningService(storage, embeddingService);

    const result = await service.storeLearning({
      content: 'Use transactions for all multi-step DB writes.',
      category: 'architecture',
    });

    expect(result.auto_categorized).toBe(false);
    expect(result.learning.category).toBe('architecture');
  });

  // -------------------------------------------------------------------------
  // SKM-AC-17, SKM-AC-18: Auto-categorize to dominant category
  // -------------------------------------------------------------------------

  it('SKM-AC-17, SKM-AC-18: omitting category auto-categorizes to majority of 5 nearest neighbors', async () => {
    // The embedding service returns the same vector for all calls so all learnings
    // appear maximally similar to each other (similarity ≈ 1.0 for identical vectors).
    const embeddingService = makeFakeEmbeddingService([1.0, 0.0, 0.0]);
    service = new LearningService(storage, embeddingService);

    // Store 5 learnings with category "gotchas" in global scope
    for (let i = 0; i < 5; i++) {
      await service.storeLearning({
        content: `Gotcha learning ${i}: watch out for this.`,
        category: 'gotchas',
      });
    }

    // Now store without category — should auto-categorize to "gotchas"
    const result = await service.storeLearning({
      content: 'Another tricky issue to watch for.',
      // no category
    });

    expect(result.auto_categorized).toBe(true);
    expect(result.learning.category).toBe('gotchas');
    // Verify the learning was actually persisted with the correct category
    const stored = await storage.getLearning(result.learning.id);
    expect(stored?.category).toBe('gotchas');
  });

  it('SKM-AC-17: null category triggers auto-categorization same as omitted', async () => {
    const embeddingService = makeFakeEmbeddingService([1.0, 0.0, 0.0]);
    service = new LearningService(storage, embeddingService);

    // Seed 3 "conventions" learnings
    for (let i = 0; i < 3; i++) {
      await service.storeLearning({
        content: `Convention ${i}: always follow this pattern.`,
        category: 'conventions',
      });
    }

    // Pass category: null explicitly
    const result = await service.storeLearning({
      content: 'Follow this convention carefully.',
      category: null,
    });

    expect(result.auto_categorized).toBe(true);
    expect(result.learning.category).toBe('conventions');
  });

  // -------------------------------------------------------------------------
  // SKM-AC-19: Fewer than 3 neighbors → validation error
  // -------------------------------------------------------------------------

  it('SKM-AC-19: fewer than 3 same-scope neighbors throws ValidationError', async () => {
    const embeddingService = makeFakeEmbeddingService([1.0, 0.0, 0.0]);
    service = new LearningService(storage, embeddingService);

    // Store only 2 learnings (fewer than 3 needed for auto-cat)
    await service.storeLearning({
      content: 'First gotcha: this is a problem.',
      category: 'gotchas',
    });
    await service.storeLearning({
      content: 'Second gotcha: also a problem.',
      category: 'gotchas',
    });

    // Now try to store without category — should fail with ValidationError
    await expect(
      service.storeLearning({ content: 'Too sparse to auto-categorize.' })
    ).rejects.toThrow(ValidationError);
  });

  it('SKM-AC-19: empty scope (no existing learnings) throws ValidationError', async () => {
    const embeddingService = makeFakeEmbeddingService([1.0, 0.0, 0.0]);
    service = new LearningService(storage, embeddingService);

    await expect(
      service.storeLearning({ content: 'No neighbors at all.' })
    ).rejects.toThrow(ValidationError);
  });

  it('SKM-AC-19: scope isolation — repo-scope neighbors do not count for global-scope auto-cat', async () => {
    const embeddingService = makeFakeEmbeddingService([1.0, 0.0, 0.0]);
    service = new LearningService(storage, embeddingService);

    // Store 5 learnings in a specific repo — they are NOT global
    for (let i = 0; i < 5; i++) {
      await service.storeLearning({
        content: `Repo-specific gotcha ${i}.`,
        category: 'gotchas',
        repository: '/home/user/project',
      });
    }

    // Store without category in GLOBAL scope — repo learnings should not count
    await expect(
      service.storeLearning({ content: 'Global, no category, no neighbors.' })
    ).rejects.toThrow(ValidationError);
  });

  // -------------------------------------------------------------------------
  // No embedding provider + no category
  // -------------------------------------------------------------------------

  it('throws ValidationError when provider=none and category omitted', async () => {
    // NoneEmbeddingService returns null
    const embeddingService = makeFakeEmbeddingService(null);
    service = new LearningService(storage, embeddingService);

    await expect(
      service.storeLearning({ content: 'No embedding provider available.' })
    ).rejects.toThrow(ValidationError);
  });

  // -------------------------------------------------------------------------
  // SKM-AC-20: auto_categorized field in response
  // -------------------------------------------------------------------------

  it('SKM-AC-20: auto_categorized=false when category explicitly provided', async () => {
    const embeddingService = makeFakeEmbeddingService([1.0, 0.0, 0.0]);
    service = new LearningService(storage, embeddingService);

    const result = await service.storeLearning({
      content: 'Explicit category provided.',
      category: 'debugging',
    });

    expect(result.auto_categorized).toBe(false);
  });

  it('SKM-AC-20: auto_categorized=true when category was auto-assigned', async () => {
    const embeddingService = makeFakeEmbeddingService([1.0, 0.0, 0.0]);
    service = new LearningService(storage, embeddingService);

    // Seed 3 neighbors
    for (let i = 0; i < 3; i++) {
      await service.storeLearning({
        content: `Debugging tip ${i}: check the logs.`,
        category: 'debugging',
      });
    }

    const result = await service.storeLearning({
      content: 'Check the error output carefully.',
    });

    expect(result.auto_categorized).toBe(true);
    expect(result.learning.category).toBe('debugging');
  });
});
