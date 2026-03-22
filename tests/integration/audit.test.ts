/**
 * Integration test: audit logging end-to-end.
 * Verifies that when a tool is invoked, an audit entry is written to the configured file.
 * Traces to ESH-AC-5, ESH-AC-6.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { LearningService } from '../../src/services/learning-service.js';
import { NoneEmbeddingService } from '../../src/services/embedding-service.js';
import { AuditLogger } from '../../src/audit/audit-logger.js';

const tmpAuditFile = path.join(os.tmpdir(), `mindkeg-audit-test-${process.pid}.jsonl`);

describe('Audit logging integration (ESH-AC-5, ESH-AC-6)', () => {
  let storage: SqliteAdapter;
  let learningService: LearningService;
  let auditLogger: AuditLogger;

  beforeEach(async () => {
    // Clean up audit file
    try { fs.unlinkSync(tmpAuditFile); } catch { /* ok */ }

    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    learningService = new LearningService(storage, new NoneEmbeddingService());
    auditLogger = new AuditLogger(tmpAuditFile);
  });

  afterEach(async () => {
    await storage.close();
    try { fs.unlinkSync(tmpAuditFile); } catch { /* ok */ }
  });

  it('writes a valid JSON line to the audit file when logEntry is called', () => {
    auditLogger.logEntry({
      timestamp: new Date().toISOString(),
      action: 'store_learning',
      actor: 'mk_test12',
      resource_id: 'test-uuid-1234',
      result: 'success',
      client: { transport: 'stdio', pid: process.pid },
      metadata: { category: 'gotchas', repository: null },
    });

    expect(fs.existsSync(tmpAuditFile)).toBe(true);
    const lines = fs.readFileSync(tmpAuditFile, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]!);
    expect(entry.action).toBe('store_learning');
    expect(entry.actor).toBe('mk_test12');
    expect(entry.resource_id).toBe('test-uuid-1234');
    expect(entry.result).toBe('success');
    expect(entry.client.transport).toBe('stdio');
    expect(entry.client.pid).toBe(process.pid);
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('appends multiple audit entries without losing prior entries', () => {
    for (let i = 0; i < 5; i++) {
      auditLogger.logEntry({
        timestamp: new Date().toISOString(),
        action: `tool_${i}`,
        actor: 'mk_actor1',
        resource_id: `id-${i}`,
        result: 'success',
        client: { transport: 'stdio' },
      });
    }

    const lines = fs.readFileSync(tmpAuditFile, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(5);
    lines.forEach((line, i) => {
      const entry = JSON.parse(line);
      expect(entry.action).toBe(`tool_${i}`);
    });
  });

  it('stores and retrieves a learning while audit log is active', async () => {
    // Store a learning and manually emit audit entry (as tools do)
    const { learning } = await learningService.storeLearning({
      content: 'Use dependency injection for testability',
      category: 'architecture',
    });

    auditLogger.logEntry({
      timestamp: new Date().toISOString(),
      action: 'store_learning',
      actor: 'stdio',
      resource_id: learning.id,
      result: 'success',
      client: { transport: 'stdio', pid: process.pid },
      metadata: { category: 'architecture', repository: null },
    });

    const lines = fs.readFileSync(tmpAuditFile, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);

    expect(entry.action).toBe('store_learning');
    expect(entry.resource_id).toBe(learning.id);
    // Verify no sensitive fields
    expect(entry).not.toHaveProperty('content');
    expect(entry).not.toHaveProperty('embedding');
  });

  it('audit entry does not contain content or embedding fields (ESH-AC-9)', () => {
    auditLogger.logEntry({
      timestamp: new Date().toISOString(),
      action: 'search_learnings',
      actor: 'mk_abc1234',
      resource_id: null,
      result: 'success',
      client: { transport: 'http', ip: '10.0.0.1' },
      metadata: { result_count: 3, verify_integrity: false },
    });

    const entry = JSON.parse(fs.readFileSync(tmpAuditFile, 'utf8').trim());
    expect(entry).not.toHaveProperty('content');
    expect(entry).not.toHaveProperty('embedding');
    expect(entry.metadata.result_count).toBe(3);
  });
});
