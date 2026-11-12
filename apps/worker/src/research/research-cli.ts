import "../load-env.js";
import { DEFAULT_VALIDATION, STRATEGY_LIBRARY, validateStrategy, type ResearchBar } from "@odin/backtest";
import { PrismaClient } from "@odin/shared/db";
import { costPerSide, PERIODS } from "./cost-basis.js";
import { closeStudy, openStudy } from "@odin/evolution/campaign";
import { EXPLORATORY_EVIDENCE_CLASS, studyKey } from "./holdout-policy.js";
import { recordValidation } from "./registry-writer.js";

/**
 * ASCEND-02/03 research run, outside the trading loop:
 *
 *   node dist/src/research/research-cli.js <datasetId> [codeVersion]
 *
 * Reads closed bars from the warehouse, prices costs with the ASCEND-06 model (conservative case), validates
 * every library strategy, and writes each run and every trial to the append-only registry. DSR is deflated by
 * every trial in the programme. Research verdicts never change engine config, strategy instances or promotion
 * state.
 *
 * OPERATION INTEGRITY F03: this CLI WITHHOLDS every holdout. It used to check availability, evaluate the
 * holdout, and only then record the access, so a crash or a concurrent run could read final bars with no
 * durable consumption. Holdout evaluation is supported only through research campaigns, which commit the
 * holdout ledger before outcomes are read (`packages/evolution/src/campaign/holdout.ts`); the best verdict
 * here is INSUFFICIENT_EVIDENCE with `walkForwardPassed: true`.
 *
 * Trial accounting (F03 remainder): the study is OPENED in the trial ledger before any strategy is evaluated, which
 * freezes the programme count it is deflated by; each strategy's trials then count through its registry rows,
 * committed before the next strategy runs; the study is CLOSED (0 extra trials, the registry holds them) before
 * anything is printed. A crash leaves an unclosed study for reconciliation, and nothing was disclosed. A study key
 * that was already closed is refused rather than recorded twice. This CLI is exploratory only (EXPLORATORY evidence
 * class); research campaigns are the sole qualified-evidence path.
 */
export const RESEARCH_CLI_HOLDOUT = "WITHHELD" as const;

async function main() {
  const [datasetId, codeVersion = process.env.GIT_COMMIT ?? "unknown"] = process.argv.slice(2);
  if (!datasetId) {
    console.error("usage: research-cli <datasetId> [codeVersion]");
    process.exit(2);
  }
  const prisma = new PrismaClient();
  try {
    const dataset = await prisma.historicalDataset.findUniqueOrThrow({ where: { id: datasetId } });
    const rows = await prisma.historicalBar.findMany({ where: { datasetId, availableAt: { lte: new Date() } }, orderBy: { openTime: "asc" } });
    const bars: ResearchBar[] = rows.map((row) => ({
      t: row.openTime.getTime(),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: row.volume === null ? null : Number(row.volume),
    }));
    const periods = PERIODS[dataset.interval];
    if (!periods) throw new Error(`no annualisation for interval ${dataset.interval}`);
    const cost = await costPerSide(prisma, dataset);
    const config = { ...DEFAULT_VALIDATION, costBpsPerSide: cost.bps, periodsPerYear: dataset.instrumentKind === "EQUITY_ETF" ? periods.equity : periods.crypto };
    const find = (id: string) => STRATEGY_LIBRARY.find((s) => s.id === id)!;
    const controls = { buyAndHold: find("control_buy_and_hold"), random: find("control_random"), cash: find("control_cash") };
    const out: Array<Record<string, unknown>> = [];
    const key = studyKey({ cli: "research-cli", datasetId, versionHash: dataset.versionHash, codeVersion, config, strategies: STRATEGY_LIBRARY.map((s) => `${s.id}@${s.version}`) });
    const opened = await openStudy(prisma, { studyKey: key, actor: "research-cli", note: `research-cli ${datasetId} at ${codeVersion}` });
    if (opened.status === "ALREADY_CLOSED") throw new Error(`REFUSED: study ${key} (same dataset content, code and config) was already recorded; a rerun would add no information and would duplicate registry rows`);
    let runTrials = 0;
    for (const spec of STRATEGY_LIBRARY) {
      // Frozen at OPEN, plus this run's earlier strategies (already in the registry).
      const priorTrials = opened.priorTrials + runTrials;
      // No cost basis here is point-in-time (present-day liquidity, or a static ETF spread), so every
      // candidate must survive double cost.
      const report = validateStrategy({ spec, bars, config, codeVersion, controls, holdoutWithheld: true, programmeTrialCount: priorTrials, costIsProxy: true });
      await recordValidation(prisma, { datasetId, codeVersion, config, report, costBasis: cost.basis });
      runTrials += report.trialCount;
      out.push({
        strategy: spec.id,
        verdict: report.verdict,
        oosTrades: report.oos?.trades ?? null,
        oosNetPct: report.oos ? +(report.oos.totalReturn * 100).toFixed(2) : null,
        oosGrossPct: report.oosGross ? +(report.oosGross.totalReturn * 100).toFixed(2) : null,
        oosSharpe: report.oos?.sharpe === null || !report.oos ? null : +report.oos.sharpe.toFixed(2),
        bhSharpeAnn: report.oosControls.buyAndHoldSharpe === null ? null : +(report.oosControls.buyAndHoldSharpe * Math.sqrt(config.periodsPerYear)).toFixed(2),
        dsr: report.dsr?.dsr === null || !report.dsr ? null : +report.dsr.dsr.toFixed(3),
        dsrProgramme: report.dsrProgramme?.dsr === null || !report.dsrProgramme ? null : +report.dsrProgramme.dsr.toFixed(3),
        net2xCostPct: +((report.costSensitivity[0]?.netReturn ?? 0) * 100).toFixed(2),
        pbo: report.pbo?.pbo === null || !report.pbo ? null : +report.pbo.pbo.toFixed(2),
        trials: report.trialCount,
        gridScale: report.gridScale ? +report.gridScale.factor.toFixed(3) : null,
        reasons: report.reasons.join("; "),
      });
    }
    const closed = await closeStudy(prisma, { studyKey: key, trials: 0, actor: "research-cli", note: `research-cli ${datasetId}: ${runTrials} trials counted via ResearchTrial registry rows`, registryTrials: runTrials });
    console.log(JSON.stringify({ evidenceClass: EXPLORATORY_EVIDENCE_CLASS, trialAccounting: { studyKey: key, opened: opened.status, priorTrialsFrozen: opened.priorTrials, runTrials, concurrentTrials: closed.concurrentTrials, priorStale: closed.concurrentTrials > 0 }, holdout: `${RESEARCH_CLI_HOLDOUT}: evaluate holdouts through a research campaign`, datasetId, instrument: dataset.instrumentKey, interval: dataset.interval, bars: bars.length, costBpsPerSide: +cost.bps.toFixed(2), costBasis: cost.basis, results: out }, null, 1));
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
