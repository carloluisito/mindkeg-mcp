#!/usr/bin/env node
/**
 * Mind Keg MCP CLI entry point.
 * Uses Commander.js for command parsing.
 * Traces to AC-20, AC-17, AC-18, AC-24, AC-25.
 */
import { program } from 'commander';
import { registerServeCommand } from './commands/serve.js';
import { registerApiKeyCommand } from './commands/api-key.js';
import { registerMigrateCommand } from './commands/migrate.js';
import { registerExportCommand } from './commands/export.js';
import { registerImportCommand } from './commands/import.js';
import { registerInitCommand } from './commands/init.js';
import { registerStatsCommand } from './commands/stats.js';
import { registerDedupScanCommand } from './commands/dedup-scan.js';
import { registerPurgeCommand } from './commands/purge.js';
import { registerEncryptDbCommand } from './commands/encrypt-db.js';
import { registerDecryptDbCommand } from './commands/decrypt-db.js';
import { registerBackfillIntegrityCommand } from './commands/backfill-integrity.js';
import { registerSetupCommand } from './commands/setup.js';

program
  .name('mindkeg')
  .description('Mind Keg MCP — persistent memory for AI coding agents')
  .version('0.7.1');

registerServeCommand(program);
registerApiKeyCommand(program);
registerMigrateCommand(program);
registerExportCommand(program);
registerImportCommand(program);
registerInitCommand(program);
registerStatsCommand(program);
registerDedupScanCommand(program);
registerPurgeCommand(program);
registerEncryptDbCommand(program);
registerDecryptDbCommand(program);
registerBackfillIntegrityCommand(program);
registerSetupCommand(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
