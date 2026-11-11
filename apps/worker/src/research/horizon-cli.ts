import "../load-env.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { excludeWeekendStubBars, inferBarMs, MARKET_CONFIGS, runHorizonStudy, type MarketResearchConfig, type ResearchBar } from "@odin/backtest";
import { INTERVAL_MS, type HistoryInterval } from "@odin/market-data";
import { PrismaClient } from "@odin/shared/db";
import { declareLegacyTrials } from "@odin/evolution/campaign";
import { programmeTrialCount } from "./holdout-policy.js";
import { HORIZON_CLI_USAGE, parseHorizonArgs } from "./horizon-args.js";
import { parseBarsCsv } from "./ml-args.js";

/**
 * OPERATION HORIZON per-market study (research only, read only):
 *
 *   node dist/src/research/horizon-cli.js <datasetId> --market FX [options]
 *   node dist/src/research/horizon-cli.js --csv <path> --market FX --instrument USD/JPY --prior-trials N [--interval 1h] [options]
 *
 * Runs the market's HORIZON strategy grid through the ASCEND-03 walk-forward validator and a GENESIS ML 2.0 run
 * with the market's labels and costs, against buy-and-hold, cash and random-selection controls, deflated by the
 * programme-wide trial count. Warehouse mode reads closed bars (availableAt <= now) of one HistoricalDataset and
 * the programme trial count; CSV mode reads a local file (an `available_at` column is honoured). Neither mode
 * stores the study, a holdout access, engine config, a strategy instance, an order or promotion state. Warehouse
 * mode appends one row to the programme trial ledger (the number of trials it ran), so later studies are
 * deflated by them; CSV mode cannot and says so.
 * Because a holdout read must be recorded and this CLI records nothing, every holdout is withheld; the best
 * verdict it can print is CANDIDATE_PENDING_HOLDOUT.
 */

const MAX_WAREHOUSE_BARS = 200_000;

function withCostOverrides(base: MarketResearchConfig, o: { feeBps: number | null; spread: number | null; slippage: number | null }): MarketResearchConfig {
  if (o.feeBps === null && o.spread === null && o.slippage === null) return base;
  return {
    ...base,
    cost: {
      ...base.cost,
      feeBpsPerSide: o.feeBps ?? base.cost.feeBpsPerSide,
      spreadFull: o.spread ?? base.cost.spreadFull,
      slippagePerSide: o.slippage ?? base.cost.slippagePerSide,
      assumptions: [...base.cost.assumptions, `Operator override: fee ${o.feeBps ?? "default"} bps/side, spread ${o.spread ?? "default"}, slippage ${o.slippage ?? "default"} (${base.cost.unit})`],
    },
  };
}

async function main() {
  const started = process.hrtime.bigint();
  const args = parseHorizonArgs(process.argv.slice(2));
  const market = withCostOverrides(MARKET_CONFIGS[args.market], args);
  let bars: ResearchBar[];
  let barAvailableAt: number[] | undefined;
  let barMs: number;
  let instrument: string;
  let datasetKey: string;
  let priorTrials: number;
  let source: Record<string, unknown>;
  let tickVolumes: Array<number | null> | undefined;
  if (args.csvPath) {
    const text = readFileSync(args.csvPath, "utf8");
    const parsed = parseBarsCsv(text);
    const now = Date.now();
    const usable = parsed.filter((b) => b.availableAt === null || b.availableAt <= now);
    bars = usable.map(({ t, open, high, low, close, volume }) => ({ t, open, high, low, close, volume }));
    const hasAvailability = usable.length > 0 && usable.every((b) => b.availableAt !== null);
    barAvailableAt = hasAvailability ? usable.map((b) => b.availableAt!) : undefined;
    if (args.interval !== null && !(args.interval in INTERVAL_MS)) throw new Error(`unknown --interval ${args.interval}`);
    barMs = args.interval ? INTERVAL_MS[args.interval as HistoryInterval] : inferBarMs(bars);
    instrument = args.instrument!;
    const sha = createHash("sha256").update(text).digest("hex");
    datasetKey = `csv:${instrument}|${barMs}`;
    priorTrials = args.priorTrials!;
    source = { kind: "CSV", path: args.csvPath, sha256: sha, rows: parsed.length, notYetAvailable: parsed.length - usable.length, availability: hasAvailability ? "available_at column" : "bar close (open + interval)" };
  } else {
    const prisma = new PrismaClient();
    try {
      const dataset = await prisma.historicalDataset.findUniqueOrThrow({ where: { id: args.datasetId! } });
      const rows = await prisma.historicalBar.findMany({ where: { datasetId: dataset.id, availableAt: { lte: new Date() } }, orderBy: { openTime: "asc" }, take: MAX_WAREHOUSE_BARS + 1 });
      if (rows.length > MAX_WAREHOUSE_BARS) throw new Error(`REFUSED: dataset ${dataset.id} has more than ${MAX_WAREHOUSE_BARS} available bars; this CLI reads at most ${MAX_WAREHOUSE_BARS}`);
      bars = rows.map((row) => ({ t: row.openTime.getTime(), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: row.volume === null ? null : Number(row.volume) }));
      barAvailableAt = rows.map((row) => row.availableAt.getTime());
      tickVolumes = rows.map((row) => {
        const extra = row.extra && typeof row.extra === "object" && !Array.isArray(row.extra) ? (row.extra as Record<string, unknown>) : null;
        const ticks = extra ? Number(extra.tickVolume) : NaN;
        return Number.isFinite(ticks) ? ticks : null;
      });
      barMs = INTERVAL_MS[dataset.interval as HistoryInterval] ?? inferBarMs(bars);
      instrument = args.instrument ?? dataset.instrumentKey;
      datasetKey = `${dataset.instrumentKey}|${dataset.interval}`;
      priorTrials = args.priorTrials ?? (await programmeTrialCount(prisma));
      source = { kind: "WAREHOUSE", datasetId: dataset.id, instrument: dataset.instrumentKey, instrumentKind: dataset.instrumentKind, interval: dataset.interval, versionHash: dataset.versionHash, bars: bars.length };
    } finally {
      await prisma.$disconnect();
    }
  }
  const warehouse = !args.csvPath;
  // FX/metals providers occasionally print a one-to-few-tick bar after the Friday close; exclude and report it.
  const stubs = excludeWeekendStubBars(bars, { barMs, calendar: market.calendar, tickVolumes, availableAt: barAvailableAt });
  bars = stubs.bars;
  barAvailableAt = stubs.availableAt;
  source = { ...source, excludedWeekendStubs: { count: stubs.excluded.length, bars: stubs.excluded.slice(0, 50).map((e) => ({ t: new Date(e.t).toISOString(), reason: e.reason })) } };
  const report = runHorizonStudy({
    bars,
    barMs,
    barAvailableAt,
    market,
    instrument,
    datasetKey,
    codeVersion: process.env.GIT_COMMIT ?? "unknown",
    priorTrials,
    // No holdout gate: this CLI cannot record a holdout read, so every holdout is withheld.
    ml: { enabled: args.ml, horizons: args.mlHorizons, config: args.seed !== null ? { seed: args.seed } : undefined },
    validation: { ...(args.folds !== null ? { folds: args.folds } : {}), ...(args.seed !== null ? { seed: args.seed } : {}) },
    strategies: args.strategies ?? undefined,
  });
  // Every trial this study ran is a look at the data, so it joins the programme count (warehouse mode: the
  // database is there). The study itself is still not stored: use a campaign for evidence that must be kept.
  let trialsRecorded: number | string = "NOT_RECORDED: CSV mode has no database; pass the true --prior-trials next time, or use a campaign";
  if (warehouse && report.programme.runTrials > 0) {
    const prisma = new PrismaClient();
    try {
      await declareLegacyTrials(prisma, { trials: report.programme.runTrials, actor: "horizon-cli", note: `horizon-cli ${args.datasetId} ${args.market} at ${process.env.GIT_COMMIT ?? "unknown"}: ${report.verdict}` });
      trialsRecorded = report.programme.runTrials;
    } finally {
      await prisma.$disconnect();
    }
  }
  const runtimeMs = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(
    JSON.stringify(
      {
        mode: "READ_ONLY",
        evidence: "RESEARCH_ONLY",
        source,
        trialsRecorded,
        report,
        runtime: { ms: Math.round(runtimeMs), peakRssMb: +(process.resourceUsage().maxRSS / 1024).toFixed(1) },
        conclusion: "Research output only. Nothing is applied to the paper engine, DEFAULT_STRATEGY or any strategy instance, and every holdout is withheld because this CLI records nothing.",
      },
      null,
      1,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(HORIZON_CLI_USAGE);
  process.exit(1);
});
