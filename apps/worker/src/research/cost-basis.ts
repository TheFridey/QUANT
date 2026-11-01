import { predictRoundTripCost } from "@odin/backtest";
import { fetchGeckoTerminalPoolReserve } from "@odin/market-data";
import { DEFAULT_STRATEGY } from "@odin/shared";
import type { PrismaClient } from "@odin/shared/db";

/** Shared by the ASCEND research CLIs: annualisation and the ASCEND-06 cost basis (conservative case, labelled). */

export const PERIODS: Record<string, { crypto: number; equity: number }> = {
  "5m": { crypto: 12 * 24 * 365, equity: 78 * 252 },
  "1h": { crypto: 24 * 365, equity: 7 * 252 },
  "1d": { crypto: 365, equity: 252 },
};

export async function costPerSide(prisma: Pick<PrismaClient, "marketObservation">, dataset: { instrumentKind: string; instrumentKey: string; sourceId: string }): Promise<{ bps: number; basis: string }> {
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
