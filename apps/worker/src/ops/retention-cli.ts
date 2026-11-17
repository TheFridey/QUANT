import { PrismaClient } from "@odin/shared/db";
import { existsSync } from "node:fs";
import { PROPOSED_RETENTION, cutoffFor, diskPressure, executablePolicies, policyHash, verifyManifest } from "./retention-policy.js";
import { defaultStatfs, estimate, executeRetention, restoreRetentionRun, readArchiveManifest, readArchiveFiles } from "./retention-executor.js";
import { prismaRetentionDb, prismaRetentionLock } from "./retention-prisma.js";
import { assertDisposableRetentionTarget, confinedArchivePath } from "./retention-boundary.js";

/**
 * AURUM retention executor CLI (docs/aurum/STORAGE-PLAN.md §3).
 *
 *   plan    [--archive-dir D] [--growth-gb-day N]        read-only: estimate, disk requirement, policy hash
 *   verify  --archive-dir D --run R --policy-hash H       checks a run's manifest and every file
 *   execute --archive-dir D --policy-hash H --backup F    archive, then delete (refused unless the policy
 *           [--resume R] [--max-batches N] [--batch-rows N] [--max-wal-gb N] [--wal-headroom-gb N]
 *                                                        hash is in APPROVED_RETENTION_POLICY_HASHES)
 *   restore --archive-dir D --run R --policy-hash H       re-inserts a run and checks every row
 *
 * `execute` against production needs explicit operator approval of the policy (D1) and of the run.
 */

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function num(args: string[], name: string, fallback: number): number {
  const v = arg(args, name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`bad ${name}`);
  return n;
}

function required(args: string[], name: string): string {
  const v = arg(args, name);
  if (!v) throw new Error(`${name} is required`);
  return v;
}

const GB = 1024 ** 3;
const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

async function main() {
  const [cmd = "plan", ...args] = process.argv.slice(2);
  const allowed: Record<string, string[]> = {
    plan: ['--archive-dir', '--growth-gb-day', '--wal-headroom-gb'],
    verify: ['--archive-dir', '--run', '--policy-hash'],
    execute: ['--archive-dir', '--policy-hash', '--backup', '--resume', '--max-batches', '--batch-rows', '--max-wal-gb', '--wal-headroom-gb', '--growth-gb-day', '--backup-max-age-h', '--throttle-ms'],
    restore: ['--archive-dir', '--run', '--policy-hash'],
  };
  if (!Object.hasOwn(allowed, cmd)) throw new Error('UNKNOWN_RETENTION_COMMAND');
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!;
    if (!allowed[cmd]!.includes(flag) || seen.has(flag) || !args[i + 1] || args[i + 1]!.startsWith('--')) throw new Error('INVALID_RETENTION_ARGUMENTS');
    seen.add(flag);
  }
  const now = new Date();
  const hash = policyHash(PROPOSED_RETENTION);

  if (cmd === "verify") {
    const runDir = confinedArchivePath(required(args, "--archive-dir"), required(args, "--run"));
    const m = readArchiveManifest(runDir, required(args, '--run'));
    const r = verifyManifest(m, readArchiveFiles(runDir), required(args, "--policy-hash"));
    console.log(JSON.stringify({ mode: "VERIFY", state: m.state, ...r }, null, 2));
    process.exitCode = r.ok ? 0 : 2;
    return;
  }

  const url = assertDisposableRetentionTarget(process.env.DATABASE_URL);
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    const db = prismaRetentionDb(prisma);
    if (cmd === "plan") {
      const policies = executablePolicies(PROPOSED_RETENTION);
      const cutoffs = Object.fromEntries(policies.map((p) => [p.table, cutoffFor(p, now)]));
      const est = await prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
          await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '300s'");
          return estimate({ query: <T>(sql: string, ...p: unknown[]) => tx.$queryRawUnsafe<T[]>(sql, ...p) }, policies, cutoffs);
        },
        { timeout: 1_500_000, maxWait: 10_000 },
      );
      const dir = arg(args, "--archive-dir");
      const disk = dir && existsSync(dir) ? defaultStatfs(dir) : null;
      const headroom = num(args, "--wal-headroom-gb", 2) * GB;
      console.log(
        JSON.stringify(
          {
            mode: "PLAN_READ_ONLY",
            now: now.toISOString(),
            policyHash: hash,
            policyCandidateTables: policies.map((p) => p.table),
            deletionEnabled: false,
            deletionBlockers: ['POLICY_NOT_APPROVED', 'DURABLE_AUDIT_REQUIRED'],
            blockedTables: PROPOSED_RETENTION.filter((p) => p.executorBlocked).map((p) => ({ table: p.table, reason: p.executorBlocked })),
            estimate: est,
            requiredFreeBytes: 2 * est.totalBytes + headroom,
            disk: disk ? { ...disk, pressure: diskPressure({ ...disk, dailyGrowthBytes: num(args, "--growth-gb-day", 0.75) * GB }) } : "not checked (pass --archive-dir)",
          },
          replacer,
          2,
        ),
      );
      return;
    }
    if (cmd === "execute") {
      const result = await executeRetention({
        db,
        lock: prismaRetentionLock(url, prisma),
        policy: PROPOSED_RETENTION,
        expectedPolicyHash: required(args, "--policy-hash"),
        archiveDir: required(args, "--archive-dir"),
        now,
        batchRows: num(args, "--batch-rows", 5000),
        maxBatches: num(args, "--max-batches", 20),
        maxWalBytes: num(args, "--max-wal-gb", 4) * GB,
        walHeadroomBytes: num(args, "--wal-headroom-gb", 2) * GB,
        dailyGrowthBytes: num(args, "--growth-gb-day", 0.75) * GB,
        backup: { path: required(args, "--backup"), maxAgeHours: num(args, "--backup-max-age-h", 26) },
        throttleMs: num(args, "--throttle-ms", 250),
        ...(arg(args, "--resume") ? { resumeRunId: arg(args, "--resume")! } : {}),
      });
      console.log(JSON.stringify(result, replacer, 2));
      process.exitCode = result.ok ? 0 : 2;
      return;
    }
    if (cmd === "restore") {
      const result = await restoreRetentionRun({
        db,
        disposableDatabaseUrl: url,
        archiveDir: required(args, "--archive-dir"),
        runId: required(args, "--run"),
        expectedPolicyHash: required(args, "--policy-hash"),
        policy: PROPOSED_RETENTION,
      });
      console.log(JSON.stringify(result, replacer, 2));
      process.exitCode = result.ok ? 0 : 2;
      return;
    }
    throw new Error(`unknown command ${cmd}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
