/**
 * CLI command: init
 * Initialize Mind Keg globally (default) or per-project (--project).
 * Global: writes MCP config to home directory, sets up auto-retrieval hook, ensures DB.
 * Project: writes MCP config + AGENTS.md into the current project (legacy behavior).
 */
import type { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { generateBashHook, generateHookConfig } from '../../src/hooks/generate-hook.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type Agent = 'claude-code' | 'cursor' | 'windsurf';

interface AgentConfig {
  label: string;
  /** Project-level config directory (used with --project) */
  projectConfigDir: string;
  /** Project-level MCP config file (used with --project) */
  projectConfigFile: string;
  /** Project-level instruction file (e.g. CLAUDE.md) */
  instructionFile: string | null;
  /** Global MCP config file, relative to homedir() */
  globalConfigFile: string;
  /** Global hook directory, relative to homedir() (null = no hook support) */
  globalHookDir: string | null;
  /** Global settings file, relative to homedir() (null = no settings support) */
  globalSettingsFile: string | null;
  /** Build the MCP server JSON entry */
  mcpEntry: () => Record<string, unknown>;
}

const AGENT_CONFIGS: Record<Agent, AgentConfig> = {
  'claude-code': {
    label: 'Claude Code',
    projectConfigDir: '.claude',
    projectConfigFile: '.claude/mcp.json',
    instructionFile: 'CLAUDE.md',
    globalConfigFile: '.claude.json',
    globalHookDir: '.claude/hooks',
    globalSettingsFile: '.claude/settings.json',
    mcpEntry: () => ({
      command: 'npx',
      args: ['-y', 'mindkeg-mcp', 'serve', '--stdio'],
    }),
  },
  cursor: {
    label: 'Cursor',
    projectConfigDir: '.cursor',
    projectConfigFile: '.cursor/mcp.json',
    instructionFile: null,
    globalConfigFile: '.cursor/mcp.json',
    globalHookDir: null,
    globalSettingsFile: null,
    mcpEntry: () => ({
      command: 'npx',
      args: ['-y', 'mindkeg-mcp', 'serve', '--stdio'],
    }),
  },
  windsurf: {
    label: 'Windsurf',
    projectConfigDir: '.windsurf',
    projectConfigFile: '.windsurf/mcp.json',
    instructionFile: null,
    globalConfigFile: '.windsurf/mcp.json',
    globalHookDir: null,
    globalSettingsFile: null,
    mcpEntry: () => ({
      command: 'npx',
      args: ['-y', 'mindkeg-mcp', 'serve', '--stdio'],
    }),
  },
};

/** Detect which agent tool directories exist in the project root. */
export function detectAgents(projectRoot: string): Agent[] {
  const detected: Agent[] = [];
  for (const [agent, config] of Object.entries(AGENT_CONFIGS)) {
    if (existsSync(join(projectRoot, config.projectConfigDir))) {
      detected.push(agent as Agent);
    }
  }
  return detected;
}

/** Find the git repo root, or fall back to cwd. */
function findProjectRoot(): string {
  try {
    const root = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return root;
  } catch {
    return process.cwd();
  }
}

/** Resolve the AGENTS.md template path (works in dev and after npm install). */
function findTemplatesDir(): string {
  const candidates = [
    resolve(__dirname, '..', '..', 'templates'),      // from dist/cli/commands/
    resolve(__dirname, '..', '..', '..', 'templates'), // from cli/commands/ (dev)
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'AGENTS.md'))) {
      return candidate;
    }
  }
  throw new Error('Could not locate templates/AGENTS.md. Is the package installed correctly?');
}

/** Write the MCP config for a given agent into the project directory. */
export function writeMcpConfig(projectRoot: string, agent: Agent): { created: boolean; path: string } {
  const config = AGENT_CONFIGS[agent];
  const configPath = join(projectRoot, config.projectConfigFile);
  const configDir = join(projectRoot, config.projectConfigDir);

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      // Malformed JSON — we'll overwrite
    }
  }

  const mcpServers = (existing['mcpServers'] ?? {}) as Record<string, unknown>;

  if (mcpServers['mindkeg']) {
    return { created: false, path: configPath };
  }

  mcpServers['mindkeg'] = config.mcpEntry();
  existing['mcpServers'] = mcpServers;

  writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
  return { created: true, path: configPath };
}

/** Write the MCP config for a given agent into the global (home) directory. */
export function writeGlobalMcpConfig(homeDir: string, agent: Agent): { created: boolean; path: string } {
  const config = AGENT_CONFIGS[agent];
  const configPath = join(homeDir, config.globalConfigFile);
  const configDir = dirname(configPath);

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      // Malformed — overwrite
    }
  }

  const mcpServers = (existing['mcpServers'] ?? {}) as Record<string, unknown>;
  if (mcpServers['mindkeg']) {
    return { created: false, path: configPath };
  }

  mcpServers['mindkeg'] = config.mcpEntry();
  existing['mcpServers'] = mcpServers;

  writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
  return { created: true, path: configPath };
}

/** Detect Claude Code profile directories (e.g., ~/.claude-personal, ~/.claude-work). */
export function detectClaudeProfiles(homeDir: string): string[] {
  const profiles: string[] = [];
  try {
    const entries = readdirSync(homeDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('.claude-') && entry.name !== '.claude-worktrees') {
        const settingsPath = join(homeDir, entry.name, 'settings.json');
        if (existsSync(settingsPath)) {
          profiles.push(entry.name);
        }
      }
    }
  } catch {
    // Can't read home dir — return empty
  }
  return profiles;
}

/**
 * Write a hook script and merge its config into a settings.json file.
 * Always generates bash scripts — Claude Code uses bash on all platforms.
 */
export function writeHookToDir(
  hookDir: string,
  settingsPath: string,
): { created: boolean; path: string } {
  const hookFileName = 'load-mindkeg.sh';
  const hookPath = join(hookDir, hookFileName);

  // Write hook script
  if (!existsSync(hookDir)) {
    mkdirSync(hookDir, { recursive: true });
  }

  const scriptContent = generateBashHook();
  writeFileSync(hookPath, scriptContent, 'utf-8');

  // Make executable on Unix
  if (process.platform !== 'win32') {
    try {
      execSync(`chmod +x "${hookPath}"`, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      // chmod might fail on some systems, ignore
    }
  }

  // Merge hook config into settings.json
  // Use bash prefix with forward slashes so it works on all platforms
  const hookCommand = 'bash ' + hookPath.replace(/\\/g, '/');

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      // Malformed — overwrite
    }
  }

  // Generate hook config and deep-merge into settings
  const hookConfig = generateHookConfig(hookCommand);
  const existingHooks = (settings['hooks'] ?? {}) as Record<string, unknown>;
  const newHooks = (hookConfig['hooks'] ?? {}) as Record<string, unknown>;

  // Merge SessionStart array — append if not already present
  const existingSessionStart = (existingHooks['SessionStart'] ?? []) as unknown[];
  const newSessionStart = (newHooks['SessionStart'] ?? []) as unknown[];

  // Check if mindkeg hook already registered
  const alreadyHasMindkeg = existingSessionStart.some((entry: unknown) => {
    const e = entry as Record<string, unknown>;
    const hooks = (e['hooks'] ?? []) as Array<Record<string, unknown>>;
    return hooks.some(h => typeof h['command'] === 'string' && (h['command'] as string).includes('mindkeg'));
  });

  if (!alreadyHasMindkeg) {
    existingHooks['SessionStart'] = [...existingSessionStart, ...newSessionStart];
    settings['hooks'] = existingHooks;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  }

  return { created: !alreadyHasMindkeg, path: hookPath };
}

/** Write the SessionStart auto-retrieval hook for Claude Code (global only). */
export function writeGlobalHook(homeDir: string, agent: Agent): { created: boolean; path: string } | null {
  const config = AGENT_CONFIGS[agent];
  if (!config.globalHookDir || !config.globalSettingsFile) return null;

  const hookDir = join(homeDir, config.globalHookDir);
  const settingsPath = join(homeDir, config.globalSettingsFile);

  return writeHookToDir(hookDir, settingsPath);
}

/** Ensure ~/.mindkeg/ exists and brain.db can be created. */
export function ensureDatabase(homeDir: string): { ready: boolean; path: string; error?: string } {
  const dbDir = join(homeDir, '.mindkeg');
  const dbPath = join(dbDir, 'brain.db');

  try {
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    // Try to open/create the database using node:sqlite
    const escapedPath = dbPath.replace(/\\/g, '\\\\');
    execSync(`node --experimental-sqlite -e "const { DatabaseSync } = require('node:sqlite'); new DatabaseSync('${escapedPath}');"`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return { ready: true, path: dbPath };
  } catch (err) {
    return { ready: false, path: dbPath, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Copy or append AGENTS.md instructions into the project. */
export function writeAgentInstructions(
  projectRoot: string,
  agent: Agent,
  templatesDir: string,
): { action: 'created' | 'appended' | 'skipped'; path: string } {
  const agentsMdSource = join(templatesDir, 'AGENTS.md');
  const agentsMdContent = readFileSync(agentsMdSource, 'utf-8');

  const config = AGENT_CONFIGS[agent];

  // For Claude Code, append to CLAUDE.md if it exists, otherwise copy AGENTS.md
  if (config.instructionFile) {
    const instructionPath = join(projectRoot, config.instructionFile);
    if (existsSync(instructionPath)) {
      const existing = readFileSync(instructionPath, 'utf-8');
      if (existing.includes('Mind Keg')) {
        return { action: 'skipped', path: instructionPath };
      }
      writeFileSync(
        instructionPath,
        existing.trimEnd() + '\n\n' + agentsMdContent,
        'utf-8',
      );
      return { action: 'appended', path: instructionPath };
    }
  }

  // Default: copy AGENTS.md to project root
  const destPath = join(projectRoot, 'AGENTS.md');
  if (existsSync(destPath)) {
    const existing = readFileSync(destPath, 'utf-8');
    if (existing.includes('Mind Keg')) {
      return { action: 'skipped', path: destPath };
    }
    writeFileSync(destPath, existing.trimEnd() + '\n\n' + agentsMdContent, 'utf-8');
    return { action: 'appended', path: destPath };
  }

  copyFileSync(agentsMdSource, destPath);
  return { action: 'created', path: destPath };
}

/** Quick health check: can we create a temp DB and load embeddings? */
function runHealthCheck(): { db: boolean; embeddings: boolean; dbError?: string; embeddingError?: string } {
  const result = { db: false, embeddings: false, dbError: undefined as string | undefined, embeddingError: undefined as string | undefined };

  // DB check: try importing node:sqlite
  try {
    execSync('node --experimental-sqlite -e "require(\'node:sqlite\')"', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    result.db = true;
  } catch {
    result.dbError = 'node:sqlite not available. Requires Node.js 22+.';
  }

  // Node version check as proxy
  const nodeVersion = process.versions.node;
  const major = parseInt(nodeVersion.split('.')[0] ?? '0', 10);
  if (major < 22) {
    result.db = false;
    result.dbError = `Node.js ${nodeVersion} detected. Mind Keg requires Node.js 22+.`;
  } else {
    result.db = true;
  }

  // Embedding check: fastembed availability
  try {
    execSync('node -e "require.resolve(\'fastembed\')"', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: resolve(__dirname, '..', '..'),
    });
    result.embeddings = true;
  } catch {
    result.embeddings = true; // Trust that npx mindkeg-mcp will resolve it
  }

  return result;
}

/** Run the global init flow (default behavior). */
function runGlobalInit(opts: { agent?: string; healthCheck: boolean }): void {
  const home = homedir();
  const agent: Agent = (opts.agent as Agent) || 'claude-code';

  // Validate agent
  const valid = Object.keys(AGENT_CONFIGS);
  if (!valid.includes(agent)) {
    console.error(`Unknown agent "${agent}". Valid options: ${valid.join(', ')}`);
    process.exit(1);
  }

  console.log(`\nMind Keg — Global Setup for ${AGENT_CONFIGS[agent].label}\n`);

  // 1. Write global MCP config
  console.log('MCP Configuration:');
  const mcpResult = writeGlobalMcpConfig(home, agent);
  if (mcpResult.created) {
    console.log(`  ✓ Wrote ${mcpResult.path}`);
  } else {
    console.log(`  - mindkeg already configured in ${mcpResult.path}`);
  }

  // 2. Write global hook (Claude Code only)
  const hookResult = writeGlobalHook(home, agent);
  if (hookResult) {
    console.log('\nSessionStart Hook:');
    if (hookResult.created) {
      console.log(`  ✓ Wrote ${hookResult.path}`);
    } else {
      console.log(`  - Hook already registered`);
    }

    // Also install hooks in detected profile directories
    const profiles = detectClaudeProfiles(home);
    for (const profile of profiles) {
      const profileHookDir = join(home, profile, 'hooks');
      const profileSettingsFile = join(home, profile, 'settings.json');
      const profileResult = writeHookToDir(profileHookDir, profileSettingsFile);
      if (profileResult.created) {
        console.log(`  ✓ Wrote ${profileResult.path} (profile: ${profile})`);
      } else {
        console.log(`  - Hook already registered in ${profile}`);
      }
    }
  }

  // 3. Ensure database
  console.log('\nDatabase:');
  const dbResult = ensureDatabase(home);
  if (dbResult.ready) {
    console.log(`  ✓ Ready at ${dbResult.path}`);
  } else {
    console.log(`  ✗ Failed: ${dbResult.error}`);
  }

  // 4. Health check
  if (opts.healthCheck) {
    console.log('\nHealth Check:');
    const health = runHealthCheck();
    console.log(`  ${health.db ? '✓' : '✗'} Node.js SQLite: ${health.db ? 'OK' : health.dbError}`);
    console.log(`  ${health.embeddings ? '✓' : '✗'} Embeddings: ${health.embeddings ? 'OK (fastembed)' : health.embeddingError}`);
  }

  // 5. Next steps
  console.log('\nDone! Mind Keg is ready. Open any project in your AI agent to start.\n');
}

/** Run the per-project init flow (--project flag). */
function runProjectInit(opts: { agent?: string; instructions: boolean; healthCheck: boolean }): void {
  const projectRoot = findProjectRoot();
  console.log(`\nMind Keg — Initializing in ${projectRoot}\n`);

  // 1. Determine target agents
  let agents: Agent[];
  if (opts.agent) {
    const valid = Object.keys(AGENT_CONFIGS);
    if (!valid.includes(opts.agent)) {
      console.error(`Unknown agent "${opts.agent}". Valid options: ${valid.join(', ')}`);
      process.exit(1);
    }
    agents = [opts.agent as Agent];
  } else {
    agents = detectAgents(projectRoot);
    if (agents.length === 0) {
      agents = ['claude-code'];
      console.log('  No agent directories detected. Defaulting to Claude Code.\n');
    } else {
      console.log(`  Detected: ${agents.map(a => AGENT_CONFIGS[a].label).join(', ')}\n`);
    }
  }

  // 2. Write MCP config for each agent
  console.log('MCP Configuration:');
  for (const agent of agents) {
    const result = writeMcpConfig(projectRoot, agent);
    if (result.created) {
      console.log(`  ✓ ${AGENT_CONFIGS[agent].label}: wrote ${result.path}`);
    } else {
      console.log(`  - ${AGENT_CONFIGS[agent].label}: mindkeg already configured in ${result.path}`);
    }
  }

  // 3. Copy agent instructions
  if (opts.instructions) {
    console.log('\nAgent Instructions:');
    try {
      const templatesDir = findTemplatesDir();
      const firstAgent = agents[0] as Agent;
      const result = writeAgentInstructions(projectRoot, firstAgent, templatesDir);
      switch (result.action) {
        case 'created':
          console.log(`  ✓ Created ${result.path}`);
          break;
        case 'appended':
          console.log(`  ✓ Appended Mind Keg instructions to ${result.path}`);
          break;
        case 'skipped':
          console.log(`  - Mind Keg instructions already present in ${result.path}`);
          break;
      }
    } catch (err) {
      console.log(`  ✗ ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 4. Health check
  if (opts.healthCheck) {
    console.log('\nHealth Check:');
    const health = runHealthCheck();
    console.log(`  ${health.db ? '✓' : '✗'} Node.js SQLite: ${health.db ? 'OK' : health.dbError}`);
    console.log(`  ${health.embeddings ? '✓' : '✗'} Embeddings: ${health.embeddings ? 'OK (fastembed)' : health.embeddingError}`);
  }

  // 5. Next steps
  console.log('\nNext steps:');
  console.log('  1. Open your project in your AI agent (Claude Code, Cursor, etc.)');
  console.log('  2. The agent will automatically connect to Mind Keg via MCP');
  console.log('  3. Start coding — learnings are stored as you work\n');
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize Mind Keg (global by default, --project for per-project setup)')
    .option('--agent <agent>', 'Target agent: claude-code, cursor, windsurf (auto-detects if omitted)')
    .option('--project', 'Per-project setup instead of global', false)
    .option('--no-instructions', 'Skip copying AGENTS.md / appending to CLAUDE.md (--project only)')
    .option('--no-health-check', 'Skip the health check')
    .action(async (opts: { agent?: string; project: boolean; instructions: boolean; healthCheck: boolean }) => {
      if (opts.project) {
        runProjectInit(opts);
      } else {
        runGlobalInit(opts);
      }
    });
}
