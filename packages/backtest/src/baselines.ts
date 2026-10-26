import { d, usd } from "@odin/shared";
import type { BacktestObservation, BacktestResult } from "./types.js";

export type BaselineResult = {
  name: string;
  returnPct: string | null;
  finalEquityUsd: string | null;
  sampleSize: number;
  observed: boolean;
  label: string;
  notes: string[];
};

/**
 * Compare strategy result against no-trade cash, buy-and-hold (when data allows),
 * and a simple pre-defined momentum rule baseline.
 */
export function computeBaselines(input: {
  observations: BacktestObservation[];
  initialBalanceUsd: string;
  strategy: BacktestResult;
  startAt: string;
  endAt: string;
}): BaselineResult[] {
  return [
    cashBaseline(input.initialBalanceUsd),
    buyAndHoldBaseline(input),
    simpleMomentumBaseline(input),
  ];
}

function cashBaseline(initialBalanceUsd: string): BaselineResult {
  return {
    name: "no_trade_cash",
    returnPct: "0.0000",
    finalEquityUsd: initialBalanceUsd,
    sampleSize: 0,
    observed: true,
    label: "BASELINE",
    notes: ["Cash earns zero in this paper model; no interest is invented."],
  };
}

function buyAndHoldBaseline(input: {
  observations: BacktestObservation[];
  initialBalanceUsd: string;
  startAt: string;
  endAt: string;
}): BaselineResult {
  const notes: string[] = [
    "Equal-weight buy-and-hold across pairs that have a positive price at both start and end windows.",
    "Pairs missing either endpoint are reported as unavailable — not silently filled.",
  ];
  const byPair = new Map<string, BacktestObservation[]>();
  for (const obs of input.observations) {
    const t = Date.parse(obs.receivedAt);
    if (t < Date.parse(input.startAt) || t > Date.parse(input.endAt)) continue;
    const list = byPair.get(obs.pairAddress) ?? [];
    list.push(obs);
    byPair.set(obs.pairAddress, list);
  }

  const returns: number[] = [];
  let unavailable = 0;
  for (const [, rows] of byPair) {
    const ordered = [...rows].sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
    const first = ordered.find((row) => row.priceUsd && d(row.priceUsd).gt(0));
    const last = [...ordered].reverse().find((row) => row.priceUsd && d(row.priceUsd).gt(0));
    if (!first?.priceUsd || !last?.priceUsd) {
      unavailable += 1;
      continue;
    }
    returns.push(d(last.priceUsd).div(d(first.priceUsd)).minus(1).mul(100).toNumber());
  }

  if (returns.length === 0) {
    return {
      name: "buy_and_hold",
      returnPct: null,
      finalEquityUsd: null,
      sampleSize: 0,
      observed: false,
      label: "INSUFFICIENT_EVIDENCE",
      notes: [...notes, `No pair had priced endpoints (${unavailable} unavailable).`],
    };
  }

  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const finalEquity = d(input.initialBalanceUsd).mul(d("1").plus(d(avgReturn.toFixed(8)).div(100)));
  return {
    name: "buy_and_hold",
    returnPct: avgReturn.toFixed(4),
    finalEquityUsd: usd(finalEquity),
    sampleSize: returns.length,
    observed: true,
    label: "BASELINE",
    notes: [...notes, `${unavailable} pairs lacked endpoints and were excluded from the average (disclosed).`],
  };
}

/** Naive rule: buy first momentum print, sell on stop/take using same config thresholds via result comparison only. */
function simpleMomentumBaseline(input: {
  observations: BacktestObservation[];
  initialBalanceUsd: string;
  strategy: BacktestResult;
  startAt: string;
  endAt: string;
}): BaselineResult {
  // Use a single-pair first-signal heuristic on the most-observed pair — transparent and weak on purpose.
  const counts = new Map<string, number>();
  for (const obs of input.observations) {
    counts.set(obs.pairAddress, (counts.get(obs.pairAddress) ?? 0) + 1);
  }
  let bestPair: string | null = null;
  let bestCount = 0;
  for (const [pair, count] of counts) {
    if (count > bestCount) {
      bestPair = pair;
      bestCount = count;
    }
  }
  if (!bestPair) {
    return {
      name: "simple_momentum_rule",
      returnPct: null,
      finalEquityUsd: null,
      sampleSize: 0,
      observed: false,
      label: "INSUFFICIENT_EVIDENCE",
      notes: ["No observations available for the simple rule baseline."],
    };
  }
  const rows = input.observations
    .filter((obs) => obs.pairAddress === bestPair)
    .filter((obs) => {
      const t = Date.parse(obs.receivedAt);
      return t >= Date.parse(input.startAt) && t <= Date.parse(input.endAt);
    })
    .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));

  const entry = rows.find(
    (obs) =>
      obs.priceUsd &&
      d(obs.priceUsd).gt(0) &&
      obs.priceChangeM5Pct !== null &&
      d(obs.priceChangeM5Pct).gte("2"),
  );
  const last = [...rows].reverse().find((obs) => obs.priceUsd && d(obs.priceUsd).gt(0));
  if (!entry?.priceUsd || !last?.priceUsd) {
    return {
      name: "simple_momentum_rule",
      returnPct: null,
      finalEquityUsd: null,
      sampleSize: 0,
      observed: false,
      label: "INSUFFICIENT_EVIDENCE",
      notes: [`Pair ${bestPair} lacked an entry signal or exit mark.`],
    };
  }
  // Apply a crude 30 bps round-trip cost so the baseline is not cost-free.
  const gross = d(last.priceUsd).div(d(entry.priceUsd)).minus(1).mul(100);
  const net = gross.minus("0.30");
  const finalEquity = d(input.initialBalanceUsd).mul(d("1").plus(net.div(100)));
  return {
    name: "simple_momentum_rule",
    returnPct: net.toFixed(4),
    finalEquityUsd: usd(finalEquity),
    sampleSize: 1,
    observed: true,
    label: "BASELINE",
    notes: [
      `Single-pair first m5>=2% entry on ${bestPair}, mark at window end.`,
      "Round-trip 30 bps cost haircut applied; not an optimised strategy.",
    ],
  };
}
