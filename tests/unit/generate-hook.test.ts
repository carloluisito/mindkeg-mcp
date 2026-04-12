import { describe, it, expect } from 'vitest';
import { generateBashHook, generateHookConfig } from '../../src/hooks/generate-hook.js';

describe('generateBashHook', () => {
  it('should produce a script starting with shebang', () => {
    const script = generateBashHook();
    expect(script).toMatch(/^#!\/bin\/bash/);
  });

  it('should detect repo via git', () => {
    const script = generateBashHook();
    expect(script).toContain('git rev-parse --show-toplevel');
  });

  it('should always exit 0', () => {
    const script = generateBashHook();
    expect(script.trimEnd()).toMatch(/exit 0$/);
  });

  it('should use node --experimental-sqlite', () => {
    const script = generateBashHook();
    expect(script).toContain('node --experimental-sqlite');
  });

  it('should suppress stderr', () => {
    const script = generateBashHook();
    expect(script).toContain('2>/dev/null');
  });

  it('should contain the improved output header', () => {
    const script = generateBashHook();
    expect(script).toContain('Mind Keg Persistent Memory (from ~/.mindkeg/brain.db):');
  });

  it('should contain the improved footer message', () => {
    const script = generateBashHook();
    expect(script).toContain('These learnings were loaded from Mind Keg.');
  });

  it('should capture output into a variable before echoing', () => {
    const script = generateBashHook();
    expect(script).toContain('OUTPUT=$(');
    expect(script).toContain('if [ -n "$OUTPUT" ]');
    expect(script).toContain('echo "$OUTPUT"');
  });
});

describe('generateHookConfig', () => {
  it('should produce valid SessionStart hook config', () => {
    const config = generateHookConfig('.claude/hooks/load-mindkeg.sh');
    expect(config.hooks).toBeDefined();
    const hooks = config.hooks as Record<string, unknown>;
    const sessionStart = hooks.SessionStart as Array<{ hooks: Array<{ command: string; timeout: number }> }>;
    expect(sessionStart).toBeInstanceOf(Array);
    expect(sessionStart).toHaveLength(1);
    const entry = sessionStart[0]!;
    expect(entry.hooks[0]!.command).toBe('.claude/hooks/load-mindkeg.sh');
    expect(entry.hooks[0]!.timeout).toBe(10);
  });
});
