import { performanceReport, valuePortfolio, type Mark } from "@odin/analytics";
import { d, type ReasonCode, Decimal } from "@odin/shared";
import type { DecisionDraft, PositionView } from "./types.js";

export type ResearchMetrics = {
  netPnlUsd: string | null;
  winRate: string | null;
  wins: number;
  losses: number;
  avgWinUsd: string | null;
  avgLossUsd: string | null;
  profitFactor: string | null;
  expectancyUsd: string | null;
  maxDrawdownPct: string | null;
  exposureUsd: string | null;
  turnoverUsd: string | null;
  closedTrades: number;
  sampleSize: number;
  observed: boolean;
  reasonCodes: ReasonCode[];
};

export function computeResearchMetrics(input: {
  decisions: DecisionDraft[];
  orders: number;
  startingBalanceUsd: string;
  cashUsd: string;
  positions: PositionView[];
  marks: Record<string, Mark | undefined>;
  closedTradePnlUsd?: string[];
  feesUsd?: string;
  equitySeries?: string[];
}): ResearchMetrics {
  const valuation = valuePortfolio({
    cashUsd: input.cashUsd,
    positions: input.positions,
    marks: input.marks,
  });
  const closed = input.closedTradePnlUsd ?? [];
  const report = performanceReport({
    valuation,
    startingBalanceUsd: input.startingBalanceUsd,
    feesUsd: input.feesUsd ?? "0.00000000",
    closedTradePnlUsd: closed,
  });

  const reasonCodes: ReasonCode[] = ["AUDIT_RECORDED"];
  const sampleSize = closed.length;
  if (sampleSize < 5) reasonCodes.push("SAMPLE_SIZE_LOW");

  let winsSum = new Decimal(0);
  let lossesSum = new Decimal(0);
  for (const pnl of closed) {
    const value = d(pnl);
    if (value.gt(0)) winsSum = winsSum.plus(value);
    else if (value.lt(0)) lossesSum = lossesSum.plus(value.abs());
  }

  const avgWinUsd = report.wins === 0 ? null : winsSum.div(report.wins).toFixed(8);
  const avgLossUsd = report.losses === 0 ? null : lossesSum.div(report.losses).toFixed(8);
  const profitFactor =
    report.losses === 0
      ? report.wins > 0
        ? null
        : null
      : lossesSum.eq(0)
        ? null
        : winsSum.div(lossesSum).toFixed(6);
  const expectancyUsd =
    sampleSize === 0 ? null : winsSum.minus(lossesSum).div(sampleSize).toFixed(8);

  const exposureUsd =
    valuation.unrealizedPnlUsd === null || valuation.equityUsd === null
      ? null
      : d(valuation.equityUsd).minus(d(valuation.cashUsd)).toFixed(8);

  const maxDrawdownPct = maxDrawdown(input.equitySeries ?? []);
  const netPnlUsd =
    valuation.equityUsd === null
      ? null
      : d(valuation.equityUsd).minus(d(input.startingBalanceUsd)).toFixed(8);

  return {
    netPnlUsd,
    winRate: report.winRate,
    wins: report.wins,
    losses: report.losses,
    avgWinUsd,
    avgLossUsd,
    profitFactor,
    expectancyUsd,
    maxDrawdownPct,
    exposureUsd,
    turnoverUsd: null,
    closedTrades: report.closedTrades,
    sampleSize,
    observed: valuation.marksComplete,
    reasonCodes,
  };
}

function maxDrawdown(series: string[]): string | null {
  if (series.length < 2) return null;
  let peak = d(series[0]!);
  let maxDd = new Decimal(0);
  for (const point of series) {
    const equity = d(point);
    if (equity.gt(peak)) peak = equity;
    if (peak.gt(0)) {
      const dd = peak.minus(equity).div(peak).mul(100);
      if (dd.gt(maxDd)) maxDd = dd;
    }
  }
  return maxDd.toFixed(4);
}
