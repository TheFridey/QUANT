import "../load-env.js";
import { inferBarMs, ML_PROTOCOL_VERSION, runIntelligenceStudy, type IntelligenceStudy, type ResearchBar } from "@odin/backtest";
import { GeckoTerminalPoolSource, INTERVAL_MS, normaliseBars, type HistoryInterval, type RawBar } from "@odin/market-data";
import { Prisma, PrismaClient } from "@odin/shared/db";
import { costPerSide, PERIODS } from "./cost-basis.js";
import { programmeTrialCount } from "./holdout-policy.js";
import { recordValidation } from "./registry-writer.js";

/**
 * SINGULARITY integrated research study (ASCEND-04/05/08), outside the trading loop:
 *
 *   node dist/src/research/intelligence-cli.js <datasetId> [--record]
 *   node dist/src/research/intelligence-cli.js --gecko <poolAddress> <interval> [--days N]
 *
 * Warehouse mode reads closed bars (availableAt <= now) and, only with --record, appends the regime-gated runs
 * and the ML evaluation to the research registry. Gecko mode fetches genuine GeckoTerminal OHLCV into memory
 * (rate-limited, keyless tier) for an offline study and never writes anything. No mode changes engine config,
 * strategy instances, orders or promotion state.
 */

function compact(study: IntelligenceStudy) {
  const pct = (x: number | null | undefined) => (x === null || x === undefined ? null : +(x * 100).toFixed(2));
  const latest = study.regimes.latest;
  return {
    bars: study.bars,
    regimes: {
      modelVersion: study.regimes.modelVersion,
      latest: latest && { t: new Date(latest.t).toISOString(), trend: latest.trend, volatility: latest.volatility.level, behaviour: latest.behaviour.state, liquidity: latest.liquidity.state, insufficient: latest.insufficient },
      trendShare: Object.fromEntries(Object.entries(study.regimes.trendShare).map(([k, v]) => [k, +v.toFixed(3)])),
      volatilityShare: Object.fromEntries(Object.entries(study.regimes.volatilityShare).map(([k, v]) => [k, +v.toFixed(3)])),
      unknownShare: +study.regimes.unknownShare.toFixed(3),
      buyAndHoldByTrend: study.regimes.buyAndHoldByTrend.map((b) => ({ regime: b.regime, bars: b.bars, totalPct: pct(b.totalReturn) })),
    },
    hypotheses: study.hypotheses.map((h) => ({
      strategy: h.gated.strategyId,
      hypothesis: h.hypothesis,
      // The base is a comparison with its holdout withheld, so a would-be candidate shows as INSUFFICIENT_EVIDENCE.
      base: { verdict: `${h.base.verdict} (holdout withheld)`, trades: h.base.oos?.trades ?? null, netPct: pct(h.base.oos?.totalReturn), maxDdPct: pct(h.base.oos?.maxDrawdown) },
      gated: {
        verdict: h.gated.verdict,
        trades: h.gated.oos?.trades ?? null,
        netPct: pct(h.gated.oos?.totalReturn),
        grossPct: pct(h.gated.oosGross?.totalReturn),
        maxDdPct: pct(h.gated.oos?.maxDrawdown),
        net2xCostPct: pct(h.gated.costSensitivity[0]?.netReturn),
        dsr: h.gated.dsrProgramme?.dsr ?? h.gated.dsr?.dsr ?? null,
        pbo: h.gated.pbo?.pbo ?? null,
        trials: h.gated.trialCount,
        reasons: h.gated.reasons,
      },
    })),
    ml: {
      verdict: study.ml.verdict,
      reasons: study.ml.reasons,
      horizon: study.ml.horizon,
      rows: study.ml.rows,
      folds: study.ml.folds.map((f) => ({ fold: f.fold, train: f.trainRows, purged: f.purged, test: f.testRows })),
      brier: study.ml.oos && { base: +study.ml.oos.BASE_RATE.brier.toFixed(5), logistic: +study.ml.oos.LOGISTIC_L2.brier.toFixed(5), boosted: +study.ml.oos.BOOSTED_STUMPS.brier.toFixed(5) },
      auc: study.ml.oos && { logistic: study.ml.oos.LOGISTIC_L2.auc, boosted: study.ml.oos.BOOSTED_STUMPS.auc },
      ece: study.ml.oos && { logistic: +study.ml.oos.LOGISTIC_L2.ece.toFixed(4), boosted: +study.ml.oos.BOOSTED_STUMPS.ece.toFixed(4) },
      brierSkill: study.ml.brierSkill,
      aucPValue: study.ml.aucPValue,
      decisions: study.ml.decisions,
      maxPsi: study.ml.drift.reduce((m, d) => Math.max(m, d.psi ?? 0), 0),
    },
    objections: study.objections,
    conclusion: study.conclusion,
  };
}

async function fetchGecko(pool: string, interval: HistoryInterval, days: number): Promise<{ bars: ResearchBar[]; provenance: string }> {
  const source = new GeckoTerminalPoolSource();
  const intervalMs = INTERVAL_MS[interval];
  const endMs = Date.now();
  const startMs = endMs - days * 86_400_000;
  const raw: RawBar[] = [];
  let cursor: string | null = null;
  let retries = 0;
  for (let page = 0; page < 20; page += 1) {
    const res = await source.fetchPage({ instrumentKey: pool, interval, startMs, endMs, cursor });
    if (!res.ok && res.code === "RATE_LIMITED" && retries < 3) {
      retries += 1;
      page -= 1;
      await new Promise((r) => setTimeout(r, res.retryAfterMs ?? 60_000));
      continue;
    }
    if (!res.ok) throw new Error(`geckoterminal: ${res.code} ${res.error}`);
    raw.push(...res.bars);
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
    await new Promise((r) => setTimeout(r, Math.ceil(60_000 / source.maxRequestsPerMinute)));
  }
  const collectedAt = Date.now();
  const norm = normaliseBars(raw, { intervalMs, collectedAt });
  const bars = norm.bars
    .filter((b) => b.availableAt <= collectedAt)
    .map((b) => ({ t: b.openTime, open: Number(b.open), high: Number(b.high), low: Number(b.low), close: Number(b.close), volume: b.volume === null ? null : Number(b.volume) }));
  return { bars, provenance: `${source.licence.provider} (${source.licence.attribution}), pool ${pool} ${interval}, fetched ${new Date(collectedAt).toISOString()}, ${norm.rejected.length} rejected, ${norm.duplicatesDropped} duplicates dropped` };
}

async function offline(args: string[], codeVersion: string) {
  const [, pool, interval = "1h"] = args;
  const daysArg = args.indexOf("--days");
  const days = daysArg >= 0 ? Number(args[daysArg + 1]) : 180;
  if (!pool || !(interval in INTERVAL_MS) || !(days > 0)) throw new Error("usage: intelligence-cli --gecko <pool> <interval> [--days N]");
  // Same cost basis as the warehouse path; with no QUANT observation it uses the pool's present-day reserve.
  // Fetched before the bars so the OHLCV paging cannot exhaust the keyless rate limit first.
  const noObservations = { marketObservation: { findFirst: async () => null } } as unknown as Pick<PrismaClient, "marketObservation">;
  const cost = await costPerSide(noObservations, { instrumentKind: "DEX_POOL", instrumentKey: pool, sourceId: "geckoterminal" });
  const { bars, provenance } = await fetchGecko(pool, interval as HistoryInterval, days);
  const study = runIntelligenceStudy({ bars, barMs: INTERVAL_MS[interval as HistoryInterval], costBpsPerSide: cost.bps, periodsPerYear: PERIODS[interval]?.crypto ?? 8760, codeVersion, costIsProxy: true });
  console.log(JSON.stringify({ mode: "OFFLINE_DRY_RUN", provenance, costBpsPerSide: +cost.bps.toFixed(2), costBasis: cost.basis, study: compact(study) }, null, 1));
}

async function main() {
  const args = process.argv.slice(2);
  const codeVersion = process.env.GIT_COMMIT ?? "unknown";
  if (args[0] === "--gecko") return offline(args, codeVersion);
  const datasetId = args[0];
  const record = args.includes("--record");
  if (!datasetId) throw new Error("usage: intelligence-cli <datasetId> [--record] | --gecko <pool> <interval> [--days N]");
  const prisma = new PrismaClient();
  try {
    const dataset = await prisma.historicalDataset.findUniqueOrThrow({ where: { id: datasetId } });
    const rows = await prisma.historicalBar.findMany({ where: { datasetId, availableAt: { lte: new Date() } }, orderBy: { openTime: "asc" } });
    const bars: ResearchBar[] = rows.map((row) => ({ t: row.openTime.getTime(), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: row.volume === null ? null : Number(row.volume) }));
    const periods = PERIODS[dataset.interval];
    if (!periods) throw new Error(`no annualisation for interval ${dataset.interval}`);
    const cost = await costPerSide(prisma, dataset);
    const study = runIntelligenceStudy({
      bars,
      barMs: INTERVAL_MS[dataset.interval as HistoryInterval] ?? inferBarMs(bars),
      costBpsPerSide: cost.bps,
      periodsPerYear: dataset.instrumentKind === "EQUITY_ETF" ? periods.equity : periods.crypto,
      calendar: dataset.instrumentKind === "EQUITY_ETF" ? "WEEKDAYS" : "CONTINUOUS",
      codeVersion,
      programmeTrialCount: await programmeTrialCount(prisma),
      costIsProxy: true,
      // F03: every holdout is withheld. This CLI recorded the access only after evaluating, so a crash or a
      // concurrent run could read final bars without durable consumption. Use a research campaign instead.
      holdoutWithheld: true,
    });
    if (record) {
      for (const h of study.hypotheses) await recordValidation(prisma, { datasetId, codeVersion, config: h.gated.config, report: h.gated, costBasis: cost.basis });
      await prisma.researchRun.create({
        data: {
          datasetId,
          datasetVersion: study.hypotheses[0]?.gated.datasetVersion ?? "n/a",
          codeVersion,
          strategyId: `ml_netpos_h${study.ml.horizon}`,
          strategyVersion: `${ML_PROTOCOL_VERSION}/${study.ml.featureSet}`,
          family: "ML",
          config: study.ml.config as unknown as Prisma.InputJsonValue,
          verdict: study.ml.verdict,
          reasons: study.ml.reasons,
          evidence: study.ml.oos ? "VERIFIED_HISTORICAL" : "INSUFFICIENT_EVIDENCE",
          summary: { costBasis: cost.basis, ...study.ml } as unknown as Prisma.InputJsonValue,
        },
      });
    }
    console.log(JSON.stringify({ mode: record ? "RECORDED" : "DRY_RUN", datasetId, instrument: dataset.instrumentKey, interval: dataset.interval, costBpsPerSide: +cost.bps.toFixed(2), costBasis: cost.basis, study: compact(study) }, null, 1));
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
