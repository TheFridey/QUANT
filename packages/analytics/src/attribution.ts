import { d, usd } from "@odin/shared";
import { Decimal } from "@odin/shared";

/**
 * Instance-level net performance attribution (C37).
 * Attributes closed trade PnL and fees to strategyInstanceId without inventing fills.
 */

export type AttributedFill = {
  strategyInstanceId: string | null;
  realizedPnlUsd: string;
  feeUsd: string;
  notionalUsd?: string;
  instrumentId?: string | null;
  closedAt?: string;
};

export type InstanceAttributionRow = {
  strategyInstanceId: string;
  trades: number;
  grossPnlUsd: string;
  feesUsd: string;
  netPnlUsd: string;
  wins: number;
  losses: number;
  winRate: string | null;
  /** Share of portfolio net PnL (null when portfolio net is zero). */
  netShare: string | null;
};

export type NetPerformanceAttribution = {
  instances: InstanceAttributionRow[];
  unattributed: InstanceAttributionRow;
  portfolioGrossPnlUsd: string;
  portfolioFeesUsd: string;
  portfolioNetPnlUsd: string;
  sampleSize: number;
};

const UNATTRIBUTED = "unattributed";

export function attributeNetPerformance(fills: AttributedFill[]): NetPerformanceAttribution {
  const buckets = new Map<string, AttributedFill[]>();
  for (const fill of fills) {
    const key = fill.strategyInstanceId?.trim() ? fill.strategyInstanceId : UNATTRIBUTED;
    const list = buckets.get(key) ?? [];
    list.push(fill);
    buckets.set(key, list);
  }

  let portfolioGross = new Decimal(0);
  let portfolioFees = new Decimal(0);
  const rows: InstanceAttributionRow[] = [];

  for (const [strategyInstanceId, rowsFills] of buckets) {
    const row = summarizeBucket(strategyInstanceId, rowsFills);
    portfolioGross = portfolioGross.plus(d(row.grossPnlUsd));
    portfolioFees = portfolioFees.plus(d(row.feesUsd));
    if (strategyInstanceId === UNATTRIBUTED) continue;
    rows.push(row);
  }

  const unattributed = summarizeBucket(UNATTRIBUTED, buckets.get(UNATTRIBUTED) ?? []);
  const portfolioNet = portfolioGross.minus(portfolioFees);
  const withShare = rows
    .map((row) => ({
      ...row,
      netShare: portfolioNet.eq(0) ? null : d(row.netPnlUsd).div(portfolioNet).toFixed(6),
    }))
    .sort((a, b) => (d(b.netPnlUsd).gt(d(a.netPnlUsd)) ? 1 : d(b.netPnlUsd).lt(d(a.netPnlUsd)) ? -1 : 0));

  return {
    instances: withShare,
    unattributed: {
      ...unattributed,
      netShare: portfolioNet.eq(0) ? null : d(unattributed.netPnlUsd).div(portfolioNet).toFixed(6),
    },
    portfolioGrossPnlUsd: usd(portfolioGross),
    portfolioFeesUsd: usd(portfolioFees),
    portfolioNetPnlUsd: usd(portfolioNet),
    sampleSize: fills.length,
  };
}

function summarizeBucket(strategyInstanceId: string, fills: AttributedFill[]): InstanceAttributionRow {
  let gross = new Decimal(0);
  let fees = new Decimal(0);
  let wins = 0;
  let losses = 0;
  for (const fill of fills) {
    const pnl = d(fill.realizedPnlUsd);
    gross = gross.plus(pnl);
    fees = fees.plus(d(fill.feeUsd).abs());
    if (pnl.gt(0)) wins += 1;
    else if (pnl.lt(0)) losses += 1;
  }
  const trades = fills.length;
  return {
    strategyInstanceId,
    trades,
    grossPnlUsd: usd(gross),
    feesUsd: usd(fees),
    netPnlUsd: usd(gross.minus(fees)),
    wins,
    losses,
    winRate: trades === 0 ? null : new Decimal(wins).div(trades).toFixed(6),
    netShare: null,
  };
}
