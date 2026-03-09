/**
 * CLI command: stats
 * Display aggregate statistics about the Mind Keg database.
 */
import type { Command } from 'commander';
import { statSync } from 'node:fs';
import { loadConfig } from '../../src/config.js';
import { initLogger } from '../../src/utils/logger.js';
import { createStorageAdapter } from '../../src/storage/storage-factory.js';
import type { LearningStats } from '../../src/storage/storage-adapter.js';

/** Format a file size in bytes to a human-readable string. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Format an ISO date string to a short readable form. */
function formatDate(iso: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Render a simple horizontal bar (max width characters). */
function bar(value: number, max: number, width: number = 20): string {
  if (max === 0) return '';
  const filled = Math.round((value / max) * width);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled);
}

function printStats(stats: LearningStats, dbPath: string): void {
  console.log('\nMind Keg — Database Statistics\n');

  // Overview
  console.log('Overview:');
  console.log(`  Total learnings:  ${stats.total}`);
  console.log(`  Active:           ${stats.active}`);
  console.log(`  Deprecated:       ${stats.deprecated}`);
  console.log(`  Stale-flagged:    ${stats.stale}`);
  console.log(`  With embeddings:  ${stats.withEmbeddings}/${stats.total} (${stats.total > 0 ? Math.round((stats.withEmbeddings / stats.total) * 100) : 0}%)`);

  if (stats.oldestAt || stats.newestAt) {
    console.log(`  First learning:   ${formatDate(stats.oldestAt)}`);
    console.log(`  Latest learning:  ${formatDate(stats.newestAt)}`);
  }

  // DB file size
  try {
    if (dbPath !== ':memory:') {
      const fileStats = statSync(dbPath);
      console.log(`  Database size:    ${formatBytes(fileStats.size)}`);
    }
  } catch {
    // File may not exist yet
  }

  // By category
  if (stats.byCategory.length > 0) {
    const maxCount = Math.max(...stats.byCategory.map(c => c.count));
    console.log('\nBy Category:');
    for (const row of stats.byCategory) {
      const pct = stats.total > 0 ? Math.round((row.count / stats.total) * 100) : 0;
      console.log(`  ${row.category.padEnd(15)} ${bar(row.count, maxCount, 15)} ${String(row.count).padStart(4)} (${pct}%)`);
    }
  }

  // By scope (repo/workspace/global)
  const repoEntries = stats.byRepository.filter(r => r.repository !== null);
  const workspaceEntries = stats.byWorkspace.filter(w => w.workspace !== null);
  const globalCount = stats.byRepository.find(r => r.repository === null)?.count ?? 0;

  console.log('\nBy Scope:');
  console.log(`  Global:           ${globalCount}`);
  console.log(`  Repositories:     ${repoEntries.reduce((sum, r) => sum + r.count, 0)} across ${repoEntries.length} repo(s)`);
  console.log(`  Workspaces:       ${workspaceEntries.reduce((sum, w) => sum + w.count, 0)} across ${workspaceEntries.length} workspace(s)`);

  if (repoEntries.length > 0) {
    console.log('\nTop Repositories:');
    for (const row of repoEntries.slice(0, 10)) {
      console.log(`  ${String(row.count).padStart(4)}  ${row.repository}`);
    }
    if (repoEntries.length > 10) {
      console.log(`  ... and ${repoEntries.length - 10} more`);
    }
  }

  if (workspaceEntries.length > 0) {
    console.log('\nTop Workspaces:');
    for (const row of workspaceEntries.slice(0, 10)) {
      console.log(`  ${String(row.count).padStart(4)}  ${row.workspace}`);
    }
    if (workspaceEntries.length > 10) {
      console.log(`  ... and ${workspaceEntries.length - 10} more`);
    }
  }

  console.log('');
}

export function registerStatsCommand(program: Command): void {
  program
    .command('stats')
    .description('Show statistics about your Mind Keg database')
    .option('--json', 'Output as JSON instead of formatted text')
    .action(async (opts: { json: boolean }) => {
      const config = loadConfig();
      initLogger(config.server.logLevel, false);

      const storage = createStorageAdapter(config);
      await storage.initialize();

      try {
        const stats = await storage.getStats();

        if (opts.json) {
          console.log(JSON.stringify(stats, null, 2));
        } else {
          printStats(stats, config.storage.sqlitePath);
        }
      } finally {
        await storage.close();
      }
    });
}
