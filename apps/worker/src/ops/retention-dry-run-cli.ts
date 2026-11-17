import "../load-env.js";
import { PrismaClient } from "@odin/shared/db";
import { PROPOSED_RETENTION, cutoffFor, dryRunSql, policyHash, validatePolicy } from "./retention-policy.js";

/**
 * AURUM Workstream Zero retention estimate. **Read-only**: runs inside a READ ONLY transaction, SELECTs only.
 *
 *   node dist/src/ops/retention-dry-run-cli.js [--now <ISO>]
 *
 * Prints, per table: total rows, rows past the proposed hot window, rows that would be archive
 * candidates after dependency preservation, relation size and oldest row. Deletes nothing.
 * Candidate counts use correlated NOT EXISTS over evidence tables and can be slow on large tables;
 * run off-peak. statement_timeout bounds each query.
 */

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf("--now");
  const now = i >= 0 ? new Date(args[i + 1] ?? "") : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("bad --now");
  const valid = validatePolicy(PROPOSED_RETENTION);
  if (!valid.ok) throw new Error(valid.reason);

  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '300s'");
        const out: Record<string, unknown>[] = [];
        for (const policy of PROPOSED_RETENTION) {
          const cutoff = cutoffFor(policy, now);
          const [r] = await tx.$queryRawUnsafe<Record<string, unknown>[]>(dryRunSql(policy), cutoff);
          out.push({ table: policy.table, hotDays: policy.hotDays, cutoff: cutoff.toISOString(), ...r });
        }
        return out;
      },
      { timeout: 1_500_000, maxWait: 10_000 },
    );
    const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
    console.log(JSON.stringify({ mode: "DRY_RUN", now: now.toISOString(), policyHash: policyHash(PROPOSED_RETENTION), tables: rows }, replacer, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
