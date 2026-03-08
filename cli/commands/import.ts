/**
 * CLI command: import
 * Import learnings from a JSON export file.
 */
import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../src/config.js';
import { initLogger, getLogger } from '../../src/utils/logger.js';
import { createStorageAdapter } from '../../src/storage/storage-factory.js';
import { createEmbeddingService } from '../../src/services/embedding-service.js';
import { CreateLearningInputSchema } from '../../src/models/learning.js';

interface ExportedLearning {
  id?: string;
  content: string;
  category: string;
  tags?: string[];
  repository?: string | null;
  workspace?: string | null;
  group_id?: string | null;
  source?: string;
  status?: string;
  stale_flag?: boolean;
  created_at?: string;
  updated_at?: string;
}

interface ExportFile {
  version: string;
  learnings: ExportedLearning[];
}

export function registerImportCommand(program: Command): void {
  program
    .command('import')
    .description('Import learnings from a JSON export file')
    .argument('<file>', 'Path to the JSON export file')
    .option('--regenerate-embeddings', 'Regenerate embeddings for all imported learnings', false)
    .option('--dry-run', 'Show what would be imported without writing to the database', false)
    .action(async (file: string, opts: { regenerateEmbeddings: boolean; dryRun: boolean }) => {
      const config = loadConfig();
      initLogger(config.server.logLevel, process.stderr.isTTY);
      const log = getLogger();

      const raw = readFileSync(file, 'utf-8');
      const exportData = JSON.parse(raw) as ExportFile;

      if (!Array.isArray(exportData.learnings)) {
        console.error('Invalid export file: missing "learnings" array');
        process.exit(1);
      }

      const learnings = exportData.learnings;
      log.info({ file, count: learnings.length }, 'Import starting');

      if (opts.dryRun) {
        console.log(`[DRY RUN] Would import ${learnings.length} learnings from ${file}`);
        return;
      }

      const storage = createStorageAdapter(config);
      await storage.initialize();

      const embedding = opts.regenerateEmbeddings
        ? createEmbeddingService(config)
        : null;

      let imported = 0;
      let skipped = 0;

      for (const rawLearning of learnings) {
        // Validate before inserting
        const parseResult = CreateLearningInputSchema.safeParse({
          content: rawLearning.content,
          category: rawLearning.category,
          tags: rawLearning.tags ?? [],
          repository: rawLearning.repository ?? null,
          group_id: rawLearning.group_id ?? null,
          source: rawLearning.source ?? 'import',
        });

        if (!parseResult.success) {
          log.warn(
            { content: rawLearning.content?.slice(0, 50), errors: parseResult.error.issues },
            'Skipping invalid learning'
          );
          skipped++;
          continue;
        }

        const embeddingVector = embedding
          ? await embedding.generateEmbedding(rawLearning.content)
          : null;

        try {
          const newId = randomUUID(); // Always generate new IDs to avoid conflicts
          await storage.createLearning({
            id: newId,
            content: parseResult.data.content,
            category: parseResult.data.category,
            tags: parseResult.data.tags,
            repository: parseResult.data.repository,
            workspace: parseResult.data.workspace ?? null,
            group_id: parseResult.data.group_id,
            source: parseResult.data.source,
            embedding: embeddingVector,
          });

          // createLearning always sets status='active' and stale_flag=false.
          // Restore the original state if the exported record differed (F-12).
          const needsStatusRestore = rawLearning.status && rawLearning.status !== 'active';
          const needsStaleRestore = rawLearning.stale_flag === true;
          if (needsStatusRestore || needsStaleRestore) {
            const updates: { status?: string; stale_flag?: boolean } = {};
            if (needsStatusRestore) updates.status = rawLearning.status;
            if (needsStaleRestore) updates.stale_flag = true;
            await storage.updateLearning(newId, updates);
          }

          imported++;
        } catch (err) {
          log.warn({ err, content: rawLearning.content?.slice(0, 50) }, 'Failed to import learning');
          skipped++;
        }
      }

      await storage.close();

      console.log(`Import complete: ${imported} imported, ${skipped} skipped`);
      log.info({ imported, skipped }, 'Import complete');
    });
}
