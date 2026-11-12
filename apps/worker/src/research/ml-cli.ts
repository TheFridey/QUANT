import "../load-env.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DEFAULT_ML2_CONFIG, horizonsFor, inferBarMs, ML2_PROTOCOL_VERSION, runMlPipeline, type Ml2Report, type ResearchBar, type SessionCalendar } from "@odin/backtest";
import { INTERVAL_MS, type HistoryInterval } from "@odin/market-data";
import { PrismaClient } from "@odin/shared/db";
import { costPerSide } from "./cost-basis.js";
import { closeStudy, openStudy } from "@odin/evolution/campaign";
import { EXPLORATORY_EVIDENCE_CLASS, resolvePriorTrials, studyKey } from "./holdout-policy.js";
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
 *
 * `--calendar CRYPTO_24_7|US_EQUITY` sets bar alignment and label-gap rules. Warehouse mode defaults to
 * US_EQUITY for an EQUITY_ETF dataset (daily bars open at New York midnight; weekends and NYSE holidays are not
 * gaps) and CRYPTO_24_7 otherwise; CSV mode has no instrument kind and defaults to CRYPTO_24_7, so pass
 * `--calendar US_EQUITY` for an equity export. A CSV `available_at` column is honoured: bars not yet available
 * are dropped (as in the warehouse read) and each bar's availability feeds the pipeline's causality check.
 */

/** Upper bound on bars read from the warehouse (matches the dataset quota). */
const MAX_WAREHOUSE_BARS = 200_000;

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
  let calendar: SessionCalendar;
  let barAvailableAt: number[] | undefined;
  let study: { key: string; status: string; priorTrials: number } | null = null;
  if (args.csvPath) {
    const text = readFileSync(args.csvPath, "utf8");
    const parsed = parseBarsCsv(text);
    // Same rule as the warehouse read: a bar not yet available now is not used (only when the CSV says when).
    const now = Date.now();
    const usable = parsed.filter((b) => b.availableAt === null || b.availableAt <= now);
    bars = usable.map(({ t, open, high, low, close, volume }) => ({ t, open, high, low, close, volume }));
    const hasAvailability = usable.length > 0 && usable.every((b) => b.availableAt !== null);
    barAvailableAt = hasAvailability ? usable.map((b) => b.availableAt!) : undefined;
    if (args.interval !== null && !(args.interval in INTERVAL_MS)) throw new Error(`unknown --interval ${args.interval}`);
    barMs = args.interval ? INTERVAL_MS[args.interval as HistoryInterval] : inferBarMs(bars);
    calendar = args.calendar ?? "CRYPTO_24_7";
    source = { kind: "CSV", path: args.csvPath, sha256: createHash("sha256").update(text).digest("hex"), rows: parsed.length, notYetAvailable: parsed.length - usable.length, availability: hasAvailability ? "available_at column" : "bar close (open + interval)" };
    feeBps = args.feeBps!;
    slippageBps = args.slippageBps!;
    costBasis = "operator-supplied --fee-bps and --slippage-bps per side";
    priorTrials = args.priorTrials ?? 0;
  } else {
    const prisma = new PrismaClient();
    try {
      const dataset = await prisma.historicalDataset.findUniqueOrThrow({ where: { id: args.datasetId! } });
      // Bounded read: one more than the quota, so an oversized dataset is refused rather than silently truncated.
      const rows = await prisma.historicalBar.findMany({ where: { datasetId: dataset.id, availableAt: { lte: new Date() } }, orderBy: { openTime: "asc" }, take: MAX_WAREHOUSE_BARS + 1 });
      if (rows.length > MAX_WAREHOUSE_BARS) throw new Error(`REFUSED: dataset ${dataset.id} has more than ${MAX_WAREHOUSE_BARS} available bars; this CLI reads at most ${MAX_WAREHOUSE_BARS}`);
      bars = rows.map((row) => ({ t: row.openTime.getTime(), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: row.volume === null ? null : Number(row.volume) }));
      barAvailableAt = rows.map((row) => row.availableAt.getTime());
      barMs = INTERVAL_MS[dataset.interval as HistoryInterval] ?? inferBarMs(bars);
      calendar = args.calendar ?? (dataset.instrumentKind === "EQUITY_ETF" ? "US_EQUITY" : "CRYPTO_24_7");
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
      // F03: open the study durably before computing; its programme count is frozen there (retries reuse it).
      // F06: a supplied --prior-trials can raise, never lower, the durable programme count.
      const key = studyKey({ cli: "ml-cli", datasetId: dataset.id, versionHash: dataset.versionHash, codeVersion: process.env.GIT_COMMIT ?? "unknown", args, feeBps, slippageBps });
      const opened = await openStudy(prisma, { studyKey: key, actor: "ml-cli", note: `ml-cli ${dataset.id} at ${process.env.GIT_COMMIT ?? "unknown"}` });
      study = { key, status: opened.status, priorTrials: opened.priorTrials };
      priorTrials = resolvePriorTrials(args.priorTrials, opened.priorTrials).priorTrials;
    } finally {
      await prisma.$disconnect();
    }
  }
  const horizon = args.horizon ?? horizonsFor(barMs).s;
  const report = runMlPipeline({
    bars,
    barMs,
    calendar,
    barAvailableAt,
    labelSpec: { horizon, feeBpsPerSide: feeBps, slippageBpsPerSide: slippageBps, stopPct: args.stopPct, targetPct: args.targetPct },
    target: args.target,
    config: { scheme: args.scheme, calibration: args.calibration, folds: args.folds ?? DEFAULT_ML2_CONFIG.folds, seed: args.seed ?? DEFAULT_ML2_CONFIG.seed, prefixProbes: args.prefixProbes ?? DEFAULT_ML2_CONFIG.prefixProbes },
    priorTrialCount: priorTrials,
  });
  // F03: close before disclose. The trials join the programme count before anything is printed; if the close
  // cannot be committed this throws and no result is shown.
  let trialsRecorded: Record<string, unknown> | string = "NOT_RECORDED: CSV mode has no database";
  if (!args.csvPath && study) {
    const prisma = new PrismaClient();
    try {
      const closed = await closeStudy(prisma, { studyKey: study.key, trials: report.trialCount, actor: "ml-cli", note: `ml-cli ${args.datasetId} horizon ${horizon}: ${report.verdict}` });
      trialsRecorded = { studyKey: study.key, opened: study.status, closed: closed.status, trials: closed.trials, priorTrialsFrozen: study.priorTrials, concurrentTrials: closed.concurrentTrials, priorStale: closed.concurrentTrials > 0 };
    } finally {
      await prisma.$disconnect();
    }
  }
  const runtimeMs = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(
    JSON.stringify(
      {
        mode: !args.csvPath ? "STUDY_NOT_STORED_TRIALS_COUNTED" : "READ_ONLY",
        evidence: "RESEARCH_ONLY",
        evidenceClass: EXPLORATORY_EVIDENCE_CLASS,
        protocol: ML2_PROTOCOL_VERSION,
        codeVersion: process.env.GIT_COMMIT ?? "unknown",
        source,
        barMs,
        calendar,
        costBasis,
        priorTrials,
        trialsRecorded,
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
