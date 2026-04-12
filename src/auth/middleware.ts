/**
 * Auth middleware: validate API keys and enforce repository access control.
 * Traces to AC-21, AC-22, AC-23.
 */
import type { StorageAdapter, ApiKeyRecord } from '../storage/storage-adapter.js';
import { hashApiKey } from './api-key.js';
import { AuthError, AccessError } from '../utils/errors.js';

/** The result of a successful authentication check. */
export interface AuthContext {
  apiKey: ApiKeyRecord;
}

/**
 * Sentinel key value for local stdio transport.
 * When this value is passed as the API key, authentication is bypassed entirely —
 * no database lookup is performed and a synthetic unrestricted AuthContext is returned.
 * This sentinel is ONLY passed by startStdio() and never accepted over HTTP.
 */
export const STDIO_LOCAL_SENTINEL = '__stdio_local__';

/**
 * Validate an API key string against the database.
 * - Recognises STDIO_LOCAL_SENTINEL and short-circuits with a synthetic AuthContext (no DB call)
 * - Hashes the provided key and looks it up in storage
 * - Checks that the key is not revoked (AC-21, AC-23)
 * - Updates last_used_at timestamp
 *
 * @throws AuthError if the key is missing, invalid, or revoked (AC-23)
 */
export async function validateApiKey(
  rawKey: string | undefined,
  storage: StorageAdapter
): Promise<AuthContext> {
  // Bypass auth for local stdio transport — no DB lookup needed
  if (rawKey === STDIO_LOCAL_SENTINEL) {
    const syntheticRecord: ApiKeyRecord = {
      id: 'stdio-local',
      name: 'stdio-local',
      key_hash: '',
      key_prefix: '',
      repositories: [], // empty = all-access
      revoked: false,
      created_at: new Date().toISOString(),
      last_used_at: null,
    };
    return { apiKey: syntheticRecord };
  }

  if (!rawKey || rawKey.trim() === '') {
    throw new AuthError('API key is required. Pass it via the MINDKEG_API_KEY environment variable (stdio) or Authorization: Bearer <key> header (HTTP).');
  }

  const keyHash = hashApiKey(rawKey.trim());
  const keyRecord = await storage.getApiKeyByHash(keyHash);

  if (!keyRecord) {
    throw new AuthError('Invalid API key.');
  }

  if (keyRecord.revoked) {
    throw new AuthError('API key has been revoked.');
  }

  // Update last_used_at asynchronously — don't await to avoid adding latency
  void storage.touchApiKey(keyRecord.id);

  return { apiKey: keyRecord };
}

/**
 * Check that an API key has access to the given repository.
 * - Empty repositories array on the key = access to all repos (AC-22)
 * - Non-empty = only those repos + global (null repository) learnings
 *
 * @throws AccessError if the key lacks access to the requested repository (AC-22)
 */
export function checkRepositoryAccess(
  authContext: AuthContext,
  repository: string | null | undefined
): void {
  const { repositories } = authContext.apiKey;

  // Empty repositories array = all access (AC-22)
  if (repositories.length === 0) return;

  // Global learnings (repository = null) are always accessible
  if (repository === null || repository === undefined) return;

  // Check if the specific repository is in the allowed list
  if (!repositories.includes(repository)) {
    throw new AccessError(
      `API key does not have access to repository: ${repository}. ` +
      `This key is restricted to: ${repositories.join(', ')}`
    );
  }
}

/**
 * Combined auth + access check for tool handlers.
 * Use this in each MCP tool handler before executing any logic.
 *
 * @param rawKey - The API key string extracted from the request context
 * @param storage - The storage adapter for key lookup
 * @param repository - The repository the tool is operating on (null for global)
 */
export async function authenticate(
  rawKey: string | undefined,
  storage: StorageAdapter,
  repository?: string | null
): Promise<AuthContext> {
  const ctx = await validateApiKey(rawKey, storage);
  checkRepositoryAccess(ctx, repository);
  return ctx;
}
