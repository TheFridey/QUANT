import "../load-env.js";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { OpportunityManifestBuilder, opportunityCsvHeader, opportunityRowToCsv } from "@odin/backtest";
import { PrismaClient } from "@odin/shared/db";
import { iterateOpportunityBatches } from "./opportunity-loader.js";

/**
 * GENESIS Phase 3 Opportunity History export, read-only against the database (SELECTs only):
 *
 *   node dist/src/history/opportunity-history-cli.js --from <ISO> --to <ISO>
 *        [--window-hours 6] [--account <accountId>] [--format jsonl|csv] [--out <dir>]
 *        [--counterfactual] [--horizons 1h,4h,24h] [--pause-ms 200] [--max-cycle-span-ms 600000]
 *
 * Walks [from, to) in windows of CycleRun.startedAt, writes one point-in-time row per (cycle, pair) and a
 * manifest (row count, time range, content hash, query bounds). Counterfactual forward outcomes, when asked
 * for, are labelled HYPOTHETICAL. Output goes to local files only.
 */

const HOUR = 3_600_000;
const MAX_SPAN_DAYS = 366;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function parseHorizon(text: string): number {
  const m = /^(\d+)(m|h|d)$/.exec(text.trim());
  if (!m) throw new Error(`bad horizon ${text}; use e.g. 15m, 4h, 1d`);
  return Number(m[1]) * (m[2] === "m" ? 60_000 : m[2] === "h" ? HOUR : 24 * HOUR);
}

const compact = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

async function main() {
  const args = process.argv.slice(2);
  const fromText = flag(args, "--from");
  const toText = flag(args, "--to");
  if (!fromText || !toText) {
    console.error("usage: opportunity-history-cli --from <ISO> --to <ISO> [--window-hours 6] [--account id] [--format jsonl|csv] [--out dir] [--counterfactual] [--horizons 1h,4h,24h] [--pause-ms 200]");
    process.exit(2);
  }
  const from = new Date(fromText);
  const to = new Date(toText);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from) throw new Error("--from/--to must be ISO timestamps with from < to");
  if (to.getTime() - from.getTime() > MAX_SPAN_DAYS * 24 * HOUR) throw new Error(`span is limited to ${MAX_SPAN_DAYS} days per export`);
  const windowHours = Math.min(Math.max(Number(flag(args, "--window-hours") ?? 6) || 6, 1), 24);
  const accountId = flag(args, "--account") ?? null;
  const format = flag(args, "--format") ?? "jsonl";
  if (format !== "jsonl" && format !== "csv") throw new Error("--format must be jsonl or csv");
  const outDir = resolve(flag(args, "--out") ?? "opportunity-history");
  const pauseMs = Math.min(Math.max(Number(flag(args, "--pause-ms") ?? 200) || 0, 0), 10_000);
  const maxCycleSpanMs = Math.min(Math.max(Number(flag(args, "--max-cycle-span-ms") ?? 600_000) || 600_000, 1_000), HOUR);
  const horizonsMs = args.includes("--counterfactual") ? (flag(args, "--horizons") ?? "1h,4h,24h").split(",").map(parseHorizon) : null;

  mkdirSync(outDir, { recursive: true });
  const base = join(outDir, `opportunity-history_${compact(from)}_${compact(to)}`);
  const dataPath = `${base}.${format}`;
  const stream = createWriteStream(dataPath, { encoding: "utf8" });
  if (format === "csv") stream.write(`${opportunityCsvHeader()}\n`);
  const manifest = new OpportunityManifestBuilder();
  const prisma = new PrismaClient();
  let stop = false;
  process.on("SIGTERM", () => (stop = true));
  process.on("SIGINT", () => (stop = true));
  let windows = 0;
  try {
    for (let start = from.getTime(); start < to.getTime() && !stop; start += windowHours * HOUR) {
      const end = Math.min(start + windowHours * HOUR, to.getTime());
      // Each batch is written and dropped before the next is read, so memory does not grow with the window.
      for await (const rows of iterateOpportunityBatches(prisma, { from: new Date(start), to: new Date(end), accountId, maxCycleSpanMs, counterfactualHorizonsMs: horizonsMs })) {
        for (const row of rows) {
          manifest.add(row);
          const line = `${format === "csv" ? opportunityRowToCsv(row) : JSON.stringify(row)}\n`;
          if (!stream.write(line)) await new Promise<void>((r) => stream.once("drain", () => r()));
        }
        if (stop) break;
      }
      windows += 1;
      if (pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
    }
  } finally {
    await prisma.$disconnect();
    await new Promise<void>((r) => stream.end(r));
  }
  if (stop) throw new Error(`interrupted after ${windows} windows; ${dataPath} is partial and has no manifest`);
  const result = {
    ...manifest.finish({
      queryBounds: {
        from: from.toISOString(),
        to: to.toISOString(),
        cycleSelection: "CycleRun.startedAt in [from, to)",
        windowHours,
        windows,
        accountId,
        maxCycleSpanMs,
        tables: ["CycleRun", "OpportunityFunnelEvent", "AgentDecision", "TradeIntent", ...(horizonsMs ? ["HistoricalDataset", "HistoricalBar"] : [])],
      },
      counterfactualHorizonsMs: horizonsMs,
      format,
    }),
    dataFile: dataPath,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(`${base}.manifest.json`, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ dataFile: dataPath, manifest: `${base}.manifest.json`, rowCount: result.rowCount, contentHash: result.contentHash }));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
