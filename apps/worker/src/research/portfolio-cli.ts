import "../load-env.js";
import {
  backtestAllocation,
  alignReturns,
  closeToCloseReturns,
  portfolioReport,
  PORTFOLIO_MODEL_VERSION,
  type AllocationRule,
  type ReturnSeries,
} from "@odin/backtest";
import { INTERVAL_MS, type HistoryInterval } from "@odin/market-data";
import { PrismaClient } from "@odin/shared/db";
import { costPerSide, PERIODS } from "./cost-basis.js";
import { defaultRebalanceBars, parseArgs } from "./portfolio-args.js";

/**
 * ASCEND-07 portfolio study (research only, read only):
 *
 *   node dist/src/research/portfolio-cli.js <datasetId> <datasetId> [...] [--lookback N] [--rebalance N]
 *
 * Reads closed warehouse bars (availableAt <= now), builds close-to-close returns that never bridge gaps,
 * aligns the datasets on common timestamps without filling, and prints correlation, shrinkage, allocation
 * baselines (equal weight, inverse volatility, equal risk contribution), risk shares, stress and a
 * point-in-time allocation backtest. It writes nothing: no registry row, engine config, strategy instance,
 * order or promotion state, and its allocations never size orders.
 *
 * Refused: datasets with different intervals, and mixing an equity (weekday) calendar with a continuous one,
 * because their returns cover different periods (an equity Monday return spans the weekend). Session-aligned
 * aggregation for mixed calendars is not implemented.
 */

async function main() {
  const { datasetIds, flags } = parseArgs(process.argv.slice(2));
  if (datasetIds.length < 2) throw new Error("usage: portfolio-cli <datasetId> <datasetId> [...] [--lookback N] [--rebalance N]");
  const prisma = new PrismaClient();
  try {
    const datasets = await Promise.all(datasetIds.map((id) => prisma.historicalDataset.findUniqueOrThrow({ where: { id } })));
    const intervals = new Set(datasets.map((d) => d.interval));
    if (intervals.size !== 1) throw new Error(`REFUSED: datasets have different intervals (${[...intervals].join(", ")})`);
    const interval = datasets[0]!.interval as HistoryInterval;
    const calendars = new Set(datasets.map((d) => (d.instrumentKind === "EQUITY_ETF" ? "WEEKDAYS" : "CONTINUOUS")));
    if (calendars.size !== 1) throw new Error("REFUSED: mixing equity (weekday) and continuous calendars needs session-aligned returns, which are not implemented");
    const calendar = [...calendars][0] as "WEEKDAYS" | "CONTINUOUS";
    const barMs = INTERVAL_MS[interval];
    const periods = PERIODS[interval];
    if (!barMs || !periods) throw new Error(`no interval/annualisation for ${interval}`);
    const periodsPerYear = calendar === "WEEKDAYS" ? periods.equity : periods.crypto;

    const now = new Date();
    const series: ReturnSeries[] = [];
    const inputs = [];
    let worstCost = { bps: 0, basis: "none" };
    for (const dataset of datasets) {
      const rows = await prisma.historicalBar.findMany({ where: { datasetId: dataset.id, availableAt: { lte: now } }, orderBy: { openTime: "asc" } });
      const returns = closeToCloseReturns(rows.map((r) => ({ t: r.openTime.getTime(), close: Number(r.close) })), barMs, calendar);
      series.push({ id: `${dataset.instrumentKey}:${dataset.interval}`, market: dataset.cohort, points: returns.points });
      const cost = await costPerSide(prisma, dataset);
      if (cost.bps > worstCost.bps) worstCost = cost;
      inputs.push({ datasetId: dataset.id, instrument: dataset.instrumentKey, cohort: dataset.cohort, versionHash: dataset.versionHash, bars: rows.length, returns: returns.points.length, gaps: returns.gaps, costBpsPerSide: +cost.bps.toFixed(2), costBasis: cost.basis });
    }

    const report = portfolioReport(series, { periodsPerYear });
    const aligned = alignReturns(series);
    const lookback = flags["--lookback"] ?? Math.min(500, Math.max(30, Math.floor(aligned.returns.length / 4)));
    const rebalanceEvery = flags["--rebalance"] ?? defaultRebalanceBars(barMs, calendar);
    const rules: AllocationRule[] = ["EQUAL_WEIGHT", "INVERSE_VOLATILITY", "EQUAL_RISK_CONTRIBUTION"];
    const pct = (x: number | null) => (x === null ? null : +(x * 100).toFixed(2));
    const backtests =
      aligned.returns.length > lookback + 1
        ? rules.map((rule) => {
            const bt = backtestAllocation(aligned, rule, { lookback, rebalanceEvery, costBpsPerSide: worstCost.bps, shrink: true, periodsPerYear });
            return { rule, bars: bt.netReturns.length, rebalances: bt.rebalances, skipped: bt.skippedRebalances, netPct: pct(bt.totalReturnNet), grossPct: pct(bt.totalReturnGross), costDragPct: pct(bt.costDrag), investedFrom: bt.startIndex >= 0 ? new Date(aligned.t[bt.startIndex]!).toISOString() : null, annVolPct: pct(bt.annualisedVolatility), maxDdPct: pct(bt.maxDrawdown), sharpe: bt.sharpe, sufficient: bt.sufficient };
          })
        : "INSUFFICIENT_EVIDENCE: fewer aligned returns than the look-back";

    console.log(
      JSON.stringify(
        {
          mode: "READ_ONLY",
          version: PORTFOLIO_MODEL_VERSION,
          evidence: "RESEARCH_ONLY",
          interval,
          calendar,
          inputs,
          aligned: { observations: aligned.returns.length, dropped: aligned.droppedTimestamps, invalidReturns: aligned.invalidReturns, from: aligned.t[0] ? new Date(aligned.t[0]).toISOString() : null, to: aligned.t.at(-1) ? new Date(aligned.t.at(-1)!).toISOString() : null },
          backtestCost: { bpsPerSide: +worstCost.bps.toFixed(2), basis: `highest per-asset cost applied to all turnover (conservative): ${worstCost.basis}` },
          report: {
            sufficient: report.sufficient,
            shrinkage: report.shrinkage,
            correlation: report.correlation?.map((row) => row.map((v) => (v === null ? null : +v.toFixed(3)))) ?? null,
            assetVolatilityPct: report.assetVolatility?.map((v) => +(v * 100).toFixed(2)) ?? null,
            allocations: report.allocations.map((a) => ({
              rule: a.rule,
              weights: a.weights?.map((w) => +w.toFixed(4)) ?? null,
              effectiveN: a.concentration ? +a.concentration.effectiveN.toFixed(2) : null,
              riskShares: a.riskShares?.map((s) => +s.toFixed(3)) ?? null,
              annVolPct: pct(a.annualisedVolatility),
              stressedVolPct: pct(a.stressedVolatility),
              // returnPct is null (unknown, not 0%) when a held asset's cohort is not in the scenario.
              scenarios: a.scenarios?.map((s) => ({ name: s.name, returnPct: pct(s.portfolioReturn), unshocked: s.unshockedAssets })) ?? null,
            })),
            limitations: report.limitations,
          },
          lookback,
          rebalanceEvery,
          backtests,
          conclusion: "Descriptive research only. No allocation rule is validated by this output, and none is applied to the paper engine.",
        },
        null,
        1,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
