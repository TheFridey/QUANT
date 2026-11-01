import "../load-env.js";
import { DEFAULT_VALIDATION, predictRoundTripCost, STRATEGY_LIBRARY, validateStrategy, type ResearchBar, type ValidationReport } from "@odin/backtest";
import { fetchGeckoTerminalPoolReserve } from "@odin/market-data";
import { DEFAULT_STRATEGY } from "@odin/shared";
import { Prisma, PrismaClient } from "@odin/shared/db";

/**
 * ASCEND-02/03 research run, outside the trading loop:
 *
 *   node dist/src/research/research-cli.js <datasetId> [codeVersion]
 *
 * Reads closed bars from the warehouse, prices costs with the ASCEND-06 model (conservative case), validates
 * every library strategy, and writes each run and every trial to the append-only registry. A strategy
 * version evaluates a dataset's holdout at most once (unique key). Research verdicts never change engine
 * config, strategy instances or promotion state.
 */

const PERIODS: Record<string, { crypto: number; equity: number }> = {
  "5m": { crypto: 12 * 24 * 365, equity: 78 * 252 },
  "1h": { crypto: 24 * 365, equity: 7 * 252 },
  "1d": { crypto: 365, equity: 252 },
};

async function costPerSide(prisma: PrismaClient, dataset: { instrumentKind: string; instrumentKey: string; sourceId: string }): Promise<{ bps: number; basis: string }> {
  const feeBps = Number(DEFAULT_STRATEGY.feeBps);
  const spreadBpsEstimate = Number(DEFAULT_STRATEGY.spreadBpsEstimate);
  if (dataset.instrumentKind === "EQUITY_ETF") {
    const p = predictRoundTripCost({ instrumentId: `etf:${dataset.instrumentKey}`, notionalUsd: 500, liquidityUsd: null, feeBps, spreadBpsEstimate, stepVolatilityBps: null, latencySteps: 0 });
    return { bps: p.conservativeBps / 2, basis: `ETF quoted spread + fee (conservative ${p.conservativeBps.toFixed(1)} bps round trip)` };
  }
  const obs = await prisma.marketObservation.findFirst({
    where: { pairAddress: dataset.instrumentKey, liquidityUsd: { not: null } },
    orderBy: { receivedAt: "desc" },
    select: { liquidityUsd: true, receivedAt: true },
  });
  let liquidity: number;
  let source: string;
  if (obs?.liquidityUsd) {
    liquidity = Number(obs.liquidityUsd);
    source = `latest QUANT observation ${obs.receivedAt.toISOString()}`;
  } else if (dataset.sourceId === "geckoterminal") {
    // QUANT never observed this pool: use the pool's own current reserves, labelled, never a guess.
    const reserve = await fetchGeckoTerminalPoolReserve(dataset.instrumentKey);
    if (!reserve.ok) throw new Error(`no observed liquidity for ${dataset.instrumentKey} and GeckoTerminal reserve unavailable (${reserve.error}); refusing to assume a cost`);
    liquidity = reserve.data.reserveUsd;
    source = `GeckoTerminal reserve_in_usd at ${new Date(reserve.data.fetchedAt).toISOString()}`;
  } else {
    throw new Error(`no observed liquidity for ${dataset.instrumentKey}; refusing to assume a cost`);
  }
  const p = predictRoundTripCost({ instrumentId: dataset.instrumentKey, notionalUsd: 500, liquidityUsd: liquidity, feeBps, spreadBpsEstimate, stepVolatilityBps: null, latencySteps: 0 });
  // Liquidity history is not stored, so the latest observation stands in for the whole window: labelled.
  return { bps: p.conservativeBps / 2, basis: `DEX $500 at liquidity $${Math.round(liquidity)} (${source}), conservative ${p.conservativeBps.toFixed(1)} bps round trip; present-day liquidity stands in for the whole window (no liquidity history)` };
}

function summary(r: ValidationReport, costBasis: string) {
  return {
    costBasis,
    trialCount: r.trialCount,
    selectedParamsByFold: r.selectedParamsByFold,
    gridScale: r.gridScale,
    oos: r.oos && {
      bars: r.oos.bars, trades: r.oos.trades, totalReturn: r.oos.totalReturn, sharpe: r.oos.sharpe, sortino: r.oos.sortino, maxDrawdown: r.oos.maxDrawdown,
      winRate: r.oos.winRate, profitFactor: r.oos.profitFactor, expectancy: r.oos.expectancy, exposure: r.oos.exposure, turnover: r.oos.turnover,
    },
    oosGross: r.oosGross,
    oosControls: r.oosControls,
    psr: r.psr,
    dsr: r.dsr,
    pbo: r.pbo,
    holdout: r.holdout && { params: r.holdout.params, totalReturn: r.holdout.stats.totalReturn, sharpe: r.holdout.stats.sharpe, trades: r.holdout.stats.trades },
  };
}

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
      const consumed = await prisma.researchHoldoutAccess.findUnique({
        where: { strategyId_strategyVersion_datasetId: { strategyId: spec.id, strategyVersion: spec.version, datasetId } },
      });
      const report = validateStrategy({ spec, bars, config, codeVersion, controls, holdoutAvailable: consumed === null });
      await prisma.$transaction(async (tx) => {
        const run = await tx.researchRun.create({
          data: {
            datasetId,
            datasetVersion: report.datasetVersion,
            codeVersion,
            strategyId: spec.id,
            strategyVersion: spec.version,
            family: spec.family,
            config: config as unknown as Prisma.InputJsonValue,
            verdict: report.verdict,
            reasons: report.reasons,
            evidence: report.evidence,
            summary: summary(report, cost.basis) as unknown as Prisma.InputJsonValue,
          },
        });
        if (report.trials.length) {
          await tx.researchTrial.createMany({
            data: report.trials.map((t) => ({
              runId: run.id,
              window: t.window,
              fold: t.fold,
              params: t.params,
              startT: new Date(t.startT),
              endT: new Date(t.endT),
              bars: t.bars,
              trades: t.trades,
              netReturn: t.netReturn,
              sharpe: t.sharpe,
              perBarSharpe: t.perBarSharpe,
            })),
          });
        }
        // The unique key makes a second holdout evaluation fail the whole transaction.
        if (report.trials.some((t) => t.window === "HOLDOUT")) {
          await tx.researchHoldoutAccess.create({ data: { strategyId: spec.id, strategyVersion: spec.version, datasetId, runId: run.id } });
        }
      });
      out.push({
        strategy: spec.id,
        verdict: report.verdict,
        oosTrades: report.oos?.trades ?? null,
        oosNetPct: report.oos ? +(report.oos.totalReturn * 100).toFixed(2) : null,
        oosGrossPct: report.oosGross ? +(report.oosGross.totalReturn * 100).toFixed(2) : null,
        oosSharpe: report.oos?.sharpe === null || !report.oos ? null : +report.oos.sharpe.toFixed(2),
        bhSharpeAnn: report.oosControls.buyAndHoldSharpe === null ? null : +(report.oosControls.buyAndHoldSharpe * Math.sqrt(config.periodsPerYear)).toFixed(2),
        dsr: report.dsr?.dsr === null || !report.dsr ? null : +report.dsr.dsr.toFixed(3),
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
