import { describe, it, expect } from 'vitest';
import { generateBashHook, generatePowerShellHook, generateHookConfig } from '../../src/hooks/generate-hook.js';

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
});

describe('generatePowerShellHook', () => {
  it('should use try/catch for error handling', () => {
    const script = generatePowerShellHook();
    expect(script).toContain('try {');
    expect(script).toContain('catch {');
  });

  it('should always exit 0', () => {
    const script = generatePowerShellHook();
    expect(script.trimEnd()).toMatch(/exit 0$/);
  });

  it('should detect repo via git', () => {
    const script = generatePowerShellHook();
    expect(script).toContain('git rev-parse --show-toplevel');
  });
});

describe('generateHookConfig', () => {
  it('should produce valid SessionStart hook config', () => {
    const config = generateHookConfig('.claude/hooks/load-mindkeg.sh');
    expect(config.hooks).toBeDefined();
    const hooks = config.hooks as Record<string, unknown>;
    const sessionStart = hooks.SessionStart as Array<{ hooks: Array<{ command: string; timeout: number }> }>;
    expect(sessionStart).toBeInstanceOf(Array);
    expect(sessionStart[0].hooks[0].command).toBe('.claude/hooks/load-mindkeg.sh');
    expect(sessionStart[0].hooks[0].timeout).toBe(10);
  });
});
