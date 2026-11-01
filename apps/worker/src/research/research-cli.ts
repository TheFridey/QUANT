import "../load-env.js";
import { DEFAULT_VALIDATION, STRATEGY_LIBRARY, validateStrategy, type ResearchBar } from "@odin/backtest";
import { PrismaClient } from "@odin/shared/db";
import { costPerSide, PERIODS } from "./cost-basis.js";
import { holdoutAvailable, programmeTrialCount } from "./holdout-policy.js";
import { recordValidation } from "./registry-writer.js";

/**
 * ASCEND-02/03 research run, outside the trading loop:
 *
 *   node dist/src/research/research-cli.js <datasetId> [codeVersion]
 *
 * Reads closed bars from the warehouse, prices costs with the ASCEND-06 model (conservative case), validates
 * every library strategy, and writes each run and every trial to the append-only registry. A strategy
 * evaluates a holdout at most once per instrument and interval, across versions (`holdout-policy.ts`; the
 * unique key backs the exact case), and DSR is deflated by every trial in the programme. Research verdicts never change engine
 * config, strategy instances or promotion state.
 */

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
    for (const spec of STRATEGY_LIBRARY) {
      const available = await holdoutAvailable(prisma, { strategyId: spec.id, instrumentKey: dataset.instrumentKey, interval: dataset.interval });
      const priorTrials = await programmeTrialCount(prisma);
      // No cost basis here is point-in-time (present-day liquidity, or a static ETF spread), so every
      // candidate must survive double cost.
      const report = validateStrategy({ spec, bars, config, codeVersion, controls, holdoutAvailable: available, programmeTrialCount: priorTrials, costIsProxy: true });
      await recordValidation(prisma, { datasetId, codeVersion, config, report, costBasis: cost.basis });
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
    console.log(JSON.stringify({ datasetId, instrument: dataset.instrumentKey, interval: dataset.interval, bars: bars.length, costBpsPerSide: +cost.bps.toFixed(2), costBasis: cost.basis, results: out }, null, 1));
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
