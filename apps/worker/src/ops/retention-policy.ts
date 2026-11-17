import { createHash } from "node:crypto";

/**
 * OPERATION AURUM Workstream Zero: dependency-aware retention for the four high-growth tables.
 * **Planning and dry-run only.** Nothing here deletes or archives; the executor is blocked until it is
 * proven on a disposable database (docs/aurum/STORAGE-PLAN.md) and the operator approves the policy.
 *
 * A row is a candidate only when it is older than the hot window AND no evidence references it.
 * Evidence (orders, fills, intents, equity, watchlist, backtests) is preserved indefinitely.
 */

export const RETENTION_TABLES = ["AgentDecision", "MarketObservation", "CyclePlan", "OpportunityFunnelEvent"] as const;
export type RetentionTable = (typeof RETENTION_TABLES)[number];

export type TableRetention = {
  table: RetentionTable;
  /** Proposed hot window, days. Pending operator approval. */
  hotDays: number;
  /** Timestamp columns defining age; the row's age is GREATEST of them (upserted rows keep createdAt). */
  ageColumns: string[];
  /** When set, the dry run still estimates but any archive/delete executor must refuse this table. */
  executorBlocked?: string;
  /** Primary key column used for stable batch ordering. */
  keyColumn: string;
  /**
   * SQL predicate (alias `t`) that is TRUE when the row must be preserved. Code constants only: never
   * built from configuration or user input. Each clause names the evidence
   * that depends on the row. The planner negates the whole predicate, so a NULL-safe NOT EXISTS is used.
   */
  preserveWhen: string[];
};

/** Cycles that produced durable evidence. A cycle's decisions, plan and funnel events stay with it. */
const CYCLE_HAS_EVIDENCE = (col: string) => [
  `EXISTS (SELECT 1 FROM "Order" o WHERE o."cycleId" = ${col})`,
  `EXISTS (SELECT 1 FROM "TradeIntent" ti WHERE ti."cycleId" = ${col})`,
  `EXISTS (SELECT 1 FROM "EquitySnapshot" es WHERE es."cycleId" = ${col})`,
];

export const PROPOSED_RETENTION: readonly TableRetention[] = Object.freeze([
  {
    table: "AgentDecision",
    hotDays: 30,
    ageColumns: ["createdAt", "updatedAt"],
    keyColumn: "id",
    preserveWhen: [
      ...CYCLE_HAS_EVIDENCE(`t."cycleId"`),
      // Only explicitly routine outcomes may age out; anything else (risk refusals, signals) is kept.
      `t."decision" NOT IN ('NO_INTENT')`,
    ],
  },
  {
    table: "MarketObservation",
    hotDays: 30,
    ageColumns: ["receivedAt"],
    keyColumn: "id",
    // packages/evolution/src/pipeline.ts hashes observation windows (id:receivedAt:priceUsd) as research
    // dataset identity. Those windows are not yet mapped to a preservation rule, so archiving observations
    // could break reproducibility of preserved trials. Blocked until mapped (STORAGE-PLAN §2).
    executorBlocked: "RESEARCH_DATASET_WINDOWS_UNMAPPED",
    preserveWhen: [
      `EXISTS (SELECT 1 FROM "Order" o WHERE t."id" IN (o."observationId", o."decisionObservationId", o."fillObservationId"))`,
      `EXISTS (SELECT 1 FROM "Fill" f WHERE f."observationId" = t."id")`,
      `EXISTS (SELECT 1 FROM "TradeIntent" ti WHERE ti."observationId" = t."id")`,
      `EXISTS (SELECT 1 FROM "WatchlistEntry" w WHERE w."observationId" = t."id")`,
      `EXISTS (SELECT 1 FROM "BacktestTrade" b WHERE b."observationId" = t."id")`,
    ],
  },
  { table: "CyclePlan", hotDays: 30, ageColumns: ["plannedAt"], keyColumn: "cycleId", preserveWhen: CYCLE_HAS_EVIDENCE(`t."cycleId"`) },
  {
    table: "OpportunityFunnelEvent",
    hotDays: 90,
    ageColumns: ["createdAt"],
    keyColumn: "id",
    preserveWhen: CYCLE_HAS_EVIDENCE(`t."cycleId"`),
  },
]);

/** Tables that are never retention candidates. Any policy naming one is refused. */
export const PRESERVED_FOREVER = [
  "Order",
  "Fill",
  "Position",
  "LedgerEntry",
  "EquitySnapshot",
  "PaperAccount",
  "AccountSafetyState",
  "TradeIntent",
  "ResearchTrial",
  "ResearchTrialLedger",
  "HistoricalDataset",
] as const;

export const MIN_HOT_DAYS = 7;
export const MAX_BATCH_ROWS = 10_000;

export function validatePolicy(policy: readonly TableRetention[]): { ok: true } | { ok: false; reason: string } {
  const seen = new Set<string>();
  for (const p of policy) {
    if (!(RETENTION_TABLES as readonly string[]).includes(p.table)) return { ok: false, reason: `TABLE_NOT_RETAINABLE:${p.table}` };
    if ((PRESERVED_FOREVER as readonly string[]).includes(p.table)) return { ok: false, reason: `TABLE_PRESERVED:${p.table}` };
    if (seen.has(p.table)) return { ok: false, reason: `DUPLICATE_TABLE:${p.table}` };
    seen.add(p.table);
    if (!Number.isInteger(p.hotDays) || p.hotDays < MIN_HOT_DAYS) return { ok: false, reason: `HOT_WINDOW_TOO_SHORT:${p.table}` };
    if (p.ageColumns.length === 0 || !p.ageColumns.every((c) => /^[A-Za-z]+$/.test(c)) || !/^[A-Za-z]+$/.test(p.keyColumn)) {
      return { ok: false, reason: `BAD_COLUMN:${p.table}` };
    }
    if (p.preserveWhen.length === 0) return { ok: false, reason: `NO_DEPENDENCY_RULES:${p.table}` };
  }
  return { ok: true };
}

/** Policies an archive/delete executor may act on: valid and not blocked. */
export function executablePolicies(policy: readonly TableRetention[]): TableRetention[] {
  if (!validatePolicy(policy).ok) return [];
  return policy.filter((p) => !p.executorBlocked);
}

function ageExpr(policy: TableRetention): string {
  const cols = policy.ageColumns.map((c) => `t."${c}"`);
  return cols.length === 1 ? cols[0]! : `GREATEST(${cols.join(", ")})`;
}

export function cutoffFor(policy: TableRetention, now: Date): Date {
  if (!Number.isFinite(now.getTime())) throw new Error("INVALID_NOW");
  return new Date(now.getTime() - policy.hotDays * 86_400_000);
}

/** WHERE clause selecting archive candidates: older than `$1` and not preserved by any dependency. */
export function candidateWhere(policy: TableRetention): string {
  const preserve = policy.preserveWhen.map((c) => `(${c})`).join(" OR ");
  return `${ageExpr(policy)} < $1 AND NOT (${preserve})`;
}

/** Read-only estimate SQL: total rows, aged rows, candidate rows and relation size. Parameter $1 = cutoff. */
export function dryRunSql(policy: TableRetention): string {
  const table = `"${policy.table}"`;
  return [
    `SELECT`,
    `  (SELECT count(*) FROM ${table}) AS total_rows,`,
    `  (SELECT count(*) FROM ${table} t WHERE ${ageExpr(policy)} < $1) AS aged_rows,`,
    `  (SELECT count(*) FROM ${table} t WHERE ${candidateWhere(policy)}) AS candidate_rows,`,
    `  pg_total_relation_size('${table}') AS total_bytes,`,
    `  (SELECT min(${ageExpr(policy)}) FROM ${table} t) AS oldest`,
  ].join("\n");
}

/** Keyset-paginated batch selection SQL ($1 cutoff, $2 last key or '', $3 limit). Stable and restart-safe. */
export function batchSelectSql(policy: TableRetention): string {
  return [
    `SELECT t."${policy.keyColumn}" AS key FROM "${policy.table}" t`,
    `WHERE ${candidateWhere(policy)} AND t."${policy.keyColumn}" > $2`,
    `ORDER BY t."${policy.keyColumn}" ASC LIMIT $3`,
  ].join("\n");
}

export function clampBatch(rows: number): number {
  if (!Number.isInteger(rows) || rows <= 0) throw new Error("INVALID_BATCH");
  return Math.min(rows, MAX_BATCH_ROWS);
}

export type ArchiveBatchEntry = {
  table: RetentionTable;
  seq: number;
  firstKey: string;
  lastKey: string;
  rows: number;
  file: string;
  sha256: string;
  bytes: number;
};

export type ArchiveManifest = {
  version: "aurum-retention-1";
  createdAt: string;
  policyHash: string;
  cutoffs: Record<string, string>;
  batches: ArchiveBatchEntry[];
};

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Stable hash of a policy so a manifest records exactly which rules selected its rows. */
export function policyHash(policy: readonly TableRetention[]): string {
  const canonical = policy.map((p) => ({ ...p, preserveWhen: [...p.preserveWhen] })).sort((a, b) => a.table.localeCompare(b.table));
  return sha256(JSON.stringify(canonical));
}

/**
 * Verifies every batch file against its recorded hash and size before anything may be deleted, and
 * again after restore. `read` returns the file bytes or null when missing.
 */
export type ManifestFailure = "MISSING" | "SIZE_MISMATCH" | "HASH_MISMATCH" | "DUPLICATE_BATCH" | "POLICY_MISMATCH";

export function verifyManifest(
  manifest: ArchiveManifest,
  read: (file: string) => Buffer | null,
  expectedPolicyHash?: string,
): { ok: true; rows: number } | { ok: false; failures: { file: string; reason: ManifestFailure }[] } {
  const failures: { file: string; reason: ManifestFailure }[] = [];
  if (expectedPolicyHash !== undefined && manifest.policyHash !== expectedPolicyHash) {
    failures.push({ file: "(manifest)", reason: "POLICY_MISMATCH" });
  }
  let rows = 0;
  const seqs = new Set<string>();
  for (const b of manifest.batches) {
    const key = `${b.table}:${b.seq}`;
    if (seqs.has(key)) failures.push({ file: b.file, reason: "DUPLICATE_BATCH" });
    seqs.add(key);
    const data = read(b.file);
    if (data === null) {
      failures.push({ file: b.file, reason: "MISSING" });
      continue;
    }
    if (data.byteLength !== b.bytes) failures.push({ file: b.file, reason: "SIZE_MISMATCH" });
    else if (sha256(data) !== b.sha256) failures.push({ file: b.file, reason: "HASH_MISMATCH" });
    rows += b.rows;
  }
  return failures.length === 0 ? { ok: true, rows } : { ok: false, failures };
}

export type DiskPressure = "OK" | "WARN" | "CRITICAL";

/**
 * Disk-pressure classification. Archival needs headroom for the archive files and WAL; under CRITICAL
 * the executor must refuse to start (a DELETE does not return space to the OS until VACUUM FULL/repack).
 */
export function diskPressure(input: { freeBytes: number; totalBytes: number; dailyGrowthBytes: number }): {
  level: DiskPressure;
  daysToFull: number | null;
} {
  const { freeBytes, totalBytes, dailyGrowthBytes } = input;
  if (![freeBytes, totalBytes, dailyGrowthBytes].every(Number.isFinite) || totalBytes <= 0 || freeBytes < 0) {
    return { level: "CRITICAL", daysToFull: null };
  }
  const daysToFull = dailyGrowthBytes > 0 ? freeBytes / dailyGrowthBytes : null;
  const freeFraction = freeBytes / totalBytes;
  if (freeFraction < 0.1 || (daysToFull !== null && daysToFull < 14)) return { level: "CRITICAL", daysToFull };
  if (freeFraction < 0.2 || (daysToFull !== null && daysToFull < 45)) return { level: "WARN", daysToFull };
  return { level: "OK", daysToFull };
}

/** Postgres advisory lock key for the retention job (single runner across workers). */
export const RETENTION_ADVISORY_LOCK_KEY = 0x41555255; // "AURU"
