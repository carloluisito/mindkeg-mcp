/**
 * EntityService: business logic for Agent Memory Upgrade entities.
 * Handles decisions, findings, gotchas, run summaries, and relevant context assembly.
 * Follows the same pattern as LearningService: validates input, generates IDs,
 * calls storage methods, handles embedding-based deduplication for gotchas.
 *
 * Traces to AMU-AC-6 through AMU-AC-18, AMU-AC-30, AMU-AC-31.
 */
import { randomUUID } from 'node:crypto';
import type { StorageAdapter } from '../storage/storage-adapter.js';
import type { EmbeddingService } from './embedding-service.js';
import type { Decision } from '../models/decision.js';
import type { Finding } from '../models/finding.js';
import type { Gotcha } from '../models/gotcha.js';
import type { RunSummary } from '../models/run-summary.js';
import type { Learning } from '../models/learning.js';
import {
  CreateDecisionInputSchema,
} from '../models/decision.js';
import {
  CreateFindingInputSchema,
} from '../models/finding.js';
import {
  CreateGotchaInputSchema,
} from '../models/gotcha.js';
import {
  CompleteRunInputSchema,
} from '../models/run-summary.js';
import { ValidationError, NotFoundError } from '../utils/errors.js';
import { getLogger } from '../utils/logger.js';
import type { z } from 'zod';

/** Normalize Windows backslash paths to forward slashes for consistent storage/query. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Gotcha cosine similarity threshold for deduplication (AMU-AC-12, AMU-AC-30). */
const GOTCHA_SIMILARITY_THRESHOLD = 0.85;

/** Budget character limits for get_relevant_context (AMU-AC-17). */
const BUDGET_LIMITS = {
  compact: 2000,
  standard: 4000,
  full: 8000,
} as const;

/** Common English stop words excluded from keyword extraction. */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be',
  'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
  'would', 'could', 'should', 'may', 'might', 'this', 'that', 'these',
  'those', 'i', 'we', 'you', 'he', 'she', 'it', 'they', 'what', 'which',
  'who', 'how', 'when', 'where', 'why', 'all', 'any', 'each', 'every',
  'not', 'no', 'so', 'if', 'then', 'than', 'its', 'my', 'our', 'your',
]);

/** Extract relevant keywords from a task description for keyword search. */
function extractKeywords(taskDescription: string): string[] {
  return taskDescription
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/[^a-z0-9_-]/g, ''))
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
}

/** Raw input for storeDecision (pre-validation). */
export type StoreDecisionInput = z.input<typeof CreateDecisionInputSchema>;

/** Raw input for storeFinding (pre-validation). */
export type StoreFindingInput = z.input<typeof CreateFindingInputSchema>;

/** Raw input for storeGotcha (pre-validation). */
export type StoreGotchaInput = z.input<typeof CreateGotchaInputSchema>;

/** Raw input for completeRun (pre-validation). */
export type CompleteRunInputRaw = z.input<typeof CompleteRunInputSchema>;

/** Result of storeGotcha — indicates whether an existing gotcha was incremented. */
export interface StoreGotchaResult {
  gotcha: Gotcha;
  /** True when an existing gotcha was incremented instead of creating a new one (AMU-AC-12). */
  incremented: boolean;
}

/** Budget preset for get_relevant_context. */
export type ContextBudget = 'compact' | 'standard' | 'full';

/** Response structure for get_relevant_context (AMU-AC-17). */
export interface RelevantContextResult {
  decisions: Decision[];
  open_findings: Finding[];
  gotchas: Gotcha[];
  recent_learnings: Learning[];
  recent_runs: RunSummary[];
  summary: {
    total_items: number;
    repository: string;
  };
}

export class EntityService {
  private readonly storage: StorageAdapter;
  private readonly embedding: EmbeddingService;

  constructor(storage: StorageAdapter, embedding: EmbeddingService) {
    this.storage = storage;
    this.embedding = embedding;
  }

  // ---------------------------------------------------------------------------
  // Decisions (AMU-AC-6, AMU-AC-7, AMU-AC-8)
  // ---------------------------------------------------------------------------

  /**
   * Store a new architectural decision (AMU-AC-6).
   * Validates input via Zod, generates UUID, persists to storage.
   */
  async storeDecision(input: StoreDecisionInput): Promise<Decision> {
    const parsed = CreateDecisionInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError('Invalid decision input', parsed.error.errors);
    }
    const data = parsed.data;

    return this.storage.createDecision({
      id: randomUUID(),
      repository: normalizePath(data.repository),
      category: data.category,
      choice: data.choice,
      rationale: data.rationale,
      made_by: data.made_by ?? null,
    });
  }

  /**
   * Get all active decisions for a repository (AMU-AC-7).
   * Optionally filtered by category.
   */
  async getDecisions(repository: string, category?: string): Promise<Decision[]> {
    if (!repository) {
      throw new ValidationError('repository is required');
    }
    return this.storage.getDecisions(normalizePath(repository), category);
  }

  /**
   * Supersede an existing decision with a newer one (AMU-AC-8).
   * Validates both decisions exist, validates old decision is active,
   * sets old status to "superseded" and links via superseded_by.
   */
  async supersedeDecision(decisionId: string, newDecisionId: string): Promise<{ old_decision: Decision; new_decision: Decision }> {
    const oldDecision = await this.storage.getDecision(decisionId);
    if (!oldDecision) {
      throw new NotFoundError(`Decision not found: ${decisionId}`);
    }
    if (oldDecision.status !== 'active') {
      throw new ValidationError(`Decision ${decisionId} is not active (status: ${oldDecision.status})`);
    }

    const newDecision = await this.storage.getDecision(newDecisionId);
    if (!newDecision) {
      throw new NotFoundError(`New decision not found: ${newDecisionId}`);
    }

    const updatedOld = await this.storage.updateDecision(decisionId, {
      status: 'superseded',
      superseded_by: newDecisionId,
    });
    if (!updatedOld) {
      throw new NotFoundError(`Failed to update decision: ${decisionId}`);
    }

    return { old_decision: updatedOld, new_decision: newDecision };
  }

  // ---------------------------------------------------------------------------
  // Findings (AMU-AC-9, AMU-AC-10, AMU-AC-11)
  // ---------------------------------------------------------------------------

  /**
   * Store a new code review finding (AMU-AC-9).
   */
  async storeFinding(input: StoreFindingInput): Promise<Finding> {
    const parsed = CreateFindingInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError('Invalid finding input', parsed.error.errors);
    }
    const data = parsed.data;

    return this.storage.createFinding({
      id: randomUUID(),
      repository: normalizePath(data.repository),
      file_path: data.file_path,
      severity: data.severity,
      issue: data.issue,
      suggestion: data.suggestion,
      found_by: data.found_by ?? null,
    });
  }

  /**
   * Resolve a finding (AMU-AC-10).
   * Sets status to "resolved" and records resolved_at timestamp.
   */
  async resolveFinding(findingId: string, resolvedBy?: string | null): Promise<Finding> {
    const finding = await this.storage.getFinding(findingId);
    if (!finding) {
      throw new NotFoundError(`Finding not found: ${findingId}`);
    }

    const now = new Date().toISOString();
    const updated = await this.storage.updateFinding(findingId, {
      status: 'resolved',
      resolved_at: now,
      resolved_by: resolvedBy ?? null,
    });
    if (!updated) {
      throw new NotFoundError(`Failed to update finding: ${findingId}`);
    }

    return updated;
  }

  /**
   * Get all open findings for a repository (AMU-AC-11).
   * Optionally filtered by severity. Critical findings first.
   */
  async getOpenFindings(repository: string, severity?: string): Promise<Finding[]> {
    if (!repository) {
      throw new ValidationError('repository is required');
    }
    return this.storage.getOpenFindings(normalizePath(repository), severity);
  }

  // ---------------------------------------------------------------------------
  // Gotchas (AMU-AC-12, AMU-AC-13, AMU-AC-30, AMU-AC-31)
  // ---------------------------------------------------------------------------

  /**
   * Store or deduplicate a gotcha (AMU-AC-12).
   * If a semantically similar gotcha exists (cosine similarity >= 0.85 in the same
   * repository), increments its times_encountered and updates last_seen instead of
   * creating a new row (AMU-AC-30).
   * When no embedding provider is configured, falls back to exact description match
   * (case-insensitive, trimmed) (AMU-AC-31).
   */
  async storeGotcha(input: StoreGotchaInput): Promise<StoreGotchaResult> {
    const parsed = CreateGotchaInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError('Invalid gotcha input', parsed.error.errors);
    }
    const data = parsed.data;
    const log = getLogger();

    // Try embedding-based deduplication first (AMU-AC-30)
    const providerName = this.embedding.getProviderName();
    const hasEmbeddingProvider = providerName !== 'none';

    if (hasEmbeddingProvider) {
      let embedding: number[] | null = null;
      try {
        embedding = await this.embedding.generateEmbedding(data.description);
      } catch (err) {
        log.warn({ err }, 'Failed to generate embedding for gotcha; falling back to exact match');
      }

      if (embedding) {
        const similar = await this.storage.findSimilarGotcha(
          data.repository,
          embedding,
          GOTCHA_SIMILARITY_THRESHOLD
        );

        if (similar) {
          const now = new Date().toISOString();
          const updated = await this.storage.updateGotcha(similar.id, {
            times_encountered: similar.times_encountered + 1,
            last_seen: now,
          });
          return { gotcha: updated ?? similar, incremented: true };
        }

        // No similar gotcha — create new with embedding
        const gotcha = await this.storage.createGotcha({
          id: randomUUID(),
          repository: normalizePath(data.repository),
          description: data.description,
          tags: data.tags,
          technology: data.technology ?? null,
          embedding,
        });
        return { gotcha, incremented: false };
      }
    }

    // Fallback: exact description match (case-insensitive, trimmed) (AMU-AC-31)
    const allGotchas = await this.storage.getGotchas(data.repository);
    const normalizedInput = data.description.trim().toLowerCase();
    const exactMatch = allGotchas.find(
      (g) => g.description.trim().toLowerCase() === normalizedInput
    );

    if (exactMatch) {
      const now = new Date().toISOString();
      const updated = await this.storage.updateGotcha(exactMatch.id, {
        times_encountered: exactMatch.times_encountered + 1,
        last_seen: now,
      });
      return { gotcha: updated ?? exactMatch, incremented: true };
    }

    // No match — create new gotcha without embedding
    const gotcha = await this.storage.createGotcha({
      id: randomUUID(),
      repository: normalizePath(data.repository),
      description: data.description,
      tags: data.tags,
      technology: data.technology ?? null,
      embedding: null,
    });
    return { gotcha, incremented: false };
  }

  /**
   * Get all gotchas for a repository (AMU-AC-13).
   * Optionally filtered by technology. Ordered by times_encountered descending.
   */
  async getGotchas(repository: string, technology?: string): Promise<Gotcha[]> {
    if (!repository) {
      throw new ValidationError('repository is required');
    }
    return this.storage.getGotchas(normalizePath(repository), technology);
  }

  // ---------------------------------------------------------------------------
  // Run Summaries (AMU-AC-14, AMU-AC-15)
  // ---------------------------------------------------------------------------

  /**
   * Record a completed execution run (AMU-AC-14).
   */
  async completeRun(input: CompleteRunInputRaw): Promise<RunSummary> {
    const parsed = CompleteRunInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError('Invalid run input', parsed.error.errors);
    }
    const data = parsed.data;

    return this.storage.createRunSummary({
      id: randomUUID(),
      repository: normalizePath(data.repository),
      summary: data.summary,
      files_changed: data.files_changed ?? [],
      outcome: data.outcome,
      duration_seconds: data.duration_seconds ?? null,
    });
  }

  /**
   * Get run history for a repository (AMU-AC-15).
   * Defaults to 10 most recent runs, max 50.
   */
  async getRunHistory(repository: string, limit = 10): Promise<RunSummary[]> {
    if (!repository) {
      throw new ValidationError('repository is required');
    }
    const clampedLimit = Math.min(Math.max(1, limit), 50);
    return this.storage.getRunHistory(normalizePath(repository), clampedLimit);
  }

  // ---------------------------------------------------------------------------
  // Relevant Context (AMU-AC-16, AMU-AC-17, AMU-AC-18)
  // ---------------------------------------------------------------------------

  /**
   * Get task-scoped context across all entity types (AMU-AC-16, AMU-AC-17, AMU-AC-18).
   * Extracts keywords from task_description, queries all entity types for relevance,
   * scores and trims results to the specified budget.
   */
  async getRelevantContext(
    repository: string,
    taskDescription: string,
    budget: ContextBudget = 'standard'
  ): Promise<RelevantContextResult> {
    if (!repository) {
      throw new ValidationError('repository is required');
    }
    if (!taskDescription) {
      throw new ValidationError('task_description is required');
    }

    // Normalize path separators — query with both forward and backslash variants
    // to handle Windows path inconsistencies across different callers
    repository = repository.replace(/\\/g, '/');

    const keywords = extractKeywords(taskDescription);
    const budgetLimit = BUDGET_LIMITS[budget];

    // Fetch all entity types in parallel
    const [decisions, openFindings, gotchas, recentRuns] = await Promise.all([
      this.storage.getRelevantDecisions(repository, keywords),
      this.storage.getRelevantFindings(repository, keywords),
      this._getRelevantGotchas(repository, taskDescription, keywords),
      this.storage.getRunHistory(repository, 2),
    ]);

    // Fetch relevant learnings via FTS or embedding similarity (AMU-AC-18)
    const recentLearnings = await this._getRelevantLearnings(repository, taskDescription, keywords);

    // Trim each section to at most the per-section limits (AMU-AC-17: max 3 per type, recent_runs max 2)
    const trimmedDecisions = decisions.slice(0, 3);
    const trimmedFindings = openFindings.slice(0, 3);
    const trimmedGotchas = gotchas.slice(0, 3);
    const trimmedLearnings = recentLearnings.slice(0, 3);
    const trimmedRuns = recentRuns.slice(0, 2);

    // Apply budget cap: serialize and trim if over budget
    const result = this._applyBudget(
      trimmedDecisions,
      trimmedFindings,
      trimmedGotchas,
      trimmedLearnings,
      trimmedRuns,
      budgetLimit
    );

    const totalItems =
      result.decisions.length +
      result.open_findings.length +
      result.gotchas.length +
      result.recent_learnings.length +
      result.recent_runs.length;

    return {
      ...result,
      summary: { total_items: totalItems, repository },
    };
  }

  /**
   * Get relevant gotchas using embedding similarity when available,
   * falling back to keyword overlap (AMU-AC-18).
   */
  private async _getRelevantGotchas(
    repository: string,
    taskDescription: string,
    keywords: string[]
  ): Promise<Gotcha[]> {
    const log = getLogger();
    const allGotchas = await this.storage.getGotchas(repository);
    if (allGotchas.length === 0) return [];

    const providerName = this.embedding.getProviderName();
    const hasEmbeddingProvider = providerName !== 'none';

    if (hasEmbeddingProvider) {
      let taskEmbedding: number[] | null = null;
      try {
        taskEmbedding = await this.embedding.generateEmbedding(taskDescription);
      } catch (err) {
        log.warn({ err }, 'Failed to generate embedding for task description in getRelevantContext');
      }

      if (taskEmbedding) {
        // Score gotchas by cosine similarity to task description
        const scored = allGotchas
          .filter((g) => g.embedding !== null)
          .map((g) => ({
            gotcha: g,
            score: cosineSimilarity(taskEmbedding!, g.embedding!),
          }))
          .sort((a, b) => {
            // Break ties by times_encountered descending (AMU-AC-17)
            if (Math.abs(a.score - b.score) < 0.001) {
              return b.gotcha.times_encountered - a.gotcha.times_encountered;
            }
            return b.score - a.score;
          });

        // Include gotchas without embeddings at lower priority (keyword overlap)
        const withEmbedding = scored.map((s) => s.gotcha);
        const withoutEmbedding = allGotchas
          .filter((g) => g.embedding === null)
          .filter((g) =>
            keywords.some(
              (kw) =>
                g.description.toLowerCase().includes(kw) ||
                g.tags.some((t) => t.toLowerCase().includes(kw))
            )
          );

        return [...withEmbedding, ...withoutEmbedding];
      }
    }

    // Keyword fallback: overlap on description and tags (AMU-AC-18)
    if (keywords.length === 0) {
      return allGotchas.sort((a, b) => b.times_encountered - a.times_encountered);
    }

    return allGotchas
      .filter((g) =>
        keywords.some(
          (kw) =>
            g.description.toLowerCase().includes(kw) ||
            g.tags.some((t) => t.toLowerCase().includes(kw)) ||
            (g.technology && g.technology.toLowerCase().includes(kw))
        )
      )
      .sort((a, b) => b.times_encountered - a.times_encountered);
  }

  /**
   * Get relevant learnings using FTS or embedding similarity (AMU-AC-18).
   */
  private async _getRelevantLearnings(
    repository: string,
    taskDescription: string,
    keywords: string[]
  ): Promise<Learning[]> {
    const log = getLogger();
    const providerName = this.embedding.getProviderName();
    const hasEmbeddingProvider = providerName !== 'none';

    if (hasEmbeddingProvider) {
      let taskEmbedding: number[] | null = null;
      try {
        taskEmbedding = await this.embedding.generateEmbedding(taskDescription);
      } catch (err) {
        log.warn({ err }, 'Failed to generate embedding for learnings in getRelevantContext');
      }

      if (taskEmbedding) {
        const results = await this.storage.searchByVector(taskEmbedding, {
          repository,
          limit: 3,
          include_deprecated: false,
        });
        return results.map((r) => r as Learning);
      }
    }

    // FTS5 keyword fallback (AMU-AC-18)
    if (keywords.length === 0) return [];
    const query = keywords.slice(0, 5).join(' ');
    try {
      const results = await this.storage.searchByText(query, {
        repository,
        limit: 3,
        include_deprecated: false,
      });
      return results.map((r) => r as Learning);
    } catch {
      return [];
    }
  }

  /**
   * Apply budget limit to the result set.
   * Trims sections until total serialized length is within budget (AMU-AC-17).
   */
  private _applyBudget(
    decisions: Decision[],
    openFindings: Finding[],
    gotchas: Gotcha[],
    recentLearnings: Learning[],
    recentRuns: RunSummary[],
    budgetLimit: number
  ): Omit<RelevantContextResult, 'summary'> {
    // Serialize to estimate character count
    const serialize = (obj: unknown): string => JSON.stringify(obj);

    // Start with full sections and trim if over budget
    const result = {
      decisions: [...decisions],
      open_findings: [...openFindings],
      gotchas: [...gotchas],
      recent_learnings: [...recentLearnings],
      recent_runs: [...recentRuns],
    };

    // Check if within budget
    const totalChars = serialize(result).length;
    if (totalChars <= budgetLimit) {
      return result;
    }

    // Progressively trim: remove items from least-critical sections first
    // Order of trimming: recent_learnings → gotchas → open_findings → decisions
    const sectionsToTrim: Array<keyof typeof result> = [
      'recent_learnings',
      'gotchas',
      'open_findings',
      'decisions',
    ];

    for (const section of sectionsToTrim) {
      while ((result[section] as unknown[]).length > 0 && serialize(result).length > budgetLimit) {
        (result[section] as unknown[]).pop();
      }
      if (serialize(result).length <= budgetLimit) break;
    }

    return result;
  }
}

/**
 * Compute cosine similarity between two float vectors.
 * Duplicated here to avoid circular import with sqlite-adapter.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
