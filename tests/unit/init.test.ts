/**
 * Unit tests for the `mindkeg init` command helpers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import {
  detectAgents,
  writeMcpConfig,
  writeAgentInstructions,
  writeGlobalMcpConfig,
  writeGlobalHook,
  ensureDatabase,
} from '../../cli/commands/init.js';

/** Create a fresh temp directory for each test. */
function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mindkeg-init-test-'));
}

/** Path to the real templates dir in the repo. */
const TEMPLATES_DIR = join(import.meta.dirname, '..', '..', 'templates');

describe('detectAgents', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty array when no agent directories exist', () => {
    expect(detectAgents(dir)).toEqual([]);
  });

  it('detects .claude directory as claude-code', () => {
    mkdirSync(join(dir, '.claude'));
    expect(detectAgents(dir)).toEqual(['claude-code']);
  });

  it('detects .cursor directory as cursor', () => {
    mkdirSync(join(dir, '.cursor'));
    expect(detectAgents(dir)).toEqual(['cursor']);
  });

  it('detects .windsurf directory as windsurf', () => {
    mkdirSync(join(dir, '.windsurf'));
    expect(detectAgents(dir)).toEqual(['windsurf']);
  });

  it('detects multiple agents simultaneously', () => {
    mkdirSync(join(dir, '.claude'));
    mkdirSync(join(dir, '.cursor'));
    const result = detectAgents(dir);
    expect(result).toContain('claude-code');
    expect(result).toContain('cursor');
    expect(result).toHaveLength(2);
  });

  it('detects all three agents', () => {
    mkdirSync(join(dir, '.claude'));
    mkdirSync(join(dir, '.cursor'));
    mkdirSync(join(dir, '.windsurf'));
    expect(detectAgents(dir)).toHaveLength(3);
  });
});

describe('writeMcpConfig', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates .claude/mcp.json with mindkeg entry for claude-code', () => {
    const result = writeMcpConfig(dir, 'claude-code');
    expect(result.created).toBe(true);

    const config = JSON.parse(readFileSync(join(dir, '.claude', 'mcp.json'), 'utf-8'));
    expect(config.mcpServers.mindkeg).toBeDefined();
    expect(config.mcpServers.mindkeg.command).toBe('npx');
    expect(config.mcpServers.mindkeg.args).toContain('mindkeg-mcp');
    expect(config.mcpServers.mindkeg.args).toContain('--stdio');
  });

  it('creates .cursor/mcp.json for cursor', () => {
    const result = writeMcpConfig(dir, 'cursor');
    expect(result.created).toBe(true);
    expect(existsSync(join(dir, '.cursor', 'mcp.json'))).toBe(true);
  });

  it('creates .windsurf/mcp.json for windsurf', () => {
    const result = writeMcpConfig(dir, 'windsurf');
    expect(result.created).toBe(true);
    expect(existsSync(join(dir, '.windsurf', 'mcp.json'))).toBe(true);
  });

  it('merges with existing mcp.json without overwriting other servers', () => {
    const configDir = join(dir, '.claude');
    mkdirSync(configDir);
    writeFileSync(
      join(configDir, 'mcp.json'),
      JSON.stringify({ mcpServers: { 'other-server': { command: 'other' } } }),
      'utf-8',
    );

    const result = writeMcpConfig(dir, 'claude-code');
    expect(result.created).toBe(true);

    const config = JSON.parse(readFileSync(join(configDir, 'mcp.json'), 'utf-8'));
    expect(config.mcpServers['other-server']).toBeDefined();
    expect(config.mcpServers['other-server'].command).toBe('other');
    expect(config.mcpServers.mindkeg).toBeDefined();
  });

  it('returns created=false if mindkeg is already configured', () => {
    // First call creates
    writeMcpConfig(dir, 'claude-code');
    // Second call skips
    const result = writeMcpConfig(dir, 'claude-code');
    expect(result.created).toBe(false);
  });

  it('does not modify file when mindkeg already exists', () => {
    writeMcpConfig(dir, 'claude-code');
    const contentBefore = readFileSync(join(dir, '.claude', 'mcp.json'), 'utf-8');

    writeMcpConfig(dir, 'claude-code');
    const contentAfter = readFileSync(join(dir, '.claude', 'mcp.json'), 'utf-8');

    expect(contentAfter).toBe(contentBefore);
  });

  it('handles malformed existing JSON by overwriting', () => {
    const configDir = join(dir, '.claude');
    mkdirSync(configDir);
    writeFileSync(join(configDir, 'mcp.json'), '{ broken json !!!', 'utf-8');

    const result = writeMcpConfig(dir, 'claude-code');
    expect(result.created).toBe(true);

    const config = JSON.parse(readFileSync(join(configDir, 'mcp.json'), 'utf-8'));
    expect(config.mcpServers.mindkeg).toBeDefined();
  });

  it('preserves non-mcpServers keys in existing config', () => {
    const configDir = join(dir, '.claude');
    mkdirSync(configDir);
    writeFileSync(
      join(configDir, 'mcp.json'),
      JSON.stringify({ someOtherKey: 'value', mcpServers: {} }),
      'utf-8',
    );

    writeMcpConfig(dir, 'claude-code');
    const config = JSON.parse(readFileSync(join(configDir, 'mcp.json'), 'utf-8'));
    expect(config.someOtherKey).toBe('value');
    expect(config.mcpServers.mindkeg).toBeDefined();
  });

  it('does not include env block in MCP config (auth-free stdio)', () => {
    writeMcpConfig(dir, 'claude-code');
    const config = JSON.parse(readFileSync(join(dir, '.claude', 'mcp.json'), 'utf-8'));
    expect(config.mcpServers.mindkeg.env).toBeUndefined();
  });
});

describe('writeGlobalMcpConfig', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes to global config path for claude-code', () => {
    const result = writeGlobalMcpConfig(dir, 'claude-code');
    expect(result.created).toBe(true);
    expect(result.path).toBe(join(dir, '.claude.json'));

    const config = JSON.parse(readFileSync(result.path, 'utf-8'));
    expect(config.mcpServers.mindkeg).toBeDefined();
    expect(config.mcpServers.mindkeg.command).toBe('npx');
    expect(config.mcpServers.mindkeg.args).toContain('mindkeg-mcp');
  });

  it('writes to global config path for cursor', () => {
    const result = writeGlobalMcpConfig(dir, 'cursor');
    expect(result.created).toBe(true);
    expect(result.path).toBe(join(dir, '.cursor', 'mcp.json'));
  });

  it('writes to global config path for windsurf', () => {
    const result = writeGlobalMcpConfig(dir, 'windsurf');
    expect(result.created).toBe(true);
    expect(result.path).toBe(join(dir, '.windsurf', 'mcp.json'));
  });

  it('does not include env block (no MINDKEG_API_KEY or MINDKEG_EMBEDDING_PROVIDER)', () => {
    const result = writeGlobalMcpConfig(dir, 'claude-code');
    const config = JSON.parse(readFileSync(result.path, 'utf-8'));
    expect(config.mcpServers.mindkeg.env).toBeUndefined();
  });

  it('returns created=false if mindkeg already configured', () => {
    writeGlobalMcpConfig(dir, 'claude-code');
    const result = writeGlobalMcpConfig(dir, 'claude-code');
    expect(result.created).toBe(false);
  });

  it('merges with existing global config', () => {
    writeFileSync(
      join(dir, '.claude.json'),
      JSON.stringify({ mcpServers: { other: { command: 'test' } }, customKey: true }),
      'utf-8',
    );

    const result = writeGlobalMcpConfig(dir, 'claude-code');
    expect(result.created).toBe(true);

    const config = JSON.parse(readFileSync(result.path, 'utf-8'));
    expect(config.mcpServers.other.command).toBe('test');
    expect(config.mcpServers.mindkeg).toBeDefined();
    expect(config.customKey).toBe(true);
  });

  it('creates parent directories if needed', () => {
    const result = writeGlobalMcpConfig(dir, 'cursor');
    expect(result.created).toBe(true);
    expect(existsSync(join(dir, '.cursor', 'mcp.json'))).toBe(true);
  });
});

describe('writeGlobalHook', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null for agents without hook support (cursor)', () => {
    const result = writeGlobalHook(dir, 'cursor');
    expect(result).toBeNull();
  });

  it('returns null for agents without hook support (windsurf)', () => {
    const result = writeGlobalHook(dir, 'windsurf');
    expect(result).toBeNull();
  });

  it('creates hook script for claude-code', () => {
    const result = writeGlobalHook(dir, 'claude-code');
    expect(result).not.toBeNull();
    expect(result!.created).toBe(true);

    const hookContent = readFileSync(result!.path, 'utf-8');
    expect(hookContent).toContain('Mind Keg');
    expect(hookContent).toContain('mindkeg');
  });

  it('creates settings.json with hook config for claude-code', () => {
    writeGlobalHook(dir, 'claude-code');
    const settingsPath = join(dir, '.claude', 'settings.json');
    expect(existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.SessionStart).toBeDefined();
    expect(Array.isArray(settings.hooks.SessionStart)).toBe(true);
    expect(settings.hooks.SessionStart.length).toBeGreaterThan(0);
  });

  it('does not duplicate hook on repeated calls', () => {
    writeGlobalHook(dir, 'claude-code');
    const result2 = writeGlobalHook(dir, 'claude-code');
    expect(result2).not.toBeNull();
    expect(result2!.created).toBe(false);

    const settings = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf-8'));
    expect(settings.hooks.SessionStart).toHaveLength(1);
  });

  it('preserves existing settings.json keys', () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(
      join(dir, '.claude', 'settings.json'),
      JSON.stringify({ existingKey: 'value' }),
      'utf-8',
    );

    writeGlobalHook(dir, 'claude-code');
    const settings = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf-8'));
    expect(settings.existingKey).toBe('value');
    expect(settings.hooks.SessionStart).toBeDefined();
  });
});

describe('ensureDatabase', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates .mindkeg directory if it does not exist', () => {
    const result = ensureDatabase(dir);
    expect(existsSync(join(dir, '.mindkeg'))).toBe(true);
    expect(result.path).toBe(join(dir, '.mindkeg', 'brain.db'));
    // ready depends on node:sqlite availability, but the directory is created either way
  });

  it('returns the correct database path', () => {
    const result = ensureDatabase(dir);
    expect(result.path).toContain('.mindkeg');
    expect(result.path).toContain('brain.db');
  });
});

describe('writeAgentInstructions', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates AGENTS.md when no instruction files exist (claude-code without CLAUDE.md)', () => {
    const result = writeAgentInstructions(dir, 'claude-code', TEMPLATES_DIR);
    expect(result.action).toBe('created');
    expect(result.path).toBe(join(dir, 'AGENTS.md'));

    const content = readFileSync(result.path, 'utf-8');
    expect(content).toContain('Mind Keg -- Agent Instructions');
    expect(content).toContain('get_context');
  });

  it('appends to existing CLAUDE.md for claude-code agent', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), '# My Project\n\nSome instructions.', 'utf-8');

    const result = writeAgentInstructions(dir, 'claude-code', TEMPLATES_DIR);
    expect(result.action).toBe('appended');
    expect(result.path).toBe(join(dir, 'CLAUDE.md'));

    const content = readFileSync(result.path, 'utf-8');
    expect(content).toMatch(/^# My Project/);
    expect(content).toContain('Mind Keg');
  });

  it('skips if CLAUDE.md already contains Mind Keg instructions', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), '# Project\n\nMind Keg is configured.', 'utf-8');

    const result = writeAgentInstructions(dir, 'claude-code', TEMPLATES_DIR);
    expect(result.action).toBe('skipped');
  });

  it('creates AGENTS.md for cursor agent', () => {
    const result = writeAgentInstructions(dir, 'cursor', TEMPLATES_DIR);
    expect(result.action).toBe('created');
    expect(result.path).toBe(join(dir, 'AGENTS.md'));
  });

  it('appends to existing AGENTS.md if it exists (cursor)', () => {
    writeFileSync(join(dir, 'AGENTS.md'), '# Other Agent Instructions\n', 'utf-8');

    const result = writeAgentInstructions(dir, 'cursor', TEMPLATES_DIR);
    expect(result.action).toBe('appended');

    const content = readFileSync(result.path, 'utf-8');
    expect(content).toMatch(/^# Other Agent Instructions/);
    expect(content).toContain('Mind Keg');
  });

  it('skips if AGENTS.md already contains Mind Keg instructions (cursor)', () => {
    writeFileSync(join(dir, 'AGENTS.md'), '# Mind Keg Instructions\n', 'utf-8');

    const result = writeAgentInstructions(dir, 'cursor', TEMPLATES_DIR);
    expect(result.action).toBe('skipped');
  });

  it('does not duplicate content on repeated appends', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), '# Project\n', 'utf-8');

    writeAgentInstructions(dir, 'claude-code', TEMPLATES_DIR);
    const result2 = writeAgentInstructions(dir, 'claude-code', TEMPLATES_DIR);
    expect(result2.action).toBe('skipped');
  });

  it('created AGENTS.md contains behavioral contract keywords', () => {
    writeAgentInstructions(dir, 'cursor', TEMPLATES_DIR);
    const content = readFileSync(join(dir, 'AGENTS.md'), 'utf-8');

    const keywords = [
      'Session Start',
      'During Work',
      'Session End',
      'get_context',
      'store',
      'complete_run',
      'Always ask before storing',
    ];
    for (const keyword of keywords) {
      expect(content).toContain(keyword);
    }
  });
});
