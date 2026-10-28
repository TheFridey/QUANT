import { d, isPaperMultiMarketPair, type CyclePair, type StrategyConfig } from "@odin/shared";

export const STRATEGY_CONTRACT_VERSION = "1.0.0" as const;

export type StrategySignal = {
  instrumentId: string;
  pairAddress?: string;
  intent: "ENTER_LONG" | "EXIT_LONG" | "HOLD" | "RESEARCH_NOTE";
  reasonCodes: string[];
  confidence?: number;
};

export type StrategyBar = {
  instrumentId: string;
  pairAddress?: string;
  receivedAt: string;
  priceUsd: string | null;
  liquidityUsd: string | null;
  volume24hUsd: string | null;
  priceChangeM5Pct: string | null;
  priceChangeH1Pct: string | null;
  txnsM5Buys: number | null;
  txnsM5Sells: number | null;
  dataState: string;
};

export type StrategyContext = {
  config: StrategyConfig;
  openPositions: Array<{ instrumentId: string; pairAddress: string; qty: string }>;
  history: StrategyBar[];
};

export interface StrategyModule {
  readonly id: string;
  readonly version: string;
  readonly instrumentIds: string[];
  onBar(bar: StrategyBar, context: StrategyContext): StrategySignal;
}

/** Thin adapters that emit StrategySignals — risk/sizing stay outside. */
export function createPulseMomentumStrategy(input: {
  id?: string;
  instrumentIds: string[];
}): StrategyModule {
  return {
    id: input.id ?? "pulse-momentum-v1",
    version: "1.0.0",
    instrumentIds: input.instrumentIds,
    onBar(bar, context) {
      return pulseMomentumOnBar(bar, context);
    },
  };
}

export function createBreakoutHoldStrategy(input: {
  id?: string;
  instrumentIds: string[];
}): StrategyModule {
  return {
    id: input.id ?? "breakout-hold-v1",
    version: "1.0.0",
    instrumentIds: input.instrumentIds,
    onBar(bar, context) {
      const held = context.openPositions.some(
        (position) => position.pairAddress === (bar.pairAddress ?? bar.instrumentId),
      );
      if (held) return signal(bar, "HOLD", ["HOLD_POSITION"]);
      if (bar.priceChangeM5Pct === null || bar.priceChangeH1Pct === null) {
        return signal(bar, "HOLD", ["INSUFFICIENT_DATA"]);
      }
      if (
        d(bar.priceChangeM5Pct).gte(context.config.entryM5ChangePct) &&
        d(bar.priceChangeH1Pct).gte(context.config.minH1ChangePct)
      ) {
        return signal(bar, "ENTER_LONG", ["ENTRY_MOMENTUM", "PULSE_SIGNAL"]);
      }
      return signal(bar, "HOLD", ["NO_EDGE"]);
    },
  };
}

export function createMeanRevertFadeStrategy(input: {
  id?: string;
  instrumentIds: string[];
}): StrategyModule {
  return {
    id: input.id ?? "mean-revert-fade-v1",
    version: "1.0.0",
    instrumentIds: input.instrumentIds,
    onBar(bar, context) {
      const held = context.openPositions.some(
        (position) => position.pairAddress === (bar.pairAddress ?? bar.instrumentId),
      );
      if (held && bar.priceChangeM5Pct !== null && d(bar.priceChangeM5Pct).lte(context.config.exitM5ChangePct)) {
        return signal(bar, "EXIT_LONG", ["EXIT_MOMENTUM"]);
      }
      if (held) return signal(bar, "HOLD", ["HOLD_POSITION"]);
      return signal(bar, "HOLD", ["NO_EDGE"]);
    },
  };
}

export const STRATEGY_LIBRARY: StrategyModule[] = [
  createPulseMomentumStrategy({ instrumentIds: ["solana:spot:universe"] }),
  createBreakoutHoldStrategy({
    id: "fx-breakout-v1",
    instrumentIds: ["fx:EURUSD", "fx:GBPUSD"],
  }),
  createBreakoutHoldStrategy({
    id: "etf-breakout-v1",
    instrumentIds: ["etf:SPY", "etf:QQQ"],
  }),
  createMeanRevertFadeStrategy({ instrumentIds: ["solana:spot:universe"] }),
];

export function findStrategyModule(id: string): StrategyModule | undefined {
  return STRATEGY_LIBRARY.find((module) => module.id === id);
}

/**
 * Map a promoted strategy id onto decision intents for a cycle pair.
 * When no module is active, returns null and the hard-coded PULSE path remains.
 */
export function evaluatePromotedStrategy(input: {
  strategyId: string | null | undefined;
  pair: CyclePair;
  config: StrategyConfig;
  heldQty: string;
  history: StrategyBar[];
}): StrategySignal | null {
  if (!input.strategyId) return null;
  const module = findStrategyModule(input.strategyId);
  if (!module) return null;
  const instrumentId = input.pair.pairAddress;
  const allowsUniverse =
    module.instrumentIds.includes("solana:spot:universe") && input.pair.chainId === "solana";
  const allowsExact = module.instrumentIds.includes(instrumentId);
  const allowsClass =
    isPaperMultiMarketPair(input.pair) &&
    module.instrumentIds.some((id) =>
      input.pair.chainId === "fx" ? id.startsWith("fx:") : id.startsWith("etf:"),
    );
  if (!allowsUniverse && !allowsExact && !allowsClass) return null;

  const context: StrategyContext = {
    config: input.config,
    openPositions: d(input.heldQty).gt(0)
      ? [{ instrumentId, pairAddress: input.pair.pairAddress, qty: input.heldQty }]
      : [],
    history: input.history,
  };
  const bar: StrategyBar = {
    instrumentId,
    pairAddress: input.pair.pairAddress,
    receivedAt: input.pair.receivedAt,
    priceUsd: input.pair.priceUsd,
    liquidityUsd: input.pair.liquidityUsd,
    volume24hUsd: input.pair.volume24hUsd,
    priceChangeM5Pct: input.pair.priceChangeM5Pct,
    priceChangeH1Pct: input.pair.priceChangeH1Pct,
    txnsM5Buys: input.pair.txnsM5Buys,
    txnsM5Sells: input.pair.txnsM5Sells,
    dataState: input.pair.freshness,
  };
  return module.onBar(bar, context);
}

function pulseMomentumOnBar(bar: StrategyBar, context: StrategyContext): StrategySignal {
  const held = context.openPositions.some(
    (position) => position.pairAddress === (bar.pairAddress ?? bar.instrumentId),
  );
  if (held) {
    if (bar.priceChangeM5Pct !== null && d(bar.priceChangeM5Pct).lte(context.config.exitM5ChangePct)) {
      return signal(bar, "EXIT_LONG", ["EXIT_MOMENTUM"]);
    }
    return signal(bar, "HOLD", ["HOLD_POSITION"]);
  }
  if (bar.priceChangeM5Pct === null || bar.priceChangeH1Pct === null) {
    return signal(bar, "HOLD", ["INSUFFICIENT_DATA"]);
  }
  if (
    d(bar.priceChangeM5Pct).gte(context.config.entryM5ChangePct) &&
    d(bar.priceChangeH1Pct).gte(context.config.minH1ChangePct)
  ) {
    return signal(bar, "ENTER_LONG", ["ENTRY_MOMENTUM", "PULSE_SIGNAL"]);
  }
  return signal(bar, "HOLD", ["NO_EDGE"]);
}

function signal(
  bar: StrategyBar,
  intent: StrategySignal["intent"],
  reasonCodes: string[],
): StrategySignal {
  return {
    instrumentId: bar.instrumentId,
    pairAddress: bar.pairAddress,
    intent,
    reasonCodes,
  };
}
