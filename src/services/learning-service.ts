/**
 * LearningService: core business logic for learning CRUD and search.
 * Orchestrates storage and embedding generation.
 * Traces to AC-1 through AC-15, AC-27, AC-28, AC-29, AC-30.
 */
import { randomUUID } from 'node:crypto';
import type { StorageAdapter } from '../storage/storage-adapter.js';
import type { EmbeddingService } from './embedding-service.js';
import type { Learning, LearningWithScore, LearningCategory, RelationshipRecord, ConflictRecord } from '../models/learning.js';
import type { Repository } from '../models/repository.js';
import {
  CreateLearningInputSchema,
  UpdateLearningInputSchema,
  DeprecateLearningInputSchema,
  DeleteLearningInputSchema,
  SearchLearningsInputSchema,
  FlagStaleLearningInputSchema,
  GetContextInputSchema,
} from '../models/learning.js';
import type {
  RankedLearning,
  DuplicateGroup,
  GetContextResult,
} from '../models/learning.js';
import { ValidationError, NotFoundError, EmbeddingError } from '../utils/errors.js';
import { getLogger } from '../utils/logger.js';
import { deriveWorkspace, normalizePath } from '../utils/workspace.js';
import { rankLearnings } from './ranking.js';
import { applyBudget } from './budget.js';
import type { BudgetPreset } from './budget.js';
import { cosineSimilarity } from '../storage/sqlite-adapter.js';
import type { DuplicateCandidate } from '../storage/storage-adapter.js';
import { computeIntegrityHash, verifyIntegrityHash } from '../security/integrity.js';
import { detectConflicts, CONFLICT_SIMILARITY_THRESHOLD } from './conflict-detector.js';
import type { z } from 'zod';

/** Raw input type for storeLearning (pre-validation). */
export type StoreLearningInput = z.input<typeof CreateLearningInputSchema>;

/** Raw input type for searchLearnings (pre-validation). */
export type SearchLearningsInput = z.input<typeof SearchLearningsInputSchema>;

/** Raw input type for updateLearning (pre-validation). */
export type UpdateLearningInput = z.input<typeof UpdateLearningInputSchema>;

/** Raw input type for deprecateLearning (pre-validation). */
export type DeprecateLearningInput = z.input<typeof DeprecateLearningInputSchema>;

/** Raw input type for deleteLearning (pre-validation). */
export type DeleteLearningInput = z.input<typeof DeleteLearningInputSchema>;

/** Raw input type for flagStale (pre-validation). */
export type FlagStaleLearningInput = z.input<typeof FlagStaleLearningInputSchema>;

/** Raw input type for getContext (pre-validation). */
export type GetContextInputRaw = z.input<typeof GetContextInputSchema>;

export interface DeleteResult {
  success: boolean;
  id: string;
}

/** Result of storing a learning, including auto-categorization metadata and detected conflicts. */
export interface StoreLearningResult {
  learning: Learning;
  /** True when category was auto-assigned via KNN voting (SKM-AC-20). */
  auto_categorized: boolean;
  /** Detected conflicts between the new learning and existing ones (SKM-AC-26). */
  conflicts: ConflictRecord[];
}

export class LearningService {
  private readonly storage: StorageAdapter;
  private readonly embedding: EmbeddingService;

  constructor(storage: StorageAdapter, embedding: EmbeddingService) {
    this.storage = storage;
    this.embedding = embedding;
  }

  // ---------------------------------------------------------------------------
  // storeLearning (AC-1, AC-6, AC-13, AC-14, AC-15, AC-27, AC-28)
  // ---------------------------------------------------------------------------

  /**
   * Validate, embed, and persist a new learning.
   * When `category` is omitted or null, auto-categorization via KNN voting is attempted (SKM-AC-17).
   * @param rawInput - Raw (unvalidated) input from the MCP tool call
   */
  async storeLearning(rawInput: StoreLearningInput): Promise<StoreLearningResult> {
    const log = getLogger();

    // 1. Validate input (Zod schema enforces AC-6, AC-14, AC-15; category now optional SKM-AC-17)
    const parseResult = CreateLearningInputSchema.safeParse(rawInput);
    if (!parseResult.success) {
      throw new ValidationError(
        `Invalid learning input: ${parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
        parseResult.error.issues
      );
    }
    const input = parseResult.data;

    // 2. Generate embedding for semantic search (AC-9).
    // On EmbeddingError, fall back to null so the learning is still stored and
    // remains searchable via FTS5 keyword fallback until embeddings are backfilled.
    let embeddingVector: number[] | null = null;
    try {
      embeddingVector = await this.embedding.generateEmbedding(input.content);
    } catch (embErr) {
      if (embErr instanceof EmbeddingError) {
        log.warn(
          { error: embErr.message },
          'Embedding generation failed; storing learning without embedding (FTS5 fallback active)'
        );
      } else {
        throw embErr;
      }
    }

    // 3. Auto-categorization (SKM-AC-17, SKM-AC-18, SKM-AC-19, SKM-AC-21)
    // Only runs when category is not explicitly provided.
    let resolvedCategory: LearningCategory;
    let autoCategorized = false;

    if (input.category != null) {
      // SKM-AC-21: Explicit category — skip auto-categorization entirely
      resolvedCategory = input.category;
    } else {
      // Category omitted or null — attempt KNN voting
      if (embeddingVector === null) {
        // No embedding provider (provider=none) — cannot auto-categorize
        throw new ValidationError(
          'Category is required when no embedding provider is configured'
        );
      }

      // Normalize paths for the scope scan (same normalization as step 4 below)
      const normalizedRepositoryForScan =
        input.repository != null ? input.repository.replace(/\\/g, '/') : null;
      const normalizedWorkspaceForScan =
        input.workspace != null ? normalizePath(input.workspace) : null;

      // Consolidated scope scan — fetch all same-scope neighbors (threshold=0.0 to get all)
      const neighbors = await this.storage.findScopedNeighbors(
        embeddingVector,
        { repository: normalizedRepositoryForScan, workspace: normalizedWorkspaceForScan },
        0.0
      );

      const voted = this.autoCategorize(neighbors);
      if (voted === null) {
        // SKM-AC-19: fewer than 3 neighbors — require explicit category
        throw new ValidationError(
          'Auto-categorization failed: insufficient existing learnings in this scope. Please provide an explicit category.'
        );
      }
      resolvedCategory = voted;
      autoCategorized = true;
    }

    // 4. Persist to storage (AC-27 timestamps set by adapter, AC-28 source field)
    // Normalize path separators to forward slashes so stored values always match
    // the normalized form produced by deriveWorkspace() during search (Bug A fix).
    //
    // - workspace: use normalizePath (backslashes → forward slashes + trailing slash)
    //   because deriveWorkspace() always returns paths with trailing slashes.
    // - repository: only replace backslashes — no trailing slash, because repository
    //   is stored and queried as an exact match key, not compared to derived paths.
    const normalizedRepository =
      input.repository != null ? input.repository.replace(/\\/g, '/') : null;
    const normalizedWorkspace = input.workspace != null ? normalizePath(input.workspace) : null;

    // Compute integrity hash (ESH-AC-26) — covers human-authored fields before storage.
    // Uses resolvedCategory (always non-null at this point).
    const integrityHash = computeIntegrityHash({
      content: input.content,
      category: resolvedCategory,
      tags: input.tags,
      repository: normalizedRepository,
      workspace: normalizedWorkspace,
    });

    const id = randomUUID();
    const learning = await this.storage.createLearning({
      id,
      content: input.content,
      category: resolvedCategory,
      tags: input.tags,
      repository: normalizedRepository,
      workspace: normalizedWorkspace,
      group_id: input.group_id,
      source: input.source,
      embedding: embeddingVector,
      integrity_hash: integrityHash,
      source_agent: input.source_agent,
      ttl_days: input.ttl_days,
    });

    const scope = { repository: normalizedRepository, workspace: normalizedWorkspace };

    // 5. Conflict detection + duplicate detection (SKM-AC-22, GC-AC-25).
    // Both run only when an embedding is available; both are non-fatal on failure.
    let detectedConflicts: ConflictRecord[] = [];
    if (embeddingVector !== null) {
      // 5a. Conflict detection: scan for same-scope neighbors above the conflict threshold
      //     (SKM-AC-22 through SKM-AC-24, SKM-AC-29). Excludes the just-created learning itself.
      try {
        let neighbors = await this.storage.findScopedNeighbors(
          embeddingVector,
          scope,
          CONFLICT_SIMILARITY_THRESHOLD
        );
        // Exclude the just-created learning itself from the neighbors list
        neighbors = neighbors.filter((n) => n.id !== id);

        if (neighbors.length > 0) {
          const conflictCandidates = detectConflicts(
            input.content,
            input.tags,
            resolvedCategory,
            neighbors
          );

          for (const candidate of conflictCandidates) {
            const conflictRecord = {
              id: randomUUID(),
              learning_id_a: id,
              learning_id_b: candidate.learning_id,
              similarity: candidate.similarity,
              conflict_type: candidate.conflict_type,
            };
            await this.storage.storeConflict(conflictRecord);
            // Resolve stored pair ordering (adapter enforces id_a < id_b)
            const idA = id < candidate.learning_id ? id : candidate.learning_id;
            const idB = id < candidate.learning_id ? candidate.learning_id : id;
            detectedConflicts.push({
              id: conflictRecord.id,
              learning_id_a: idA,
              learning_id_b: idB,
              similarity: candidate.similarity,
              conflict_type: candidate.conflict_type,
              resolved: false,
              resolved_by: null,
              created_at: new Date().toISOString(),
            });
          }
        }
      } catch (conflictErr) {
        log.warn({ error: String(conflictErr) }, 'Conflict detection failed (non-fatal)');
        detectedConflicts = [];
      }

      // 5b. Duplicate detection: compare against same-scope learnings (GC-AC-25).
      try {
        await this.storage.checkAndStoreDuplicates(id, embeddingVector, scope);
      } catch (dupErr) {
        log.warn({ error: String(dupErr) }, 'Duplicate detection failed (non-fatal)');
      }
    }

    log.info(
      {
        id: learning.id,
        category: resolvedCategory,
        auto_categorized: autoCategorized,
        repository: normalizedRepository,
        workspace: normalizedWorkspace,
        conflicts_detected: detectedConflicts.length,
      },
      'Learning stored'
    );

    return { learning, auto_categorized: autoCategorized, conflicts: detectedConflicts };
  }

  // ---------------------------------------------------------------------------
  // searchLearnings (AC-8, AC-9, AC-10, AC-11, AC-12, AC-29)
  // ---------------------------------------------------------------------------

  /**
   * Search for relevant learnings using semantic similarity (or FTS5 fallback).
   * When repository is provided, auto-derives workspace and searches all three
   * scopes: repo-specific, workspace-wide, and global (WS-AC-12, WS-AC-13).
   * Each result is annotated with a `scope` field (WS-AC-14).
   */
  async searchLearnings(rawInput: SearchLearningsInput): Promise<LearningWithScore[]> {
    const parseResult = SearchLearningsInputSchema.safeParse(rawInput);
    if (!parseResult.success) {
      throw new ValidationError(
        `Invalid search input: ${parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`
      );
    }
    const input = parseResult.data;

    // Normalize the repository filter: replace backslashes with forward slashes
    // so the filter matches the normalized form stored by storeLearning (Bug A fix).
    const normalizedRepoFilter =
      input.repository != null ? input.repository.replace(/\\/g, '/') : undefined;

    // Auto-derive workspace from repository's parent directory (WS-AC-13).
    // deriveWorkspace already normalizes backslashes and adds a trailing slash,
    // so it is safe to call on a backslash-containing Windows path.
    // If the caller also passes an explicit workspace, prefer the derived one
    // (it is always consistent with the stored, normalized repository path).
    // If no repository is provided but an explicit workspace is, use that so
    // agents can scope a search to a workspace without knowing a specific repo
    // (Bug B fix).
    const derivedWorkspace =
      input.repository != null ? deriveWorkspace(input.repository) : undefined;
    const resolvedWorkspace =
      derivedWorkspace ?? (input.workspace != null ? normalizePath(input.workspace) : undefined);

    const filters = {
      repository: normalizedRepoFilter,
      workspace: resolvedWorkspace,
      category: input.category,
      tags: input.tags,
      limit: input.limit,
      include_deprecated: input.include_deprecated,
    };

    // 1. Try semantic search if embedding provider is configured (AC-9)
    const queryEmbedding = await this.embedding.generateEmbedding(input.query);

    let results: LearningWithScore[];
    if (queryEmbedding !== null) {
      // Semantic search path (AC-9)
      results = await this.storage.searchByVector(queryEmbedding, filters);
      // Fall back to FTS5 if semantic search found nothing (e.g., learnings
      // exist but have no embeddings yet — common after a DB migration or
      // when switching embedding providers).
      if (results.length === 0) {
        results = await this.storage.searchByText(input.query, filters);
      }
    } else {
      // 2. FTS5 fallback when no embedding provider is configured
      results = await this.storage.searchByText(input.query, filters);
    }

    // Annotate each result with its scope (WS-AC-14) and optional integrity check (ESH-AC-27)
    const annotated = results.map((r) => ({
      ...r,
      scope: annotateScope(r),
      ...(input.verify_integrity
        ? { integrity_valid: verifyIntegrityHash(r) }
        : {}),
    }));

    // Access tracking (SKM-AC-9, SKM-AC-11 — non-fatal)
    const resultIds = annotated.map((r) => r.id);
    if (resultIds.length > 0) {
      try {
        await this.storage.recordAccess(resultIds);
      } catch (accessErr) {
        getLogger().warn({ error: String(accessErr) }, 'Access tracking in searchLearnings failed (non-fatal)');
      }
    }

    // Attach relationships to each result (SKM-AC-41)
    if (resultIds.length > 0) {
      try {
        const rels = await this.storage.getRelationships(resultIds);
        if (rels.length > 0) {
          const relMap = buildRelationshipMap(rels);
          return annotated.map((r) => {
            const relsForId = relMap.get(r.id);
            return relsForId !== undefined ? { ...r, relationships: relsForId } : r;
          });
        }
      } catch (relErr) {
        getLogger().warn({ error: String(relErr) }, 'Relationship fetch in searchLearnings failed (non-fatal)');
      }
    }

    return annotated;
  }

  // ---------------------------------------------------------------------------
  // updateLearning (AC-3)
  // ---------------------------------------------------------------------------

  /**
   * Update an existing learning. Re-embeds if content changed.
   */
  async updateLearning(rawInput: UpdateLearningInput): Promise<Learning> {
    const parseResult = UpdateLearningInputSchema.safeParse(rawInput);
    if (!parseResult.success) {
      throw new ValidationError(
        `Invalid update input: ${parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`
      );
    }
    const input = parseResult.data;

    // Verify learning exists
    const existing = await this.storage.getLearning(input.id);
    if (!existing) {
      throw new NotFoundError(`Learning not found: ${input.id}`);
    }

    // Re-embed if content changed (AC-9 — keep embeddings fresh)
    let newEmbedding: number[] | null | undefined = undefined;
    if (input.content !== undefined && input.content !== existing.content) {
      newEmbedding = await this.embedding.generateEmbedding(input.content);
    }

    // Recompute integrity hash if any canonical field changed (ESH-AC-26)
    const finalContent = input.content ?? existing.content;
    const finalCategory = input.category ?? existing.category;
    const finalTags = input.tags ?? existing.tags;
    const finalRepository =
      input.repository !== undefined
        ? (input.repository != null ? input.repository.replace(/\\/g, '/') : null)
        : existing.repository;
    const finalWorkspace =
      input.workspace !== undefined
        ? (input.workspace != null ? normalizePath(input.workspace) : null)
        : existing.workspace;

    const newIntegrityHash = computeIntegrityHash({
      content: finalContent,
      category: finalCategory,
      tags: finalTags,
      repository: finalRepository,
      workspace: finalWorkspace,
    });

    const updates: Parameters<StorageAdapter['updateLearning']>[1] = {
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.group_id !== undefined ? { group_id: input.group_id } : {}),
      ...(newEmbedding !== undefined ? { embedding: newEmbedding } : {}),
      ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
      ...(input.repository !== undefined ? { repository: input.repository } : {}),
      ...(input.source_agent !== undefined ? { source_agent: input.source_agent } : {}),
      ...(input.ttl_days !== undefined ? { ttl_days: input.ttl_days } : {}),
      integrity_hash: newIntegrityHash,
    };

    const updated = await this.storage.updateLearning(input.id, updates);
    if (!updated) {
      throw new NotFoundError(`Learning disappeared during update: ${input.id}`);
    }

    // Duplicate detection when content changed and new embedding was generated (GC-AC-25)
    if (newEmbedding !== undefined && newEmbedding !== null) {
      const log = getLogger();
      try {
        await this.storage.checkAndStoreDuplicates(input.id, newEmbedding, {
          repository: updated.repository,
          workspace: updated.workspace,
        });
      } catch (dupErr) {
        log.warn({ error: String(dupErr) }, 'Duplicate detection on update failed (non-fatal)');
      }
    }

    getLogger().info({ id: updated.id }, 'Learning updated');
    return updated;
  }

  // ---------------------------------------------------------------------------
  // deprecateLearning (AC-4)
  // ---------------------------------------------------------------------------

  /**
   * Mark a learning as deprecated. Deprecated learnings are excluded from search by default (AC-4, AC-29).
   */
  async deprecateLearning(rawInput: DeprecateLearningInput): Promise<Learning> {
    const parseResult = DeprecateLearningInputSchema.safeParse(rawInput);
    if (!parseResult.success) {
      throw new ValidationError(
        `Invalid deprecate input: ${parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`
      );
    }
    const input = parseResult.data;

    const existing = await this.storage.getLearning(input.id);
    if (!existing) {
      throw new NotFoundError(`Learning not found: ${input.id}`);
    }

    const updated = await this.storage.updateLearning(input.id, { status: 'deprecated' });
    if (!updated) {
      throw new NotFoundError(`Learning disappeared during deprecation: ${input.id}`);
    }

    // Clean up duplicate candidates (GC-AC-27)
    try {
      await this.storage.cleanupDuplicateCandidates(input.id);
    } catch (dupErr) {
      getLogger().warn({ error: String(dupErr) }, 'Cleanup of duplicate candidates on deprecate failed (non-fatal)');
    }

    // Resolve any conflicts involving the deprecated learning (SKM-AC-28)
    try {
      await this.storage.resolveConflicts(input.id, input.id);
    } catch (conflictErr) {
      getLogger().warn({ error: String(conflictErr) }, 'Conflict resolution on deprecate failed (non-fatal)');
    }

    getLogger().info({ id: updated.id, reason: input.reason }, 'Learning deprecated');
    return updated;
  }

  // ---------------------------------------------------------------------------
  // deleteLearning (AC-5)
  // ---------------------------------------------------------------------------

  /**
   * Permanently delete a learning.
   */
  async deleteLearning(rawInput: DeleteLearningInput): Promise<DeleteResult> {
    const parseResult = DeleteLearningInputSchema.safeParse(rawInput);
    if (!parseResult.success) {
      throw new ValidationError(
        `Invalid delete input: ${parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`
      );
    }
    const input = parseResult.data;

    // Clean up duplicate candidates before delete (GC-AC-27)
    // Belt-and-suspenders: ON DELETE CASCADE handles it automatically,
    // but explicit cleanup ensures correctness across all code paths.
    try {
      await this.storage.cleanupDuplicateCandidates(input.id);
    } catch (dupErr) {
      getLogger().warn({ error: String(dupErr) }, 'Cleanup of duplicate candidates on delete failed (non-fatal)');
    }

    const deleted = await this.storage.deleteLearning(input.id);
    if (!deleted) {
      throw new NotFoundError(`Learning not found: ${input.id}`);
    }

    getLogger().info({ id: input.id }, 'Learning deleted');
    return { success: true, id: input.id };
  }

  // ---------------------------------------------------------------------------
  // flagStale (AC-30)
  // ---------------------------------------------------------------------------

  /**
   * Flag a learning as potentially stale. The stale_flag signals that an agent
   * has found evidence the learning may be outdated and should be reviewed.
   */
  async flagStale(rawInput: FlagStaleLearningInput): Promise<Learning> {
    const parseResult = FlagStaleLearningInputSchema.safeParse(rawInput);
    if (!parseResult.success) {
      throw new ValidationError(
        `Invalid flag-stale input: ${parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`
      );
    }
    const input = parseResult.data;

    const existing = await this.storage.getLearning(input.id);
    if (!existing) {
      throw new NotFoundError(`Learning not found: ${input.id}`);
    }

    // Set stale_flag = true and staleness_score = 1.0 (SKM-AC-36)
    const updated = await this.storage.updateLearning(input.id, {
      stale_flag: true,
      staleness_score: 1.0,
    });
    if (!updated) {
      throw new NotFoundError(`Learning disappeared during stale flag: ${input.id}`);
    }

    getLogger().info({ id: updated.id }, 'Learning flagged as stale');
    return updated;
  }

  // ---------------------------------------------------------------------------
  // listRepositories (AC-16)
  // ---------------------------------------------------------------------------

  /**
   * List all distinct repositories with their learning counts.
   */
  async listRepositories(): Promise<Repository[]> {
    return await this.storage.listRepositories();
  }

  // ---------------------------------------------------------------------------
  // listWorkspaces (WS-AC-16)
  // ---------------------------------------------------------------------------

  /**
   * List all distinct workspaces with their learning counts.
   */
  async listWorkspaces(): Promise<Array<{ workspace: string; learning_count: number }>> {
    return await this.storage.listWorkspaces();
  }

  // ---------------------------------------------------------------------------
  // autoCategorize (SKM-AC-18, SKM-AC-19)
  // ---------------------------------------------------------------------------

  /**
   * Auto-categorize by KNN voting over the nearest embeddings from the
   * consolidated scope scan. Returns the voted category, or null if insufficient
   * neighbors (fewer than 3). Traces to SKM-AC-18, SKM-AC-19.
   *
   * @param neighbors - All same-scope neighbors sorted by similarity descending.
   *   Only the top 5 are used (K=5 per spec SKM-AC-18).
   */
  private autoCategorize(
    neighbors: Array<{ id: string; category: string; similarity: number }>
  ): LearningCategory | null {
    const topK = neighbors.slice(0, 5);
    if (topK.length < 3) return null;

    // Count votes per category
    const votes = new Map<string, { count: number; totalSimilarity: number }>();
    for (const n of topK) {
      const existing = votes.get(n.category) ?? { count: 0, totalSimilarity: 0 };
      existing.count++;
      existing.totalSimilarity += n.similarity;
      votes.set(n.category, existing);
    }

    // Find majority; tie-break by highest average similarity
    let bestCategory: string | null = null;
    let bestCount = 0;
    let bestAvgSim = 0;
    for (const [category, { count, totalSimilarity }] of votes) {
      const avgSim = totalSimilarity / count;
      if (count > bestCount || (count === bestCount && avgSim > bestAvgSim)) {
        bestCategory = category;
        bestCount = count;
        bestAvgSim = avgSim;
      }
    }

    return bestCategory as LearningCategory | null;
  }

  // ---------------------------------------------------------------------------
  // getContext (GC-AC-1 through GC-AC-30)
  // ---------------------------------------------------------------------------

  /**
   * Fetch, rank, partition, and budget-trim learnings for the agent's current context.
   * This is a read-only method — it does not modify any data. Traces to GC-AC-23.
   *
   * @param rawInput - Raw (unvalidated) input from the MCP tool call.
   */
  async getContext(rawInput: GetContextInputRaw): Promise<GetContextResult> {
    const log = getLogger();

    // 1. Validate input
    const parseResult = GetContextInputSchema.safeParse(rawInput);
    if (!parseResult.success) {
      throw new ValidationError(
        `Invalid get_context input: ${parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`
      );
    }
    const input = parseResult.data;

    // 2. Normalize repository path (backslash -> forward slash)
    const normalizedRepository = input.repository.replace(/\\/g, '/');

    // 3. Auto-derive workspace when not provided (GC-AC-3)
    const resolvedWorkspace = input.workspace != null
      ? normalizePath(input.workspace)
      : deriveWorkspace(normalizedRepository);

    log.debug(
      { repository: normalizedRepository, workspace: resolvedWorkspace },
      'getContext: fetching learnings'
    );

    // 4. Fetch all scope-partitioned learnings from storage
    const contextData = await this.storage.getContextLearnings({
      repository: normalizedRepository,
      workspace: resolvedWorkspace,
      include_stale: input.include_stale,
    });

    // 5. Generate query embedding for semantic boost (GC-AC-19, GC-AC-20)
    let queryScores: Map<string, number> | undefined;
    if (input.query) {
      const queryEmbedding = await this.embedding.generateEmbedding(input.query);
      if (queryEmbedding !== null) {
        queryScores = new Map<string, number>();
        const allLearnings = [
          ...contextData.repo,
          ...contextData.workspace,
          ...contextData.global,
        ];
        for (const learning of allLearnings) {
          if (learning.embedding !== null) {
            const score = cosineSimilarity(queryEmbedding, learning.embedding);
            queryScores.set(learning.id, score);
          }
        }
      }
    }

    // 6. Generate path_hint embedding for semantic workspace/global boost (GC-AC-18)
    let pathHintScores: Map<string, number> | undefined;
    if (input.path_hint) {
      const pathEmbedding = await this.embedding.generateEmbedding(input.path_hint);
      if (pathEmbedding !== null) {
        pathHintScores = new Map<string, number>();
        // Apply to workspace and global learnings (not repo — repo uses substring match)
        for (const learning of [...contextData.workspace, ...contextData.global]) {
          if (learning.embedding !== null) {
            const score = cosineSimilarity(pathEmbedding, learning.embedding);
            pathHintScores.set(learning.id, score);
          }
        }
      }
    }

    // 7. Apply ranking function to each scope bucket (GC-AC-6 through GC-AC-9)
    const rankedRepo = rankLearnings(contextData.repo, {
      path_hint: input.path_hint,
      query_scores: queryScores,
    });
    const rankedWorkspace = rankLearnings(contextData.workspace, {
      query_scores: queryScores,
      path_hint_scores: pathHintScores,
    });
    const rankedGlobal = rankLearnings(contextData.global, {
      query_scores: queryScores,
      path_hint_scores: pathHintScores,
    });

    // 8. Apply volume threshold: <= 30 return all, > 30 cap at 20 (GC-AC-10, GC-AC-11)
    const VOLUME_ALL_THRESHOLD = 30;
    const VOLUME_RANKED_CAP = 20;

    const volumeRepo = rankedRepo.length <= VOLUME_ALL_THRESHOLD
      ? rankedRepo
      : rankedRepo.slice(0, VOLUME_RANKED_CAP);
    const volumeWorkspace = rankedWorkspace.length <= VOLUME_ALL_THRESHOLD
      ? rankedWorkspace
      : rankedWorkspace.slice(0, VOLUME_RANKED_CAP);
    const volumeGlobal = rankedGlobal.length <= VOLUME_ALL_THRESHOLD
      ? rankedGlobal
      : rankedGlobal.slice(0, VOLUME_RANKED_CAP);

    // 9. Apply budget trimming — final gate (GC-AC-12 through GC-AC-15a)
    // Rank stale learnings with stale_review_mode: true so highest staleness_score surfaces first
    // (SKM-AC-37)
    const rankedStale = rankLearnings(contextData.stale, { stale_review_mode: true });

    const trimmed = applyBudget(
      {
        repo: volumeRepo,
        workspace: volumeWorkspace,
        global: volumeGlobal,
        stale: rankedStale,
      },
      input.budget as BudgetPreset
    );

    // 10. Fetch duplicate candidates for all returned learning IDs (GC-AC-26)
    const returnedIds = [
      ...trimmed.repo,
      ...trimmed.workspace,
      ...trimmed.global,
    ].map((l) => l.id);

    let nearDuplicates: DuplicateGroup[] | undefined;
    if (returnedIds.length > 0) {
      const duplicateCandidates = await this.storage.getDuplicateCandidates(returnedIds);
      if (duplicateCandidates.length > 0) {
        nearDuplicates = buildDuplicateGroups(duplicateCandidates);
      }
    }

    // 11. Strip embeddings from output and build result
    const toRanked = (l: Learning): RankedLearning => ({
      id: l.id,
      content: l.content,
      category: l.category,
      tags: l.tags,
      repository: l.repository,
      workspace: l.workspace,
      group_id: l.group_id,
      source: l.source,
      status: l.status,
      stale_flag: l.stale_flag,
      created_at: l.created_at,
      updated_at: l.updated_at,
      ttl_days: l.ttl_days,
      source_agent: l.source_agent,
      integrity_hash: l.integrity_hash,
      access_count: l.access_count,
      last_accessed_at: l.last_accessed_at,
      staleness_score: l.staleness_score,
      // Opt-in integrity verification (ESH-AC-27)
      ...(input.verify_integrity
        ? { integrity_valid: verifyIntegrityHash(l) }
        : {}),
    });

    // Access tracking (SKM-AC-10, SKM-AC-11 — non-fatal)
    // OQ-4: stale_review learnings are also considered accessed.
    const allReturnedIds = [
      ...trimmed.repo,
      ...trimmed.workspace,
      ...trimmed.global,
      ...trimmed.stale,
    ].map((l) => l.id);
    if (allReturnedIds.length > 0) {
      try {
        await this.storage.recordAccess(allReturnedIds);
      } catch (accessErr) {
        log.warn({ error: String(accessErr) }, 'Access tracking in getContext failed (non-fatal)');
      }
    }

    // 11a. Fetch unresolved conflicts for all returned learning IDs (SKM-AC-27)
    let unresolvedConflicts: ConflictRecord[] | undefined;
    if (allReturnedIds.length > 0) {
      try {
        const conflicts = await this.storage.getUnresolvedConflicts(allReturnedIds);
        if (conflicts.length > 0) {
          unresolvedConflicts = conflicts;
        }
      } catch (conflictErr) {
        log.warn({ error: String(conflictErr) }, 'Conflict surfacing in getContext failed (non-fatal)');
      }
    }

    // 11b. Fetch relationships for all returned learning IDs (SKM-AC-42)
    // Includes stale_review IDs since they are also returned to the agent
    let relationshipsMap: GetContextResult['relationships'];
    if (allReturnedIds.length > 0) {
      try {
        const rels = await this.storage.getRelationships(allReturnedIds);
        if (rels.length > 0) {
          relationshipsMap = Object.fromEntries(buildRelationshipMap(rels));
        }
      } catch (relErr) {
        log.warn({ error: String(relErr) }, 'Relationship fetch in getContext failed (non-fatal)');
      }
    }

    const result: GetContextResult = {
      summary: contextData.summary,
      repo_learnings: trimmed.repo.map(toRanked),
      workspace_learnings: trimmed.workspace.map(toRanked),
      global_learnings: trimmed.global.map(toRanked),
      stale_review: trimmed.stale.map(toRanked),
      ...(nearDuplicates !== undefined ? { near_duplicates: nearDuplicates } : {}),
      ...(unresolvedConflicts !== undefined ? { conflicts: unresolvedConflicts } : {}),
      ...(relationshipsMap !== undefined ? { relationships: relationshipsMap } : {}),
    };

    log.info(
      {
        repository: normalizedRepository,
        repo_count: result.repo_learnings.length,
        workspace_count: result.workspace_learnings.length,
        global_count: result.global_learnings.length,
        stale_count: result.stale_review.length,
      },
      'getContext: context assembled'
    );

    return result;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a Map from learning ID to its annotated relationships array.
 * Each relationship record produces two entries: one for the source (outgoing)
 * and one for the target (incoming). Only IDs with relationships are included.
 * Traces to SKM-AC-41, SKM-AC-42.
 */
function buildRelationshipMap(
  rels: RelationshipRecord[]
): Map<string, Array<{ type: RelationshipRecord['relationship_type']; related_id: string; direction: 'outgoing' | 'incoming' }>> {
  const map = new Map<string, Array<{ type: RelationshipRecord['relationship_type']; related_id: string; direction: 'outgoing' | 'incoming' }>>();

  for (const rel of rels) {
    // Outgoing: source_id → target_id
    if (!map.has(rel.source_id)) map.set(rel.source_id, []);
    map.get(rel.source_id)!.push({
      type: rel.relationship_type,
      related_id: rel.target_id,
      direction: 'outgoing',
    });

    // Incoming: target_id ← source_id
    if (!map.has(rel.target_id)) map.set(rel.target_id, []);
    map.get(rel.target_id)!.push({
      type: rel.relationship_type,
      related_id: rel.source_id,
      direction: 'incoming',
    });
  }

  return map;
}

/**
 * Build DuplicateGroup objects from raw duplicate_candidates rows.
 * Groups pairs by canonical_id (the older learning by created_at ordering
 * encoded in lexicographic UUID comparison per architecture spec — pairs are
 * stored with learning_id_a < learning_id_b, so id_a is canonical).
 */
function buildDuplicateGroups(candidates: DuplicateCandidate[]): DuplicateGroup[] {
  // Deduplicate: a pair may appear multiple times if both IDs are in the returned set
  const seen = new Set<string>();
  const groupMap = new Map<string, { duplicate_ids: Set<string>; similarity: number }>();

  for (const candidate of candidates) {
    const pairKey = `${candidate.learning_id_a}:${candidate.learning_id_b}`;
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);

    // canonical_id = learning_id_a (guaranteed to be lexicographically smaller = older)
    const canonicalId = candidate.learning_id_a;
    const duplicateId = candidate.learning_id_b;

    const existing = groupMap.get(canonicalId);
    if (existing) {
      existing.duplicate_ids.add(duplicateId);
      existing.similarity = Math.max(existing.similarity, candidate.similarity);
    } else {
      groupMap.set(canonicalId, {
        duplicate_ids: new Set([duplicateId]),
        similarity: candidate.similarity,
      });
    }
  }

  return Array.from(groupMap.entries()).map(([canonical_id, group]) => ({
    canonical_id,
    duplicate_ids: Array.from(group.duplicate_ids),
    similarity: group.similarity,
  }));
}

// ---------------------------------------------------------------------------
// Scope annotation helper (WS-AC-14)
// ---------------------------------------------------------------------------

/**
 * Determine the scope of a learning based on its repository and workspace fields.
 * - repo: learning has a repository set
 * - workspace: learning has a workspace set (but no repository)
 * - global: both are null
 */
function annotateScope(learning: Learning): 'repo' | 'workspace' | 'global' {
  if (learning.repository !== null) return 'repo';
  if (learning.workspace !== null) return 'workspace';
  return 'global';
}
