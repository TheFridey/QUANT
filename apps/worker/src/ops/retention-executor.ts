import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync, renameSync, statSync, statfsSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { assertDisposableRetentionTarget, confinedArchivePath } from "./retention-boundary.js";
import {
  APPROVED_RETENTION_POLICY_HASHES,
  dryRunSql,
  policyHash,
  sha256,
  validatePolicy,
  verifyManifest,
  type ArchiveBatchEntry,
  type ArchiveManifest,
  type TableRetention,
} from "./retention-policy.js";

/**
 * OPERATION AURUM Workstream Zero: archive-then-delete executor and restore (docs/aurum/STORAGE-PLAN.md §3).
 *
 * TITANIUM: deletion is disabled pending durable auditing and concurrency correction.
 * No caller-supplied allowlist can enable it. Restore remains local-disposable CLI only.
 * See docs/aurum/TITANIUM-STORAGE-REVIEW.md; the original executor is preserved in git.
 */

export interface RetentionDb {
  query<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
}

/** Session-level single-runner lock. `heldBy` must be answered by another connection than the holder. */
export interface RetentionLock {
  acquire(): Promise<{ pid: number } | null>;
  heldBy(pid: number): Promise<boolean>;
  release(): Promise<void>;
}

export type DiskStat = { freeBytes: number; totalBytes: number };

export type ExecutorHooks = {
  /** After the archive file is published and recorded, before the delete. Throwing simulates a crash. */
  beforeDelete?: (batch: ArchiveBatchEntry) => Promise<void>;
  /** After the delete committed, before the manifest records it. Throwing simulates a crash. */
  afterDelete?: (batch: ArchiveBatchEntry) => Promise<void>;
};

export type ExecuteOptions = {
  db: RetentionDb;
  lock: RetentionLock;
  policy: readonly TableRetention[];
  /** Mandatory: must equal policyHash(policy); real approvals remain empty. */
  expectedPolicyHash: string;
  archiveDir: string;
  now: Date;
  batchRows: number;
  /** Bounded run: stop after this many batches in total (resume continues). */
  maxBatches: number;
  /** Stop when WAL written since the run started exceeds this. */
  maxWalBytes: number;
  /** Free space required beyond twice the estimated archive size. */
  walHeadroomBytes: number;
  dailyGrowthBytes: number;
  backup: { path: string; maxAgeHours: number };
  resumeRunId?: string;
  throttleMs?: number;
  statfs?: (dir: string) => DiskStat;
  hooks?: ExecutorHooks;
};

export type TableOutcome = { archived: number; deleted: number; retained: number; batches: number };

export type ExecuteResult =
  | { ok: true; runId: string; manifestPath: string; complete: boolean; tables: Record<string, TableOutcome>; walBytes: number; stopReason?: string }
  | { ok: false; reason: string; runId?: string; detail?: unknown };

const MANIFEST = "manifest.json";

export function md5(text: string): string {
  return createHash("md5").update(text, "utf8").digest("hex");
}

export function defaultStatfs(dir: string): DiskStat {
  const s = statfsSync(dir);
  return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
}

/** Write-then-rename with fsync of the data, so a crash leaves either the old or the new file, never a torn one. */
export function atomicWrite(path: string, data: Buffer | string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  try {
    const dfd = openSync(resolve(path, ".."), "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    // Directory fsync is not supported on Windows; on Linux it makes the rename durable.
  }
}

export function readArchiveManifest(runDir: string, expectedRunId: string): ArchiveManifest {
  const path = confinedArchivePath(runDir, MANIFEST);
  if (statSync(path).size > 2 * 1024 * 1024) throw new Error('MANIFEST_SIZE_LIMIT');
  const manifest = JSON.parse(readFileSync(path, "utf8")) as ArchiveManifest;
  if (manifest.runId !== expectedRunId || !Array.isArray(manifest.batches) || manifest.batches.length > 256) throw new Error('MANIFEST_IDENTITY_OR_BATCH_LIMIT');
  let total = 0;
  for (const batch of manifest.batches) {
    if (!Number.isSafeInteger(batch.bytes) || batch.bytes < 0 || batch.bytes > 8 * 1024 * 1024) throw new Error('ARCHIVE_COMPRESSED_LIMIT');
    total += batch.bytes;
    if (total > 32 * 1024 * 1024) throw new Error('ARCHIVE_TOTAL_COMPRESSED_LIMIT');
  }
  return manifest;
}

export function readArchiveFiles(runDir: string) {
  return (f: string): Buffer | null => {
    const p = confinedArchivePath(runDir, f);
    if (existsSync(p) && statSync(p).size > 8 * 1024 * 1024) throw new Error('ARCHIVE_COMPRESSED_LIMIT');
    return existsSync(p) ? readFileSync(p) : null;
  };
}

/** Lines of an archive file. Each line is the exact `to_jsonb(row)::text` exported from PostgreSQL. */
export function archiveLines(gz: Buffer): string[] {
  const text = gunzipSync(gz).toString("utf8");
  if (text.length === 0) return [];
  if (!text.endsWith("\n")) throw new Error("ARCHIVE_TRUNCATED");
  return text.slice(0, -1).split("\n");
}

function keyOf(line: string, keyColumn: string): string {
  const v = (JSON.parse(line) as Record<string, unknown>)[keyColumn];
  if (typeof v !== "string") throw new Error("ARCHIVE_KEY_MISSING");
  return v;
}

/** Runs with state RUNNING in the archive directory (a new run is refused while one exists). */
export function incompleteRuns(archiveDir: string): string[] {
  if (!existsSync(archiveDir)) return [];
  return readdirSync(archiveDir).filter((d) => {
    const p = join(archiveDir, d, MANIFEST);
    if (!existsSync(p)) return false;
    try {
      return (JSON.parse(readFileSync(p, "utf8")) as ArchiveManifest).state !== "COMPLETE";
    } catch {
      return true; // an unreadable manifest is treated as incomplete: never start over it
    }
  });
}

/** Estimated archive bytes (candidate rows × average stored row size) and candidate counts. Read-only. */
export async function estimate(db: RetentionDb, policies: readonly TableRetention[], cutoffs: Record<string, Date>) {
  const out: Record<string, { candidateRows: number; estimatedBytes: number }> = {};
  let totalBytes = 0;
  for (const p of policies) {
    const [r] = await db.query<{ total_rows: bigint; candidate_rows: bigint; total_bytes: bigint }>(dryRunSql(p), cutoffs[p.table]!);
    const total = Number(r!.total_rows);
    const candidates = Number(r!.candidate_rows);
    const bytes = total > 0 ? Math.ceil((Number(r!.total_bytes) / total) * candidates) : 0;
    out[p.table] = { candidateRows: candidates, estimatedBytes: bytes };
    totalBytes += bytes;
  }
  return { tables: out, totalBytes };
}

export async function executeRetention(o: ExecuteOptions): Promise<ExecuteResult> {
  if (typeof o.expectedPolicyHash !== "string" || o.expectedPolicyHash.length === 0) return { ok: false, reason: "POLICY_HASH_REQUIRED" };
  const valid = validatePolicy(o.policy);
  if (!valid.ok) return { ok: false, reason: valid.reason };
  const hash = policyHash(o.policy);
  if (hash !== o.expectedPolicyHash) return { ok: false, reason: "POLICY_HASH_MISMATCH", detail: { actual: hash } };
  // The real approval list is authoritative. Caller-provided lists cannot authorise deletion.
  if (!APPROVED_RETENTION_POLICY_HASHES.includes(hash)) return { ok: false, reason: "POLICY_NOT_APPROVED", detail: { hash } };
  // TS01/02/03/05/06 require an independently reviewed durable transaction protocol.
  return { ok: false, reason: "DELETION_BLOCKED_PENDING_DURABLE_AUDIT" };
}

export function summarise(m: ArchiveManifest): Record<string, TableOutcome> {
  const out: Record<string, TableOutcome> = {};
  for (const b of m.batches) {
    const t = (out[b.table] ??= { archived: 0, deleted: 0, retained: 0, batches: 0 });
    t.archived += b.rows;
    t.deleted += b.deletedRows ?? 0;
    t.retained += b.retainedRows ?? 0;
    t.batches++;
  }
  return out;
}

export type RestoreResult =
  | { ok: true; runId: string; inserted: number; skippedExisting: number; verified: number }
  | { ok: false; reason: string; detail?: unknown };

/**
 * Restores a run: verifies the manifest and every file first (nothing is inserted from an invalid archive),
 * inserts with ON CONFLICT DO NOTHING, then checks that every archived row is present with an identical
 * `to_jsonb` text. A row that was retained, or recreated with different content, is reported, not overwritten.
 */
export async function restoreRetentionRun(o: {
  db: RetentionDb;
  /** Explicit local test target; actual current_database() must also match before any write. */
  disposableDatabaseUrl: string;
  archiveDir: string;
  runId: string;
  expectedPolicyHash: string;
  policy: readonly TableRetention[];
  chunkRows?: number;
}): Promise<RestoreResult> {
  const target = assertDisposableRetentionTarget(o.disposableDatabaseUrl);
  const valid = validatePolicy(o.policy);
  if (!valid.ok) return { ok: false, reason: valid.reason };
  if (policyHash(o.policy) !== o.expectedPolicyHash) return { ok: false, reason: "POLICY_HASH_MISMATCH" };
  const runDir = confinedArchivePath(o.archiveDir, o.runId);
  if (!existsSync(join(runDir, MANIFEST))) return { ok: false, reason: "RUN_NOT_FOUND" };
  let m: ArchiveManifest;
  try {
    m = readArchiveManifest(runDir, o.runId);
  } catch {
    return { ok: false, reason: "MANIFEST_UNREADABLE" };
  }
  const read = readArchiveFiles(runDir);
  const v = verifyManifest(m, read, o.expectedPolicyHash);
  if (!v.ok) return { ok: false, reason: "ARCHIVE_INVALID", detail: v.failures };
  const byTable = new Map(o.policy.map((p) => [p.table, p]));
  const parsed: { p: TableRetention; lines: string[] }[] = [];
  const seen = new Set<string>();
  let totalInflatedBytes = 0;
  for (const b of m.batches) {
    const p = byTable.get(b.table);
    if (!p) return { ok: false, reason: "UNKNOWN_TABLE", detail: b.table };
    let lines: string[];
    try {
      const bytes = read(b.file);
      if (!bytes || bytes.length !== b.bytes || sha256(bytes) !== b.sha256) return { ok: false, reason: "ARCHIVE_CHANGED_AFTER_VERIFICATION" };
      // Memory-safety envelope for disposable restoration, not a production retention policy.
      const inflated = gunzipSync(bytes, { maxOutputLength: Math.min(16 * 1024 * 1024, 64 * 1024 * 1024 - totalInflatedBytes) });
      totalInflatedBytes += inflated.byteLength;
      if (totalInflatedBytes >= 64 * 1024 * 1024) return { ok: false, reason: "ARCHIVE_TOTAL_INFLATED_LIMIT" };
      const text = inflated.toString('utf8');
      if (!text.endsWith('\n')) return { ok: false, reason: "ARCHIVE_TRUNCATED" };
      lines = text.slice(0, -1).split('\n');
    } catch (err) {
      return { ok: false, reason: "ARCHIVE_UNREADABLE", detail: { file: b.file, error: err instanceof Error ? err.message : String(err) } };
    }
    if (lines.length !== b.rows) return { ok: false, reason: "ROW_COUNT_MISMATCH", detail: b.file };
    let previous = '';
    for (const line of lines) {
      const key = keyOf(line, p.keyColumn);
      const identity = `${p.table}:${key}`;
      if (key <= previous || seen.has(identity)) return { ok: false, reason: "ARCHIVE_KEY_INVALID" };
      seen.add(identity);
      previous = key;
    }
    if (keyOf(lines[0]!, p.keyColumn) !== b.firstKey || previous !== b.lastKey) return { ok: false, reason: "ARCHIVE_KEY_RANGE_MISMATCH" };
    parsed.push({ p, lines });
  }
  if (o.chunkRows !== undefined && (!Number.isSafeInteger(o.chunkRows) || o.chunkRows < 1 || o.chunkRows > 5000)) return { ok: false, reason: "INVALID_RESTORE_CHUNK" };
  const chunk = o.chunkRows ?? 1000;
  const [identity] = await o.db.query<{ name: string }>('SELECT current_database() AS name');
  if (identity?.name !== new URL(target).pathname.slice(1)) return { ok: false, reason: "RESTORE_DATABASE_IDENTITY_MISMATCH" };
  let inserted = 0;
  let total = 0;
  let verified = 0;
  const mismatched: string[] = [];
  for (const { p, lines } of parsed) {
    for (let i = 0; i < lines.length; i += chunk) {
      const part = lines.slice(i, i + chunk);
      const rows = await o.db.query<{ key: string }>(
        `INSERT INTO "${p.table}" SELECT * FROM jsonb_populate_recordset(NULL::"${p.table}", $1::jsonb) ON CONFLICT DO NOTHING RETURNING "${p.keyColumn}"::text AS key`,
        `[${part.join(",")}]`,
      );
      inserted += rows.length;
      total += part.length;
      const keys = part.map((l) => keyOf(l, p.keyColumn));
      const now = await o.db.query<{ key: string; h: string }>(
        `SELECT t."${p.keyColumn}"::text AS key, md5(to_jsonb(t)::text) AS h FROM "${p.table}" t WHERE t."${p.keyColumn}" = ANY($1::text[])`,
        keys,
      );
      const got = new Map(now.map((r) => [r.key, r.h]));
      part.forEach((l, j) => {
        if (got.get(keys[j]!) === md5(l)) verified++;
        else mismatched.push(`${p.table}:${keys[j]}`);
      });
    }
  }
  if (mismatched.length > 0) return { ok: false, reason: "RESTORE_VERIFY_FAILED", detail: { mismatched: mismatched.slice(0, 50), count: mismatched.length, inserted } };
  return { ok: true, runId: o.runId, inserted, skippedExisting: total - inserted, verified };
}
