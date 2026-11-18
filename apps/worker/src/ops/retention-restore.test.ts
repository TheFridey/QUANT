import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { readArchiveManifest, restoreRetentionRun, type RetentionDb } from "./retention-executor.js";
import { PROPOSED_RETENTION, policyHash, sha256 } from "./retention-policy.js";

const target = 'postgresql://fixture:fixture@127.0.0.1:55432/odin_test_restore';
const hash = policyHash(PROPOSED_RETENTION);
const replacement = vi.hoisted(() => ({ enabled: false, reads: 0 }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
    if (replacement.enabled && String(args[0]).endsWith('.jsonl.gz') && ++replacement.reads === 2) return Buffer.from('replacement');
    return fs.readFileSync(...args);
  } };
});

async function fixture(text: string, first: string, last: string, rows: number, db: RetentionDb) {
  const root = mkdtempSync(join(tmpdir(), 'aurum-restore-'));
  const gz = gzipSync(Buffer.from(text));
  const file = 'AgentDecision-000001.jsonl.gz';
  writeFileSync(join(root, file), gz);
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ version: 'aurum-retention-1', runId: root.split(/[\\/]/).at(-1)!, createdAt: new Date().toISOString(), policyHash: hash, cutoffs: {}, batches: [{ table: 'AgentDecision', seq: 1, firstKey: first, lastKey: last, rows, file, sha256: sha256(gz), bytes: gz.length }] }));
  try {
    return await restoreRetentionRun({ db, disposableDatabaseUrl: target, archiveDir: join(root, '..'), runId: root.split(/[\\/]/).at(-1)!, expectedPolicyHash: hash, policy: PROPOSED_RETENTION });
  } finally { rmSync(root, { force: true, recursive: true }); }
}

describe('disposable restore preflight', () => {
  const noDatabase: RetentionDb = { query: async () => { throw new Error('database must remain untouched'); } };

  it('refuses a forged range before connecting', async () => {
    expect(await fixture('{"id":"actual"}\n', 'claimed', 'claimed', 1, noDatabase)).toMatchObject({ ok: false, reason: 'ARCHIVE_KEY_RANGE_MISMATCH' });
  });
  it('rechecks the actual restore bytes after the initial manifest verification', async () => {
    replacement.enabled = true;
    replacement.reads = 0;
    try {
      expect(await fixture('{"id":"actual"}\n', 'actual', 'actual', 1, noDatabase)).toMatchObject({ ok: false, reason: 'ARCHIVE_CHANGED_AFTER_VERIFICATION' });
      expect(replacement.reads).toBe(2);
    } finally { replacement.enabled = false; }
  });
  it('rejects wrong run identity, batch explosion and aggregate compressed size before file reads', () => {
    const root = mkdtempSync(join(tmpdir(), 'aurum-manifest-'));
    try {
      for (const manifest of [
        { runId: 'other', batches: [] },
        { runId: 'expected', batches: Array(257).fill({ bytes: 0 }) },
        { runId: 'expected', batches: Array(5).fill({ bytes: 8 * 1024 * 1024 }) },
      ]) {
        writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
        expect(() => readArchiveManifest(root, 'expected')).toThrow();
      }
    } finally { rmSync(root, { force: true, recursive: true }); }
  });
  it('refuses duplicate actual keys before connecting', async () => {
    expect(await fixture('{"id":"actual"}\n{"id":"actual"}\n', 'actual', 'actual', 2, noDatabase)).toMatchObject({ ok: false, reason: 'ARCHIVE_KEY_INVALID' });
  });
  it('bounds inflation before connecting', async () => {
    expect(await fixture('x'.repeat(17 * 1024 * 1024)+'\n', 'actual', 'actual', 1, noDatabase)).toMatchObject({ ok: false, reason: 'ARCHIVE_UNREADABLE' });
  });
  it('refuses target/database disagreement before any insertion', async () => {
    const queries: string[] = [];
    const db: RetentionDb = { query: async <T>(sql: string): Promise<T[]> => {
      queries.push(sql);
      if (sql !== 'SELECT current_database() AS name') throw new Error('write attempted');
      return [{ name: 'production' }] as T[];
    } };
    expect(await fixture('{"id":"actual"}\n', 'actual', 'actual', 1, db)).toMatchObject({ ok: false, reason: 'RESTORE_DATABASE_IDENTITY_MISMATCH' });
    expect(queries).toEqual(['SELECT current_database() AS name']);
  });
});
