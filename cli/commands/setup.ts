/**
 * CLI command: setup
 * Global Claude Code setup for Mind Keg: writes MCP config to ~/.claude/settings.json
 * and appends usage instructions to ~/.claude/CLAUDE.md.
 *
 * Traces to AMU-AC-22, AMU-AC-23, AMU-AC-24, AMU-AC-25, AMU-AC-26.
 *
 * Differences from `mindkeg init`:
 * - Scope: global (user-level), not per-project
 * - MCP config target: ~/.claude/settings.json (global Claude Code config)
 * - Instructions target: ~/.claude/CLAUDE.md (global agent instructions)
 * - No health check, no agent detection — always Claude Code global
 */
import type { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

/** Resolve the global ~/.claude directory path. */
function getClaudeDir(): string {
  return join(homedir(), '.claude');
}

/** Resolve the global Claude Code settings.json path. */
function getSettingsPath(): string {
  return join(getClaudeDir(), 'settings.json');
}

/** Resolve the global CLAUDE.md path. */
function getClaudeMdPath(): string {
  return join(getClaudeDir(), 'CLAUDE.md');
}

/** The MCP server entry to inject into settings.json (AMU-AC-23). */
const MINDKEG_MCP_ENTRY = {
  command: 'npx',
  args: ['-y', 'mindkeg-mcp', 'serve', '--stdio'],
  env: {
    MINDKEG_EMBEDDING_PROVIDER: 'fastembed',
  },
};

/** The instructions to append to ~/.claude/CLAUDE.md (AMU-AC-24). */
const MINDKEG_INSTRUCTIONS = `
## Mind Keg — Persistent Agent Memory

You have access to **Mind Keg**, a persistent memory system with structured knowledge for agent workflows.

**You MUST follow these instructions in every session.**

### On Session Start

Call \`get_relevant_context\` to prime yourself with relevant knowledge for your current task:

\`\`\`
get_relevant_context({
  repository: "<current repo path>",
  task_description: "<what you are about to do — 1-3 sentences>",
  budget: "standard"
})
\`\`\`

This returns the most relevant decisions, open findings, gotchas, learnings, and recent run history — scored by relevance to your task.

You may also call \`get_context\` for the full learning dump with staleness review and near-duplicate detection.

### During the Session

Use the appropriate tool for what you discover:

| What you discover | Tool to use |
|---|---|
| An architectural choice with clear WHY (tech selection, design pattern) | \`store_decision\` |
| A code review issue that needs tracking across sessions | \`store_finding\` |
| A non-obvious behavior or footgun | \`store_gotcha\` |
| A short factual insight (debugging tip, convention, gotcha) | \`store_learning\` |

### When a Decision is Replaced

1. Call \`store_decision\` with the new decision → get the new UUID
2. Call \`supersede_decision({ decision_id: oldId, new_decision_id: newId })\`

### When a Finding is Fixed

Call \`resolve_finding({ finding_id: "<uuid>", resolved_by: "<your-agent-name>" })\`

### At Session End

Call \`complete_run\` to record what happened:

\`\`\`
complete_run({
  repository: "<current repo path>",
  summary: "<what was accomplished>",
  files_changed: ["path/to/file1.ts", "path/to/file2.ts"],
  outcome: "success"
})
\`\`\`

### Tool Quick Reference

#### Decisions
- \`store_decision\` — Store an architectural decision with rationale (max 1000 chars choice, 2000 chars rationale)
- \`get_decisions\` — List active decisions for a repo (optional category filter)
- \`supersede_decision\` — Mark a decision as replaced by a newer one

#### Findings
- \`store_finding\` — Store a code review finding (severity: critical/warning/suggestion)
- \`resolve_finding\` — Mark a finding as resolved
- \`get_open_findings\` — List unresolved findings (critical first)

#### Gotchas
- \`store_gotcha\` — Store a non-obvious behavior (auto-deduplicates by similarity)
- \`get_gotchas\` — List gotchas ordered by frequency (most common first)

#### Run History
- \`complete_run\` — Record a completed execution run
- \`get_run_history\` — List recent run summaries

#### Context
- \`get_relevant_context\` — Task-scoped context across all entity types (recommended for session start)
- \`get_context\` — Full learning context with staleness review and near-duplicate detection
`;

/**
 * Write the MCP server entry to ~/.claude/settings.json.
 * Idempotent — skips if mindkeg already present (AMU-AC-25).
 * Returns what action was taken.
 */
export function writeGlobalMcpConfig(): { action: 'written' | 'skipped'; path: string } {
  const settingsPath = getSettingsPath();
  const claudeDir = getClaudeDir();

  // Ensure ~/.claude directory exists
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  // Load existing settings or start fresh
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      // Malformed JSON — we'll overwrite
    }
  }

  const mcpServers = (settings['mcpServers'] ?? {}) as Record<string, unknown>;

  // Idempotency check: skip if mindkeg already configured (AMU-AC-25)
  if (mcpServers['mindkeg']) {
    return { action: 'skipped', path: settingsPath };
  }

  mcpServers['mindkeg'] = MINDKEG_MCP_ENTRY;
  settings['mcpServers'] = mcpServers;

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  return { action: 'written', path: settingsPath };
}

/**
 * Append Mind Keg instructions to ~/.claude/CLAUDE.md.
 * Idempotent — skips if "Mind Keg" already present in file (AMU-AC-25).
 * Creates the file if it does not exist.
 * Returns what action was taken.
 */
export function writeGlobalAgentInstructions(): { action: 'appended' | 'created' | 'skipped'; path: string } {
  const claudeMdPath = getClaudeMdPath();
  const claudeDir = getClaudeDir();

  // Ensure ~/.claude directory exists
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  // Check if file exists and already contains Mind Keg instructions
  if (existsSync(claudeMdPath)) {
    const existing = readFileSync(claudeMdPath, 'utf-8');
    // Idempotency check (AMU-AC-25)
    if (existing.includes('Mind Keg')) {
      return { action: 'skipped', path: claudeMdPath };
    }
    // Append to existing file
    writeFileSync(claudeMdPath, existing.trimEnd() + '\n' + MINDKEG_INSTRUCTIONS, 'utf-8');
    return { action: 'appended', path: claudeMdPath };
  }

  // Create new file with instructions
  writeFileSync(claudeMdPath, MINDKEG_INSTRUCTIONS.trimStart(), 'utf-8');
  return { action: 'created', path: claudeMdPath };
}

export function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .description('Global Claude Code setup: configures MCP server in ~/.claude/settings.json and appends usage instructions to ~/.claude/CLAUDE.md')
    .action(async () => {
      console.log('\nMind Keg — Global Setup\n');

      const actions: string[] = [];

      // 1. Write MCP config to ~/.claude/settings.json (AMU-AC-23)
      console.log('MCP Configuration:');
      const mcpResult = writeGlobalMcpConfig();
      if (mcpResult.action === 'written') {
        console.log(`  + Added mindkeg MCP server to ${mcpResult.path}`);
        actions.push('Added MCP server config');
      } else {
        console.log(`  - mindkeg already configured in ${mcpResult.path} (skipped)`);
      }

      // 2. Write agent instructions to ~/.claude/CLAUDE.md (AMU-AC-24)
      console.log('\nAgent Instructions:');
      const instructionsResult = writeGlobalAgentInstructions();
      if (instructionsResult.action === 'created') {
        console.log(`  + Created ${instructionsResult.path}`);
        actions.push('Created ~/.claude/CLAUDE.md with Mind Keg instructions');
      } else if (instructionsResult.action === 'appended') {
        console.log(`  + Appended Mind Keg instructions to ${instructionsResult.path}`);
        actions.push('Appended Mind Keg instructions to ~/.claude/CLAUDE.md');
      } else {
        console.log(`  - Mind Keg instructions already present in ${instructionsResult.path} (skipped)`);
      }

      // 3. Print summary (AMU-AC-26)
      console.log('\nSummary:');
      if (actions.length > 0) {
        for (const action of actions) {
          console.log(`  + ${action}`);
        }
      } else {
        console.log('  - Nothing to do (already configured)');
      }

      const settingsDir = dirname(getSettingsPath());
      console.log('\nNext steps:');
      console.log('  1. Restart Claude Code to pick up the new MCP configuration');
      console.log('  2. Open any project — Mind Keg will connect automatically via MCP');
      console.log('  3. At session start, call get_relevant_context with your task description');
      console.log(`\nConfig location: ${settingsDir}\n`);
    });
}
