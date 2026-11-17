import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, statfsSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  APPROVED_RETENTION_POLICY_HASHES,
  batchDeleteSql,
  batchExportSql,
  clampBatch,
  cutoffFor,
  diskPressure,
  dryRunSql,
  executablePolicies,
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
 * Safety properties, each covered by `retention-executor.integration.test.ts` on a disposable database:
 * - acts only on a policy whose hash the caller states AND which is listed as approved (empty by default);
 * - never touches MarketObservation or any evidence table (`executablePolicies`, `validatePolicy`);
 * - one runner at a time (session advisory lock), fenced before every delete;
 * - each batch is exported by one statement, written to a temp file, fsynced, read back, hash-checked and only
 *   then renamed into place and recorded in the manifest, before any row is deleted;
 * - the delete re-checks age, every evidence dependency and the row's content hash at delete time;
 * - restart-safe: an interrupted batch is reconciled from its archive file on resume;
 * - refuses on disk pressure, a missing or stale backup, or WAL growth beyond the run's budget.
 * Space is not returned to the OS by DELETE; see STORAGE-PLAN §3.5.
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
  /** P1: mandatory. Must equal `policyHash(policy)` and appear in `approvedPolicyHashes`. */
  expectedPolicyHash: string;
  approvedPolicyHashes?: readonly string[];
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

function readManifest(runDir: string): ArchiveManifest {
  return JSON.parse(readFileSync(join(runDir, MANIFEST), "utf8")) as ArchiveManifest;
}

function writeManifest(runDir: string, m: ArchiveManifest): void {
  atomicWrite(join(runDir, MANIFEST), JSON.stringify(m, null, 2));
}

function readFileOrNull(runDir: string) {
  return (f: string): Buffer | null => {
    const p = join(runDir, f);
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

function checkBackup(backup: ExecuteOptions["backup"], now: Date): string | null {
  if (!backup?.path || !existsSync(backup.path)) return "BACKUP_MISSING";
  const st = statSync(backup.path);
  if (st.size <= 0) return "BACKUP_EMPTY";
  if (now.getTime() - st.mtimeMs > backup.maxAgeHours * 3_600_000) return "BACKUP_STALE";
  return null;
}

async function walLsn(db: RetentionDb): Promise<string> {
  const [r] = await db.query<{ lsn: string }>("SELECT pg_current_wal_lsn()::text AS lsn");
  return r!.lsn;
}

async function walSince(db: RetentionDb, start: string): Promise<number> {
  const [r] = await db.query<{ bytes: string }>("SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), $1::pg_lsn)::text AS bytes", start);
  return Number(r!.bytes);
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

async function deleteBatch(db: RetentionDb, p: TableRetention, cutoff: Date, keys: string[], hashes: string[]): Promise<number> {
  if (keys.length === 0) return 0;
  const rows = await db.query<{ key: string }>(batchDeleteSql(p), cutoff, keys, hashes);
  return rows.length;
}

/** Resolves a batch whose archive was published but whose delete was not recorded (crash or interruption). */
async function reconcilePending(db: RetentionDb, runDir: string, p: TableRetention, cutoff: Date, b: ArchiveBatchEntry) {
  const lines = archiveLines(readFileSync(join(runDir, b.file)));
  const keys = lines.map((l) => keyOf(l, p.keyColumn));
  const present = await db.query<{ key: string }>(`SELECT t."${p.keyColumn}"::text AS key FROM "${p.table}" t WHERE t."${p.keyColumn}" = ANY($1::text[])`, keys);
  const presentSet = new Set(present.map((r) => r.key));
  // Rows already gone were deleted by the interrupted run (nothing else deletes these tables). Retry the rest
  // with full revalidation, so a row that changed or gained evidence meanwhile is kept.
  const retryKeys: string[] = [];
  const retryHashes: string[] = [];
  lines.forEach((l, i) => {
    if (presentSet.has(keys[i]!)) {
      retryKeys.push(keys[i]!);
      retryHashes.push(md5(l));
    }
  });
  const deletedNow = await deleteBatch(db, p, cutoff, retryKeys, retryHashes);
  b.deletedRows = keys.length - presentSet.size + deletedNow;
  b.retainedRows = keys.length - b.deletedRows;
  b.status = "DELETED";
}

export async function executeRetention(o: ExecuteOptions): Promise<ExecuteResult> {
  const approved = o.approvedPolicyHashes ?? APPROVED_RETENTION_POLICY_HASHES;
  if (typeof o.expectedPolicyHash !== "string" || o.expectedPolicyHash.length === 0) return { ok: false, reason: "POLICY_HASH_REQUIRED" };
  const valid = validatePolicy(o.policy);
  if (!valid.ok) return { ok: false, reason: valid.reason };
  const hash = policyHash(o.policy);
  if (hash !== o.expectedPolicyHash) return { ok: false, reason: "POLICY_HASH_MISMATCH", detail: { actual: hash } };
  if (!approved.includes(hash)) return { ok: false, reason: "POLICY_NOT_APPROVED", detail: { hash } };
  const policies = executablePolicies(o.policy);
  if (policies.length === 0) return { ok: false, reason: "NOTHING_EXECUTABLE" };
  if (policies.some((p) => p.table === "MarketObservation")) throw new Error("INVARIANT_MARKET_OBSERVATION_EXECUTABLE");
  if (!Number.isFinite(o.now.getTime())) return { ok: false, reason: "INVALID_NOW" };
  const batchRows = clampBatch(o.batchRows);
  if (!Number.isInteger(o.maxBatches) || o.maxBatches <= 0) return { ok: false, reason: "INVALID_MAX_BATCHES" };
  if (!(o.maxWalBytes > 0) || !(o.walHeadroomBytes >= 0)) return { ok: false, reason: "INVALID_WAL_LIMITS" };

  const held = await o.lock.acquire();
  if (!held) return { ok: false, reason: "LOCKED" };
  let runDir = "";
  let manifest: ArchiveManifest | null = null;
  try {
    mkdirSync(o.archiveDir, { recursive: true });
    if (o.resumeRunId) {
      runDir = join(o.archiveDir, o.resumeRunId);
      if (!existsSync(join(runDir, MANIFEST))) return { ok: false, reason: "RUN_NOT_FOUND", runId: o.resumeRunId };
      manifest = readManifest(runDir);
      if (manifest.policyHash !== hash) return { ok: false, reason: "POLICY_MISMATCH", runId: o.resumeRunId };
      if (manifest.state === "COMPLETE") return { ok: false, reason: "RUN_ALREADY_COMPLETE", runId: o.resumeRunId };
    } else {
      const open = incompleteRuns(o.archiveDir);
      if (open.length > 0) return { ok: false, reason: "INCOMPLETE_RUN_EXISTS", detail: open };
      const runId = `ret-${o.now.toISOString().replace(/[:.]/g, "")}`;
      runDir = join(o.archiveDir, runId);
      if (existsSync(runDir)) return { ok: false, reason: "DUPLICATE_RUN", runId };
      const cutoffs: Record<string, string> = {};
      for (const p of policies) cutoffs[p.table] = cutoffFor(p, o.now).toISOString();
      manifest = { version: "aurum-retention-1", createdAt: o.now.toISOString(), policyHash: hash, cutoffs, batches: [], runId, state: "RUNNING", cursor: {} };
    }
    const m = manifest;
    const runId = m.runId!;
    // An existing archive must verify before anything else happens (corruption, duplicates, overlaps).
    if (m.batches.length > 0) {
      const v = verifyManifest(m, readFileOrNull(runDir), o.expectedPolicyHash);
      if (!v.ok) return { ok: false, reason: "ARCHIVE_INVALID", runId, detail: v.failures };
    }
    const cutoffs: Record<string, Date> = {};
    for (const p of policies) {
      const c = m.cutoffs[p.table];
      if (!c) return { ok: false, reason: "CUTOFF_MISSING", runId };
      cutoffs[p.table] = new Date(c);
    }

    // Pre-flight: backup, disk and estimate. Nothing has been written to the database yet.
    const backupProblem = checkBackup(o.backup, o.now);
    if (backupProblem) return { ok: false, reason: backupProblem, runId };
    const est = await estimate(o.db, policies, cutoffs);
    const disk = (o.statfs ?? defaultStatfs)(o.archiveDir);
    const required = 2 * est.totalBytes + o.walHeadroomBytes;
    const pressure = diskPressure({ freeBytes: disk.freeBytes, totalBytes: disk.totalBytes, dailyGrowthBytes: o.dailyGrowthBytes });
    m.estimate = { ...est, requiredFreeBytes: required, freeBytes: disk.freeBytes, pressure: pressure.level };
    if (pressure.level === "CRITICAL") return { ok: false, reason: "DISK_CRITICAL", runId, detail: m.estimate };
    if (disk.freeBytes < required) return { ok: false, reason: "INSUFFICIENT_DISK", runId, detail: m.estimate };
    if (!existsSync(runDir)) mkdirSync(runDir);
    writeManifest(runDir, m);

    // Resolve batches an earlier attempt left between publication and delete.
    for (const b of m.batches.filter((x) => x.status !== "DELETED")) {
      const p = policies.find((x) => x.table === b.table);
      if (!p) return { ok: false, reason: "ARCHIVE_TABLE_NOT_EXECUTABLE", runId };
      if (!(await o.lock.heldBy(held.pid))) return { ok: false, reason: "LOCK_LOST", runId };
      await reconcilePending(o.db, runDir, p, cutoffs[p.table]!, b);
      m.cursor![b.table] = b.lastKey > (m.cursor![b.table] ?? "") ? b.lastKey : m.cursor![b.table]!;
      writeManifest(runDir, m);
    }

    const walStart = await walLsn(o.db);
    let batches = 0;
    let stopReason: string | undefined;
    outer: for (const p of policies) {
      const cutoff = cutoffs[p.table]!;
      for (;;) {
        if (batches >= o.maxBatches) {
          stopReason = "MAX_BATCHES";
          break outer;
        }
        const wal = await walSince(o.db, walStart);
        if (wal > o.maxWalBytes) {
          stopReason = "WAL_BUDGET_EXCEEDED";
          break outer;
        }
        const after = m.cursor![p.table] ?? "";
        const rows = await o.db.query<{ key: string; doc: string }>(batchExportSql(p), cutoff, after, batchRows);
        if (rows.length === 0) break;
        let prev = after;
        for (const r of rows) {
          // Keyset pagination relies on the database order matching JS string order. Refuse if it ever does not.
          if (!(r.key > prev)) return { ok: false, reason: "KEY_ORDER_MISMATCH", runId, detail: { table: p.table, key: r.key, prev } };
          prev = r.key;
        }
        const seq = m.batches.filter((b) => b.table === p.table).reduce((n, b) => Math.max(n, b.seq), 0) + 1;
        const file = `${p.table}-${String(seq).padStart(6, "0")}.jsonl.gz`;
        const gz = gzipSync(Buffer.from(rows.map((r) => r.doc).join("\n") + "\n", "utf8"));
        const digest = sha256(gz);
        const finalPath = join(runDir, file);
        if (existsSync(finalPath)) return { ok: false, reason: "ARCHIVE_FILE_EXISTS", runId, detail: file };
        atomicWrite(finalPath, gz);
        // Read back what is on disk and check it before recording it, and before any delete.
        const back = readFileSync(finalPath);
        if (back.byteLength !== gz.byteLength || sha256(back) !== digest || archiveLines(back).length !== rows.length) {
          return { ok: false, reason: "ARCHIVE_READBACK_FAILED", runId, detail: file };
        }
        const entry: ArchiveBatchEntry = {
          table: p.table,
          seq,
          firstKey: rows[0]!.key,
          lastKey: rows[rows.length - 1]!.key,
          rows: rows.length,
          file,
          sha256: digest,
          bytes: gz.byteLength,
          status: "PENDING_DELETE",
        };
        m.batches.push(entry);
        const v = verifyManifest(m, readFileOrNull(runDir), o.expectedPolicyHash);
        if (!v.ok) {
          m.batches.pop();
          return { ok: false, reason: "ARCHIVE_INVALID", runId, detail: v.failures };
        }
        writeManifest(runDir, m);
        await o.hooks?.beforeDelete?.(entry);
        if (!(await o.lock.heldBy(held.pid))) return { ok: false, reason: "LOCK_LOST", runId };
        const deleted = await deleteBatch(o.db, p, cutoff, rows.map((r) => r.key), rows.map((r) => md5(r.doc)));
        await o.hooks?.afterDelete?.(entry);
        entry.status = "DELETED";
        entry.deletedRows = deleted;
        entry.retainedRows = rows.length - deleted;
        m.cursor![p.table] = entry.lastKey;
        writeManifest(runDir, m);
        batches++;
        if (o.throttleMs) await new Promise((r) => setTimeout(r, o.throttleMs));
      }
    }
    const walBytes = await walSince(o.db, walStart);
    if (!stopReason) m.state = "COMPLETE";
    delete m.lastError;
    writeManifest(runDir, m);
    return { ok: true, runId, manifestPath: join(runDir, MANIFEST), complete: !stopReason, tables: summarise(m), walBytes, ...(stopReason ? { stopReason } : {}) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (manifest && runDir && existsSync(runDir)) {
      manifest.lastError = message;
      writeManifest(runDir, manifest);
    }
    return { ok: false, reason: "INTERRUPTED", runId: manifest?.runId, detail: message };
  } finally {
    try {
      await o.lock.release();
    } catch {
      // A lost session already released the lock; nothing to undo.
    }
  }
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
  archiveDir: string;
  runId: string;
  expectedPolicyHash: string;
  policy: readonly TableRetention[];
  chunkRows?: number;
}): Promise<RestoreResult> {
  const runDir = join(o.archiveDir, o.runId);
  if (!existsSync(join(runDir, MANIFEST))) return { ok: false, reason: "RUN_NOT_FOUND" };
  let m: ArchiveManifest;
  try {
    m = readManifest(runDir);
  } catch {
    return { ok: false, reason: "MANIFEST_UNREADABLE" };
  }
  const v = verifyManifest(m, readFileOrNull(runDir), o.expectedPolicyHash);
  if (!v.ok) return { ok: false, reason: "ARCHIVE_INVALID", detail: v.failures };
  const byTable = new Map(o.policy.map((p) => [p.table, p]));
  const parsed: { p: TableRetention; lines: string[] }[] = [];
  for (const b of m.batches) {
    const p = byTable.get(b.table);
    if (!p) return { ok: false, reason: "UNKNOWN_TABLE", detail: b.table };
    let lines: string[];
    try {
      lines = archiveLines(readFileSync(join(runDir, b.file)));
    } catch (err) {
      return { ok: false, reason: "ARCHIVE_UNREADABLE", detail: { file: b.file, error: err instanceof Error ? err.message : String(err) } };
    }
    if (lines.length !== b.rows) return { ok: false, reason: "ROW_COUNT_MISMATCH", detail: b.file };
    parsed.push({ p, lines });
  }
  const chunk = Math.max(1, Math.min(o.chunkRows ?? 1000, 5000));
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
