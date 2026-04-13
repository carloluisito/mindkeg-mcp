/**
 * Unit tests for MCP server instructions — the behavioral contract
 * delivered to every MCP client at handshake.
 */
import { describe, it, expect } from 'vitest';
import { MINDKEG_SERVER_INSTRUCTIONS } from '../../src/server.js';

describe('MINDKEG_SERVER_INSTRUCTIONS', () => {
  it('is a non-empty string', () => {
    expect(typeof MINDKEG_SERVER_INSTRUCTIONS).toBe('string');
    expect(MINDKEG_SERVER_INSTRUCTIONS.length).toBeGreaterThan(100);
  });

  it('mentions proactive storage pattern', () => {
    expect(MINDKEG_SERVER_INSTRUCTIONS).toMatch(/proactively|Proactively/);
    expect(MINDKEG_SERVER_INSTRUCTIONS).toContain('ask the user');
  });

  it('mentions all four storage types', () => {
    expect(MINDKEG_SERVER_INSTRUCTIONS).toContain('gotcha');
    expect(MINDKEG_SERVER_INSTRUCTIONS).toContain('decision');
    expect(MINDKEG_SERVER_INSTRUCTIONS).toContain('finding');
    expect(MINDKEG_SERVER_INSTRUCTIONS).toContain('learning');
  });

  it('mentions scope question (repo / workspace / global)', () => {
    expect(MINDKEG_SERVER_INSTRUCTIONS).toContain('repo');
    expect(MINDKEG_SERVER_INSTRUCTIONS).toContain('workspace');
    expect(MINDKEG_SERVER_INSTRUCTIONS).toContain('global');
  });

  it('mentions retrieval at session start', () => {
    expect(MINDKEG_SERVER_INSTRUCTIONS).toContain('get_context');
    expect(MINDKEG_SERVER_INSTRUCTIONS).toMatch(/session start|SessionStart/);
  });

  it('mentions the never-store-silently rule', () => {
    expect(MINDKEG_SERVER_INSTRUCTIONS).toMatch(/never store silently|Never store silently/i);
  });

  it('mentions deprecate vs flag_stale distinction', () => {
    expect(MINDKEG_SERVER_INSTRUCTIONS).toContain('deprecate');
    expect(MINDKEG_SERVER_INSTRUCTIONS).toContain('flag_stale');
  });
});

import { createMcpServer } from '../../src/server.js';
import type { StorageAdapter } from '../../src/storage/storage-adapter.js';
import type { EmbeddingService } from '../../src/services/embedding-service.js';

describe('createMcpServer with instructions', () => {
  it('passes MINDKEG_SERVER_INSTRUCTIONS to the McpServer', () => {
    const mockStorage = {} as StorageAdapter;
    const mockEmbedding = {} as EmbeddingService;

    const server = createMcpServer({
      storage: mockStorage,
      embedding: mockEmbedding,
      getApiKey: () => undefined,
    });

    // The McpServer wraps an internal Server that stores instructions in _instructions
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internal = (server as any).server as { _instructions?: string };
    expect(internal._instructions).toBe(MINDKEG_SERVER_INSTRUCTIONS);
  });
});
