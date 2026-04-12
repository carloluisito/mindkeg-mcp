/**
 * Unit tests for API key generation, hashing, and access control.
 * Traces to AC-20, AC-21, AC-22, AC-23.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  generateApiKey,
  hashApiKey,
  extractKeyPrefix,
  isValidKeyFormat,
  KEY_PREFIX,
  KEY_PREFIX_LENGTH,
} from '../../src/auth/api-key.js';
import {
  validateApiKey,
  checkRepositoryAccess,
  STDIO_LOCAL_SENTINEL,
} from '../../src/auth/middleware.js';
import { getActorFromApiKey } from '../../src/tools/tool-utils.js';
import { AuthError, AccessError } from '../../src/utils/errors.js';
import type { StorageAdapter, ApiKeyRecord } from '../../src/storage/storage-adapter.js';

// ---------------------------------------------------------------------------
// api-key.ts tests
// ---------------------------------------------------------------------------

describe('generateApiKey', () => {
  it('generates a key starting with "mk_" (AC-20)', () => {
    const key = generateApiKey();
    expect(key.startsWith(KEY_PREFIX)).toBe(true);
  });

  it('generates a key with 64 hex chars after prefix', () => {
    const key = generateApiKey();
    const rest = key.slice(KEY_PREFIX.length);
    expect(rest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates unique keys on each call', () => {
    const key1 = generateApiKey();
    const key2 = generateApiKey();
    expect(key1).not.toBe(key2);
  });
});

describe('hashApiKey', () => {
  it('returns a 64-char hex string (SHA-256)', () => {
    const hash = hashApiKey('mk_' + 'a'.repeat(64));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns the same hash for the same key (deterministic)', () => {
    const key = generateApiKey();
    expect(hashApiKey(key)).toBe(hashApiKey(key));
  });

  it('returns different hashes for different keys', () => {
    const key1 = generateApiKey();
    const key2 = generateApiKey();
    expect(hashApiKey(key1)).not.toBe(hashApiKey(key2));
  });
});

describe('extractKeyPrefix', () => {
  it(`extracts the first ${KEY_PREFIX_LENGTH} chars after "mk_"`, () => {
    const key = `mk_${'a'.repeat(64)}`;
    const prefix = extractKeyPrefix(key);
    expect(prefix).toBe('a'.repeat(KEY_PREFIX_LENGTH));
  });

  it('throws if key does not start with "mk_"', () => {
    expect(() => extractKeyPrefix('sk-notakey')).toThrow();
  });
});

describe('isValidKeyFormat', () => {
  it('returns true for a valid key', () => {
    const key = generateApiKey();
    expect(isValidKeyFormat(key)).toBe(true);
  });

  it('returns false for a key without "mk_" prefix', () => {
    expect(isValidKeyFormat('sk-' + 'a'.repeat(64))).toBe(false);
  });

  it('returns false for a key with wrong character set', () => {
    expect(isValidKeyFormat('mk_' + 'Z'.repeat(64))).toBe(false);
  });

  it('returns false for a key with wrong length', () => {
    expect(isValidKeyFormat('mk_' + 'a'.repeat(32))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// middleware.ts tests
// ---------------------------------------------------------------------------

function makeApiKeyRecord(overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    id: 'some-id',
    name: 'Test Key',
    key_hash: 'some-hash',
    key_prefix: 'mk_test00',
    repositories: [],
    created_at: new Date().toISOString(),
    last_used_at: null,
    revoked: false,
    ...overrides,
  };
}

function makeMockStorage(keyRecord: ApiKeyRecord | null): StorageAdapter {
  return {
    initialize: vi.fn(),
    close: vi.fn(),
    createLearning: vi.fn(),
    getLearning: vi.fn(),
    updateLearning: vi.fn(),
    deleteLearning: vi.fn(),
    searchByText: vi.fn(),
    searchByVector: vi.fn(),
    listRepositories: vi.fn(),
    createApiKey: vi.fn(),
    getApiKeyByHash: vi.fn().mockResolvedValue(keyRecord),
    listApiKeys: vi.fn(),
    revokeApiKey: vi.fn(),
    touchApiKey: vi.fn().mockResolvedValue(undefined),
  } as unknown as StorageAdapter;
}

describe('validateApiKey', () => {
  it('throws AuthError when key is undefined (AC-23)', async () => {
    const storage = makeMockStorage(null);
    await expect(validateApiKey(undefined, storage)).rejects.toThrow(AuthError);
  });

  it('throws AuthError when key is empty string (AC-23)', async () => {
    const storage = makeMockStorage(null);
    await expect(validateApiKey('', storage)).rejects.toThrow(AuthError);
  });

  it('throws AuthError when key is not found (AC-23)', async () => {
    const storage = makeMockStorage(null); // getApiKeyByHash returns null
    await expect(validateApiKey('mk_' + 'a'.repeat(64), storage)).rejects.toThrow(AuthError);
  });

  it('throws AuthError when key is revoked (AC-21, AC-23)', async () => {
    const storage = makeMockStorage(makeApiKeyRecord({ revoked: true }));
    await expect(validateApiKey('mk_' + 'a'.repeat(64), storage)).rejects.toThrow(AuthError);
  });

  it('returns AuthContext for a valid, non-revoked key (AC-21)', async () => {
    const record = makeApiKeyRecord({ revoked: false });
    const storage = makeMockStorage(record);
    const ctx = await validateApiKey('mk_' + 'a'.repeat(64), storage);
    expect(ctx.apiKey).toEqual(record);
    expect(storage.touchApiKey).toHaveBeenCalledWith(record.id);
  });
});

describe('checkRepositoryAccess', () => {
  it('allows access when repositories array is empty (all-access key) (AC-22)', () => {
    const ctx = { apiKey: makeApiKeyRecord({ repositories: [] }) };
    // Should not throw
    expect(() => checkRepositoryAccess(ctx, '/any/repo')).not.toThrow();
  });

  it('allows access to global (null) learnings regardless of key scope (AC-22)', () => {
    const ctx = { apiKey: makeApiKeyRecord({ repositories: ['/repo/a'] }) };
    expect(() => checkRepositoryAccess(ctx, null)).not.toThrow();
  });

  it('allows access when repo is in the key repositories list (AC-22)', () => {
    const ctx = { apiKey: makeApiKeyRecord({ repositories: ['/repo/a', '/repo/b'] }) };
    expect(() => checkRepositoryAccess(ctx, '/repo/a')).not.toThrow();
  });

  it('throws AccessError when repo is not in key repositories list (AC-22)', () => {
    const ctx = { apiKey: makeApiKeyRecord({ repositories: ['/repo/a'] }) };
    expect(() => checkRepositoryAccess(ctx, '/repo/forbidden')).toThrow(AccessError);
  });
});

// ---------------------------------------------------------------------------
// STDIO_LOCAL_SENTINEL tests
// ---------------------------------------------------------------------------

describe('validateApiKey with STDIO_LOCAL_SENTINEL', () => {
  it('returns a synthetic unrestricted AuthContext without calling storage', async () => {
    const storage = makeMockStorage(null);
    const ctx = await validateApiKey(STDIO_LOCAL_SENTINEL, storage);

    expect(ctx.apiKey.id).toBe('stdio-local');
    expect(ctx.apiKey.name).toBe('stdio-local');
    expect(ctx.apiKey.repositories).toEqual([]);
    expect(ctx.apiKey.revoked).toBe(false);
    expect(storage.getApiKeyByHash).not.toHaveBeenCalled();
    expect(storage.touchApiKey).not.toHaveBeenCalled();
  });

  it('synthetic AuthContext passes checkRepositoryAccess for any repository', () => {
    const storage = makeMockStorage(null);
    // We need the AuthContext synchronously — build it directly
    const syntheticCtx = {
      apiKey: makeApiKeyRecord({ id: 'stdio-local', repositories: [] }),
    };
    expect(() => checkRepositoryAccess(syntheticCtx, '/any/repo')).not.toThrow();
    expect(() => checkRepositoryAccess(syntheticCtx, null)).not.toThrow();
    // storage is unused here, suppress the unused-variable lint by referencing it
    void storage;
  });
});

describe('getActorFromApiKey with STDIO_LOCAL_SENTINEL', () => {
  it('returns "stdio-local" for the sentinel key', () => {
    expect(getActorFromApiKey(STDIO_LOCAL_SENTINEL)).toBe('stdio-local');
  });

  it('returns "stdio" when apiKey is undefined', () => {
    expect(getActorFromApiKey(undefined)).toBe('stdio');
  });

  it('returns an 8-char prefix for a normal API key', () => {
    const key = 'mk_' + 'a'.repeat(64);
    expect(getActorFromApiKey(key)).toBe(key.slice(0, 8));
  });
});
