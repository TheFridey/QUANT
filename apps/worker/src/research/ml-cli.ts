import "../load-env.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DEFAULT_ML2_CONFIG, horizonsFor, inferBarMs, ML2_PROTOCOL_VERSION, runMlPipeline, type Ml2Report, type ResearchBar } from "@odin/backtest";
import { INTERVAL_MS, type HistoryInterval } from "@odin/market-data";
import { PrismaClient } from "@odin/shared/db";
import { costPerSide } from "./cost-basis.js";
import { programmeTrialCount } from "./holdout-policy.js";
import { ML_CLI_USAGE, parseBarsCsv, parseMlArgs } from "./ml-args.js";

/**
 * GENESIS Phase 4 ML Engine 2.0 study (research only, read only):
 *
 *   node dist/src/research/ml-cli.js <datasetId> [options]
 *   node dist/src/research/ml-cli.js --csv <path> --fee-bps N --slippage-bps N [--interval 1h] [options]
 *
 * Warehouse mode reads closed bars (availableAt <= now) of one HistoricalDataset and the programme trial count;
 * CSV mode reads a local file. Neither mode writes anything: no registry row, holdout access, engine config,
 * strategy instance, order or promotion state. Because a holdout read must be recorded and this CLI records
 * nothing, the holdout is always withheld here, so the best verdict it can print is INSUFFICIENT_EVIDENCE
 * ("walk-forward passed; holdout withheld"). Bars are passed through unrepaired; duplicates, disorder or
 * off-grid timestamps are refused by the pipeline.
 */

function compact(report: Ml2Report) {
  const r6 = (x: number | null | undefined) => (x === null || x === undefined ? null : +x.toFixed(6));
  return {
    protocol: report.protocol,
    labelsVersion: report.labelsVersion,
    target: report.target,
    labelSpec: report.labelSpec,
    labelSpecHash: report.labelSpecHash,
    featureSet: { name: report.featureSet.spec.name, version: report.featureSet.spec.version, features: report.featureSet.spec.features, nullPolicy: report.featureSet.spec.nullPolicy, hash: report.featureSet.hash },
    data: report.data,
    coverageFailures: report.coverage.filter((c) => !c.ok),
    causality: report.causality,
    folds: report.folds.map((f) => ({ fold: f.fold, train: f.trainRows, fit: f.fitRows, cal: f.calRows, purged: f.purged, embargoed: f.embargoed, innerPurged: f.innerPurged, test: f.testRows, testStartIndex: f.testStartIndex, skipped: f.skipped })),
    trialCount: report.trialCount,
    programmeTrialCount: report.programmeTrialCount,
    trials: report.trials,
    championTrialId: report.championTrialId,
    walkForward: Object.fromEntries(
      Object.entries(report.walkForward).map(([id, e]) => [
        id,
        {
          rows: e.rows,
          brier: r6(e.brier),
          logLoss: r6(e.logLoss),
          ece: r6(e.ece),
          auc: r6(e.auc),
          aucCi: e.aucCi && { lower: r6(e.aucCi.lower), upper: r6(e.aucCi.upper), blockLength: e.aucCi.blockLength, scheme: e.aucCi.scheme },
          brierSkill: r6(e.brierSkill),
          precisionTop: r6(e.precisionTop),
          precisionAtThreshold: r6(e.precisionAtThreshold),
          signals: e.signals,
          abstainedOod: e.abstainedOod,
          selectionFrequency: r6(e.selectionFrequency),
          expectancy: e.expectancy.map((x) => ({ costMultiplier: x.costMultiplier, mean: r6(x.mean), ciLower: r6(x.ci?.lower), ciUpper: r6(x.ci?.upper), alwaysEnter: r6(x.alwaysEnter), buyAndHoldPerHorizon: r6(x.buyAndHoldPerHorizon) })),
          sharpePerTrade: r6(e.sharpe),
          sortinoPerTrade: r6(e.sortino),
          buyAndHold: { net: r6(e.buyAndHold.net), bars: e.buyAndHold.bars },
          randomControl: { draws: e.randomControl.draws, mean: r6(e.randomControl.mean), p95: r6(e.randomControl.p95), pValue: r6(e.randomControl.pValue) },
        },
      ]),
    ),
    dsr: report.dsr,
    holdout: report.holdout,
    drift: { maxPsi: report.drift.psi.reduce((m, d) => Math.max(m, d.psi ?? 0), 0), psi: report.drift.psi, rollingBrier: report.drift.rollingBrier.map((b) => +b.toFixed(6)), brierDecay: r6(report.drift.brierDecay) },
    deployment: report.deployment,
    artefacts: report.artefacts,
    verdict: report.verdict,
    reasons: report.reasons,
  };
}

async function main() {
  const started = process.hrtime.bigint();
  const args = parseMlArgs(process.argv.slice(2));
  let bars: ResearchBar[];
  let barMs: number;
  let source: Record<string, unknown>;
  let feeBps: number;
  let slippageBps: number;
  let costBasis: string;
  let priorTrials: number;
  if (args.csvPath) {
    const text = readFileSync(args.csvPath, "utf8");
    bars = parseBarsCsv(text);
    if (args.interval !== null && !(args.interval in INTERVAL_MS)) throw new Error(`unknown --interval ${args.interval}`);
    barMs = args.interval ? INTERVAL_MS[args.interval as HistoryInterval] : inferBarMs(bars);
    source = { kind: "CSV", path: args.csvPath, sha256: createHash("sha256").update(text).digest("hex"), rows: bars.length };
    feeBps = args.feeBps!;
    slippageBps = args.slippageBps!;
    costBasis = "operator-supplied --fee-bps and --slippage-bps per side";
    priorTrials = args.priorTrials ?? 0;
  } else {
    const prisma = new PrismaClient();
    try {
      const dataset = await prisma.historicalDataset.findUniqueOrThrow({ where: { id: args.datasetId! } });
      const rows = await prisma.historicalBar.findMany({ where: { datasetId: dataset.id, availableAt: { lte: new Date() } }, orderBy: { openTime: "asc" } });
      bars = rows.map((row) => ({ t: row.openTime.getTime(), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: row.volume === null ? null : Number(row.volume) }));
      barMs = INTERVAL_MS[dataset.interval as HistoryInterval] ?? inferBarMs(bars);
      source = { kind: "WAREHOUSE", datasetId: dataset.id, instrument: dataset.instrumentKey, interval: dataset.interval, versionHash: dataset.versionHash, bars: bars.length };
      if (args.feeBps !== null || args.slippageBps !== null) {
        feeBps = args.feeBps ?? 0;
        slippageBps = args.slippageBps ?? 0;
        costBasis = "operator-supplied --fee-bps / --slippage-bps per side";
      } else {
        const cost = await costPerSide(prisma, dataset);
        feeBps = cost.bps;
        slippageBps = 0;
        costBasis = `ASCEND-06 combined per-side cost (fee + spread + impact): ${cost.basis}`;
      }
      priorTrials = args.priorTrials ?? (await programmeTrialCount(prisma));
    } finally {
      await prisma.$disconnect();
    }
  }
  const horizon = args.horizon ?? horizonsFor(barMs).s;
  const report = runMlPipeline({
    bars,
    barMs,
    labelSpec: { horizon, feeBpsPerSide: feeBps, slippageBpsPerSide: slippageBps, stopPct: args.stopPct, targetPct: args.targetPct },
    target: args.target,
    config: { scheme: args.scheme, calibration: args.calibration, folds: args.folds ?? DEFAULT_ML2_CONFIG.folds, seed: args.seed ?? DEFAULT_ML2_CONFIG.seed },
    priorTrialCount: priorTrials,
  });
  const runtimeMs = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(
    JSON.stringify(
      {
        mode: "READ_ONLY",
        evidence: "RESEARCH_ONLY",
        protocol: ML2_PROTOCOL_VERSION,
        codeVersion: process.env.GIT_COMMIT ?? "unknown",
        source,
        barMs,
        costBasis,
        priorTrials,
        report: compact(report),
        runtime: { ms: Math.round(runtimeMs), peakRssMb: +(process.resourceUsage().maxRSS / 1024).toFixed(1) },
        conclusion: "Research output only. No model is applied to the paper engine, and the holdout is withheld because this CLI records nothing.",
      },
      null,
      1,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(ML_CLI_USAGE);
  process.exit(1);
});
