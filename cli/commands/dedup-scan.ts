/**
 * CLI command: dedup-scan
 * Backfill the duplicate_candidates table for all existing learnings with embeddings.
 * This is an O(N^2) per-scope operation meant to run once on existing databases.
 * Traces to GC-AC-28.
 */
import type { Command } from 'commander';
import { loadConfig } from '../../src/config.js';
import { initLogger } from '../../src/utils/logger.js';
import { SqliteAdapter, cosineSimilarity, DUPLICATE_SIMILARITY_THRESHOLD } from '../../src/storage/sqlite-adapter.js';

/**
 * Register the dedup-scan command on the CLI program.
 */
export function registerDedupScanCommand(program: Command): void {
  program
    .command('dedup-scan')
    .description(
      'Backfill the duplicate_candidates table by scanning all learnings with embeddings. ' +
      'Run once on existing databases after upgrading to v0.3.0+'
    )
    .option('--dry-run', 'Print what would be written without modifying the database')
    .action(async (opts: { dryRun?: boolean }) => {
      const config = loadConfig();
      initLogger(config.server.logLevel, false);

      const storage = new SqliteAdapter(config.storage.sqlitePath);
      await storage.initialize();

      try {
        await runDedupScan(storage, opts.dryRun ?? false);
      } finally {
        await storage.close();
      }
    });
}

/**
 * Core dedup-scan algorithm.
 * Fetches all learnings with embeddings, groups by scope,
 * then computes all-pairs cosine similarity within each scope group.
 * Pairs above DUPLICATE_SIMILARITY_THRESHOLD are written to duplicate_candidates.
 * Traces to GC-AC-28.
 */
async function runDedupScan(storage: SqliteAdapter, dryRun: boolean): Promise<void> {
  // Fetch all active learnings that have embeddings
  const allLearnings = await storage.listAll({ include_deprecated: false });
  const withEmbeddings = allLearnings.filter((l) => l.embedding !== null);

  if (withEmbeddings.length === 0) {
    console.log('No learnings with embeddings found. Nothing to scan.');
    return;
  }

  // Group learnings by scope key: "repo:<path>", "workspace:<path>", or "global"
  type ScopeGroup = {
    label: 'repo' | 'workspace' | 'global';
    scopeValue: string | null;
    learnings: typeof withEmbeddings;
  };

  const scopeMap = new Map<string, ScopeGroup>();

  for (const learning of withEmbeddings) {
    let key: string;
    let label: ScopeGroup['label'];
    let scopeValue: string | null;

    if (learning.repository !== null) {
      key = `repo:${learning.repository}`;
      label = 'repo';
      scopeValue = learning.repository;
    } else if (learning.workspace !== null) {
      key = `workspace:${learning.workspace}`;
      label = 'workspace';
      scopeValue = learning.workspace;
    } else {
      key = 'global';
      label = 'global';
      scopeValue = null;
    }

    const existing = scopeMap.get(key);
    if (existing) {
      existing.learnings.push(learning);
    } else {
      scopeMap.set(key, { label, scopeValue, learnings: [learning] });
    }
  }

  let totalPairsFound = 0;
  let totalScopesProcessed = 0;

  for (const [scopeKey, group] of scopeMap) {
    process.stderr.write(
      `Scanning scope "${scopeKey}" (${group.learnings.length} learnings with embeddings)...\n`
    );

    const { learnings } = group;
    const pairsForScope: Array<{
      idA: string;
      idB: string;
      similarity: number;
    }> = [];

    // All-pairs cosine similarity within this scope group
    for (let i = 0; i < learnings.length; i++) {
      const a = learnings[i]!;
      const embeddingA = a.embedding!; // guaranteed non-null (filtered above)

      for (let j = i + 1; j < learnings.length; j++) {
        const b = learnings[j]!;
        const embeddingB = b.embedding!;

        const similarity = cosineSimilarity(embeddingA, embeddingB);
        if (similarity >= DUPLICATE_SIMILARITY_THRESHOLD) {
          // Normalize ordering: smaller ID first
          const idA = a.id < b.id ? a.id : b.id;
          const idB = a.id < b.id ? b.id : a.id;
          pairsForScope.push({ idA, idB, similarity });
        }
      }
    }

    process.stderr.write(
      `  Found ${pairsForScope.length} duplicate pair(s) in scope "${scopeKey}"\n`
    );

    if (!dryRun && pairsForScope.length > 0) {
      // Persist each detected pair via checkAndStoreDuplicates, one call per pair
      for (const pair of pairsForScope) {
        await storage.checkAndStoreDuplicates(pair.idA, embeddingForId(learnings, pair.idA)!, {
          repository: group.label === 'repo' ? group.scopeValue : null,
          workspace: group.label === 'workspace' ? group.scopeValue : null,
        });
      }
    }

    totalPairsFound += pairsForScope.length;
    totalScopesProcessed++;
  }

  const mode = dryRun ? ' (dry-run, no changes made)' : '';
  console.log(
    `Found ${totalPairsFound} duplicate pair(s) across ${totalScopesProcessed} scope(s)${mode}.`
  );
}

/** Helper to look up the embedding for a given learning ID from the group. */
function embeddingForId(
  learnings: Array<{ id: string; embedding: number[] | null }>,
  id: string
): number[] | null {
  return learnings.find((l) => l.id === id)?.embedding ?? null;
}

// Re-export for testing purposes
export { runDedupScan };
