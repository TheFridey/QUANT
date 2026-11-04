import "../load-env.js";
import { datasetQuality, listDatasetsForQuality } from "@odin/market-data";
import { PrismaClient } from "@odin/shared/db";

/**
 * GENESIS Phase 3 dataset quality report, read-only (SELECTs only; writes nothing):
 *
 *   node dist/src/history/quality-cli.js --list
 *   node dist/src/history/quality-cli.js <datasetId> [--from <ISO>] [--to <ISO>] [--max-listed <n>]
 *   node dist/src/history/quality-cli.js --all [--max-listed <n>]
 *
 * Prints JSON: coverage vs the asset-class calendar, classified gaps, duplicates, revisions, rejections,
 * stale / zero-volume runs, OHLC violations, the deterministic content hash and survivorship flags.
 * `--all` reads datasets one at a time to keep memory and database load bounded.
 */

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function isoMs(text: string | undefined, name: string): number | undefined {
  if (text === undefined) return undefined;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) throw new Error(`${name} must be an ISO timestamp`);
  return ms;
}

async function main() {
  const args = process.argv.slice(2);
  const target = args[0];
  if (!target) {
    console.error("usage: quality-cli <datasetId|--all|--list> [--from ISO] [--to ISO] [--max-listed n]");
    process.exit(2);
  }
  const from = isoMs(flag(args, "--from"), "--from");
  const to = isoMs(flag(args, "--to"), "--to");
  if ((from === undefined) !== (to === undefined)) throw new Error("--from and --to go together");
  const maxListed = Math.min(Math.max(Number(flag(args, "--max-listed") ?? 50) || 50, 0), 1_000);
  const options = { maxListed, ...(from !== undefined && to !== undefined ? { window: { fromOpenTime: from, toOpenTime: to } } : {}) };
  const prisma = new PrismaClient();
  const asOf = new Date();
  try {
    if (target === "--list") {
      console.log(JSON.stringify(await listDatasetsForQuality(prisma, asOf), null, 2));
      return;
    }
    if (target === "--all") {
      const listing = await listDatasetsForQuality(prisma, asOf);
      const reports = [];
      for (const dataset of listing.datasets) reports.push(await datasetQuality(prisma, dataset.id, asOf, options));
      console.log(JSON.stringify({ asOf: asOf.toISOString(), survivorship: listing.survivorship, reports }, null, 2));
      return;
    }
    const report = await datasetQuality(prisma, target, asOf, options);
    if (!report) {
      console.error(`dataset ${target} not found`);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
