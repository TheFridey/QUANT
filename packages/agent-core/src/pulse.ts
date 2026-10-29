import {
  confidenceFixed,
  d,
  isPaperMultiMarketPair,
  isTradableQuote,
  type CyclePair,
  type ObservationPoint,
  type PulseSignal,
  type ReasonCode,
  type StrategyConfig,
  Decimal,
} from "@odin/shared";
import { evaluatePromotedStrategy } from "./strategy-library.js";
import { MODEL_VERSIONS } from "./versions.js";
import type { DecisionDraft, PlanInput, PositionView } from "./types.js";

/** Historical indicators from timestamped observations. Never fabricates missing history. */
export function computePulseSignal(
  pairAddress: string,
  history: ObservationPoint[],
  minObservations: number,
): PulseSignal {
  const started = history.length;
  const limitations: string[] = [];
  const reasonCodes: ReasonCode[] = [];
  if (history.length < minObservations) {
    limitations.push(`Need at least ${minObservations} observations; have ${history.length}`);
    reasonCodes.push("INSUFFICIENT_HISTORY");
    return emptySignal(pairAddress, history.length, limitations, reasonCodes);
  }

  const ordered = [...history].sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
  const volumes = ordered.map((row) => (row.volume5mUsd ? d(row.volume5mUsd) : null));
  const prices = ordered.map((row) => (row.priceUsd ? d(row.priceUsd) : null));
  const liquidities = ordered.map((row) => (row.liquidityUsd ? d(row.liquidityUsd) : null));

  const volumeAcceleration = ratioChange(volumes);
  const relativeVolume = relativeToMean(volumes);
  const buySellImbalance = imbalance(ordered);
  const momentum = priceMomentum(prices);
  const volatility = priceVolatility(prices);
  const liquidityChange = ratioChange(liquidities);
  const priceVolumeDivergence = divergence(prices, volumes);
  const trendPersistence = persistence(prices);
  const manipulationWarning = detectManipulation(prices, volumes);

  if (volumeAcceleration === null) limitations.push("volumeAcceleration requires consecutive volume5mUsd");
  if (relativeVolume === null) limitations.push("relativeVolume requires volume5mUsd series");
  if (buySellImbalance === null) limitations.push("buySellImbalance requires txn counts");
  if (momentum === null) limitations.push("momentum requires priceUsd series");
  if (volatility === null) limitations.push("volatility requires priceUsd series");
  if (liquidityChange === null) limitations.push("liquidityChange requires liquidityUsd series");
  if (priceVolumeDivergence === null) limitations.push("priceVolumeDivergence requires aligned price and volume");
  if (trendPersistence === null) limitations.push("trendPersistence requires priceUsd series");

  if (manipulationWarning) reasonCodes.push("MANIPULATION_WARNING");
  if (volumeAcceleration !== null) reasonCodes.push("VOLUME_ACCELERATION");
  if (relativeVolume !== null) reasonCodes.push("RELATIVE_VOLUME");
  if (buySellImbalance !== null) reasonCodes.push("BUY_SELL_IMBALANCE");
  reasonCodes.push("PULSE_SIGNAL");
  if (limitations.length > 0) reasonCodes.push("INSUFFICIENT_DATA");

  const parts = [volumeAcceleration, relativeVolume, buySellImbalance, momentum, trendPersistence].filter(
    (value): value is Decimal => value !== null,
  );
  const score =
    parts.length === 0
      ? null
      : confidenceFixed(parts.reduce((sum, value) => sum.plus(value), new Decimal(0)).div(parts.length));

  return {
    pairAddress,
    score,
    confidence: score ?? "0.000000",
    evidence: {
      sampleSize: started,
      latestReceivedAt: ordered.at(-1)?.receivedAt ?? null,
    },
    limitations,
    reasonCodes,
    indicators: {
      volumeAcceleration: volumeAcceleration?.toFixed(6) ?? null,
      relativeVolume: relativeVolume?.toFixed(6) ?? null,
      buySellImbalance: buySellImbalance?.toFixed(6) ?? null,
      momentum: momentum?.toFixed(6) ?? null,
      volatility: volatility?.toFixed(6) ?? null,
      liquidityChange: liquidityChange?.toFixed(6) ?? null,
      priceVolumeDivergence: priceVolumeDivergence?.toFixed(6) ?? null,
      trendPersistence: trendPersistence?.toFixed(6) ?? null,
      manipulationWarning,
    },
    sampleSize: started,
  };
}

export function runPulse(
  pair: CyclePair,
  position: PositionView | undefined,
  surveillance: DecisionDraft,
  input: PlanInput,
): DecisionDraft {
  const started = Date.now();
  const history = input.observationHistory?.[pair.pairAddress] ?? [];
  const signal = computePulseSignal(pair.pairAddress, history, input.config.pulseMinObservations);
  const held = position !== undefined && d(position.baseQty).gt(0);

  const baseMeta = {
    inputSource: history.length > 0 ? "observations+quote" : "quote",
    durationMs: 0,
  };

  if (input.operator && input.operator.pairAddress !== pair.pairAddress) {
    return draft(pair, "HOLD", ["NO_INTENT"], "1.000000", {}, signal, started, baseMeta.inputSource);
  }
  if (input.operator?.pairAddress === pair.pairAddress) {
    if (input.operator.side === "SELL") {
      if (!held) return draft(pair, "REJECT", ["NO_POSITION"], "1.000000", { side: "SELL", intent: "OPERATOR" }, signal, started, baseMeta.inputSource);
      return draft(pair, "ACT", ["OPERATOR_OVERRIDE", "FULL_POSITION_EXIT"], "1.000000", { side: "SELL", intent: "OPERATOR" }, signal, started, baseMeta.inputSource);
    }
    if (held) return draft(pair, "HOLD", ["ALREADY_HELD"], "1.000000", {}, signal, started, baseMeta.inputSource);
    return draft(pair, "ACT", ["OPERATOR_OVERRIDE"], "1.000000", { side: "BUY", intent: "OPERATOR" }, signal, started, baseMeta.inputSource);
  }
  if (input.flatten) {
    if (!held) return draft(pair, "HOLD", ["NO_INTENT"], "1.000000", {}, signal, started, baseMeta.inputSource);
    return draft(pair, "ACT", ["FULL_POSITION_EXIT"], "1.000000", { side: "SELL", intent: "FLATTEN" }, signal, started, baseMeta.inputSource);
  }

  // Strategy-instance intents are planned individually in planCycle (many per pair allowed).
  // When instances are the entry authority, global PULSE never invents unrelated auto-entries.
  const instanceGatingActive = input.instanceIntents != null;

  // Promoted strategy modules can drive intents when an activeStrategyId is set.
  const promoted = evaluatePromotedStrategy({
    strategyId: input.activeStrategyId,
    pair,
    config: input.config,
    heldQty: position?.baseQty ?? "0",
    history: (input.observationHistory?.[pair.pairAddress] ?? []).map((row) => ({
      instrumentId: pair.pairAddress,
      pairAddress: pair.pairAddress,
      receivedAt: row.receivedAt,
      priceUsd: row.priceUsd,
      liquidityUsd: row.liquidityUsd,
      volume24hUsd: row.volume24hUsd,
      priceChangeM5Pct: row.priceChangeM5Pct,
      priceChangeH1Pct: null,
      txnsM5Buys: row.txnsM5Buys,
      txnsM5Sells: row.txnsM5Sells,
      dataState: pair.freshness,
    })),
  });
  if (promoted) {
    if (promoted.intent === "EXIT_LONG" && held) {
      return draft(
        pair,
        "ACT",
        ["FULL_POSITION_EXIT", ...(promoted.reasonCodes as never[])],
        "1.000000",
        { side: "SELL", intent: "EXIT", strategyId: input.activeStrategyId, signal },
        signal,
        started,
        `strategy:${input.activeStrategyId}`,
      );
    }
    if (promoted.intent === "ENTER_LONG" && !held && surveillance.decision !== "REJECT") {
      if (instanceGatingActive) {
        return draft(
          pair,
          "HOLD",
          ["NO_INTENT", "STRATEGY_INSTANCE_GATING"],
          "1.000000",
          { strategyId: input.activeStrategyId, signal },
          signal,
          started,
          `strategy:${input.activeStrategyId}`,
        );
      }
      return draft(
        pair,
        "ACT",
        ["ENTRY_MOMENTUM", "PULSE_SIGNAL", ...(promoted.reasonCodes as never[])],
        "1.000000",
        { side: "BUY", intent: "ENTRY", strategyId: input.activeStrategyId, signal },
        signal,
        started,
        `strategy:${input.activeStrategyId}`,
      );
    }
    // D12: promoted HOLD must not bypass invariant stop/target/time exits.
    // Fall through to held-position checks when a position is open.
    if ((promoted.intent === "HOLD" || promoted.intent === "RESEARCH_NOTE") && !held) {
      return draft(
        pair,
        "HOLD",
        promoted.reasonCodes as never[],
        "1.000000",
        { strategyId: input.activeStrategyId, signal },
        signal,
        started,
        `strategy:${input.activeStrategyId}`,
      );
    }
  }

  if (!held && surveillance.decision === "REJECT") {
    return draft(pair, "HOLD", ["BLOCKED_BY_SENTINEL"], "1.000000", { signal }, signal, started, baseMeta.inputSource);
  }
  if (held && position) {
    if (pair.priceUsd === null || d(pair.priceUsd).lte(0) || d(position.avgCostUsd).lte(0)) {
      return draft(pair, "HOLD", ["MARK_UNAVAILABLE"], "0.000000", { signal }, signal, started, baseMeta.inputSource);
    }
    const pnlPct = d(pair.priceUsd).minus(d(position.avgCostUsd)).div(d(position.avgCostUsd)).mul(100);
    if (pnlPct.lte(d(input.config.stopLossPct).neg())) {
      return draft(pair, "ACT", ["STOP_LOSS"], "1.000000", { side: "SELL", intent: "EXIT", pnlPct: pnlPct.toFixed(4), signal }, signal, started, baseMeta.inputSource);
    }
    if (pnlPct.gte(input.config.takeProfitPct)) {
      return draft(pair, "ACT", ["TAKE_PROFIT"], "1.000000", { side: "SELL", intent: "EXIT", pnlPct: pnlPct.toFixed(4), signal }, signal, started, baseMeta.inputSource);
    }
    const peak = position.peakMarkUsd && d(position.peakMarkUsd).gt(0) ? d(position.peakMarkUsd) : d(pair.priceUsd);
    if (input.config.trailingStopPct !== null && peak.gt(0)) {
      const drop = peak.minus(d(pair.priceUsd)).div(peak).mul(100);
      if (drop.gte(input.config.trailingStopPct)) {
        return draft(
          pair,
          "ACT",
          ["TRAILING_STOP"],
          "1.000000",
          { side: "SELL", intent: "EXIT", peakMarkUsd: peak.toFixed(8), signal },
          signal,
          started,
          baseMeta.inputSource,
        );
      }
    }
    if (input.config.maxHoldingMs !== null && position.openedAt) {
      const heldMs = Date.parse(pair.receivedAt) - Date.parse(position.openedAt);
      if (Number.isFinite(heldMs) && heldMs >= input.config.maxHoldingMs) {
        return draft(
          pair,
          "ACT",
          ["TIME_EXIT", "MAX_HOLDING"],
          "1.000000",
          { side: "SELL", intent: "EXIT", heldMs, signal },
          signal,
          started,
          baseMeta.inputSource,
        );
      }
    }
    // Momentum exits are a strategy decision: with instance gating each owner decides its own exit.
    if (
      !instanceGatingActive &&
      pair.priceChangeM5Pct !== null &&
      d(pair.priceChangeM5Pct).lte(input.config.exitM5ChangePct)
    ) {
      return draft(pair, "ACT", ["EXIT_MOMENTUM"], "1.000000", { side: "SELL", intent: "EXIT", signal }, signal, started, baseMeta.inputSource);
    }
    return draft(pair, "HOLD", ["HOLD_POSITION"], "1.000000", { signal }, signal, started, baseMeta.inputSource);
  }

  if (signal.indicators.manipulationWarning) {
    return draft(pair, "HOLD", ["MANIPULATION_WARNING", ...signal.reasonCodes], signal.confidence, { signal }, signal, started, baseMeta.inputSource);
  }

  if (pair.priceChangeM5Pct === null || pair.priceChangeH1Pct === null) {
    return draft(pair, "HOLD", ["INSUFFICIENT_DATA", ...signal.reasonCodes.filter((code) => code !== "PULSE_SIGNAL")], "0.000000", { signal }, signal, started, baseMeta.inputSource);
  }
  if (!isTradableQuote(pair.quoteAddress)) {
    return draft(pair, "HOLD", ["QUOTE_NOT_ALLOWED"], "1.000000", { signal }, signal, started, baseMeta.inputSource);
  }
  if (d(pair.priceChangeM5Pct).abs().gt(input.config.maxEntryM5ChangePct)) {
    return draft(pair, "HOLD", ["PRICE_ANOMALY"], "1.000000", { priceChangeM5Pct: pair.priceChangeM5Pct, signal }, signal, started, baseMeta.inputSource);
  }
  // When concurrent instances gate entries, empty/missing attributed ENTER ≠ global auto-entry.
  if (instanceGatingActive) {
    return draft(
      pair,
      "HOLD",
      ["NO_INTENT", "STRATEGY_INSTANCE_GATING", ...signal.reasonCodes.filter((code) => code !== "PULSE_SIGNAL")],
      "1.000000",
      { signal },
      signal,
      started,
      baseMeta.inputSource,
    );
  }

  // Paper FX/ETF: momentum thresholds without Solana buy/sell txn counts.
  const multiMarket = isPaperMultiMarketPair(pair);
  if (multiMarket) {
    const entry =
      d(pair.priceChangeM5Pct).gte(input.config.entryM5ChangePct) &&
      d(pair.priceChangeH1Pct).gte(input.config.minH1ChangePct);
    if (!entry) return draft(pair, "HOLD", ["NO_EDGE", ...signal.reasonCodes], "1.000000", { signal }, signal, started, baseMeta.inputSource);
    return draft(pair, "ACT", ["ENTRY_MOMENTUM", "PULSE_SIGNAL", "PAPER_FX"], "0.700000", { side: "BUY", intent: "ENTRY", signal, market: pair.chainId }, signal, started, baseMeta.inputSource);
  }
  if (pair.txnsM5Buys === null || pair.txnsM5Sells === null) {
    return draft(pair, "HOLD", ["INSUFFICIENT_DATA", ...signal.reasonCodes.filter((code) => code !== "PULSE_SIGNAL")], "0.000000", { signal }, signal, started, baseMeta.inputSource);
  }
  const entry =
    d(pair.priceChangeM5Pct).gte(input.config.entryM5ChangePct) &&
    d(pair.priceChangeH1Pct).gte(input.config.minH1ChangePct) &&
    pair.txnsM5Buys > pair.txnsM5Sells;
  if (!entry) return draft(pair, "HOLD", ["NO_EDGE", ...signal.reasonCodes], "1.000000", { signal }, signal, started, baseMeta.inputSource);

  const threshold = d(input.config.entryM5ChangePct);
  const confidence = threshold.eq(0)
    ? "1.000000"
    : confidenceFixed(Decimal.min(new Decimal(1), Decimal.max(new Decimal(0), d(pair.priceChangeM5Pct).minus(threshold).div(threshold))));
  return draft(pair, "ACT", ["ENTRY_MOMENTUM", "PULSE_SIGNAL"], confidence, { side: "BUY", intent: "ENTRY", signal }, signal, started, baseMeta.inputSource);
}

function draft(
  pair: CyclePair,
  decision: DecisionDraft["decision"],
  reasonCodes: ReasonCode[],
  confidence: string,
  output: Record<string, unknown>,
  signal: PulseSignal,
  started: number,
  inputSource: string,
): DecisionDraft {
  return {
    agent: "PULSE",
    modelVersion: MODEL_VERSIONS.PULSE,
    pairAddress: pair.pairAddress,
    decision,
    confidence,
    reasonCodes,
    input: {
      observationId: pair.observationId,
      freshness: pair.freshness,
      sampleSize: signal.sampleSize,
      limitations: signal.limitations,
    },
    output,
    inputSource,
    durationMs: Date.now() - started,
  };
}

function emptySignal(
  pairAddress: string,
  sampleSize: number,
  limitations: string[],
  reasonCodes: ReasonCode[],
): PulseSignal {
  return {
    pairAddress,
    score: null,
    confidence: "0.000000",
    evidence: { sampleSize },
    limitations,
    reasonCodes,
    indicators: {
      volumeAcceleration: null,
      relativeVolume: null,
      buySellImbalance: null,
      momentum: null,
      volatility: null,
      liquidityChange: null,
      priceVolumeDivergence: null,
      trendPersistence: null,
      manipulationWarning: false,
    },
    sampleSize,
  };
}

function ratioChange(values: Array<Decimal | null>): Decimal | null {
  const usable = values.filter((value): value is Decimal => value !== null);
  if (usable.length < 2) return null;
  const prev = usable.at(-2)!;
  const last = usable.at(-1)!;
  if (prev.eq(0)) return null;
  return Decimal.max(new Decimal(-1), Decimal.min(new Decimal(1), last.minus(prev).div(prev)));
}

function relativeToMean(values: Array<Decimal | null>): Decimal | null {
  const usable = values.filter((value): value is Decimal => value !== null);
  if (usable.length < 2) return null;
  const mean = usable.reduce((sum, value) => sum.plus(value), new Decimal(0)).div(usable.length);
  if (mean.eq(0)) return null;
  const last = usable.at(-1)!;
  return Decimal.max(new Decimal(0), Decimal.min(new Decimal(1), last.div(mean).minus(1).div(2).plus(0.5)));
}

function imbalance(rows: ObservationPoint[]): Decimal | null {
  const last = rows.at(-1);
  if (!last || last.txnsM5Buys === null || last.txnsM5Sells === null) return null;
  const total = last.txnsM5Buys + last.txnsM5Sells;
  if (total === 0) return null;
  return new Decimal(last.txnsM5Buys - last.txnsM5Sells).div(total);
}

function priceMomentum(prices: Array<Decimal | null>): Decimal | null {
  const usable = prices.filter((value): value is Decimal => value !== null);
  if (usable.length < 2) return null;
  const first = usable[0]!;
  const last = usable.at(-1)!;
  if (first.eq(0)) return null;
  return Decimal.max(new Decimal(-1), Decimal.min(new Decimal(1), last.minus(first).div(first)));
}

function priceVolatility(prices: Array<Decimal | null>): Decimal | null {
  const usable = prices.filter((value): value is Decimal => value !== null);
  if (usable.length < 3) return null;
  const returns: Decimal[] = [];
  for (let i = 1; i < usable.length; i += 1) {
    if (usable[i - 1]!.eq(0)) continue;
    returns.push(usable[i]!.minus(usable[i - 1]!).div(usable[i - 1]!));
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((sum, value) => sum.plus(value), new Decimal(0)).div(returns.length);
  const variance = returns.reduce((sum, value) => sum.plus(value.minus(mean).pow(2)), new Decimal(0)).div(returns.length);
  return Decimal.min(new Decimal(1), variance.sqrt());
}

function divergence(prices: Array<Decimal | null>, volumes: Array<Decimal | null>): Decimal | null {
  const mom = priceMomentum(prices);
  const vol = ratioChange(volumes);
  if (mom === null || vol === null) return null;
  return mom.minus(vol);
}

function persistence(prices: Array<Decimal | null>): Decimal | null {
  const usable = prices.filter((value): value is Decimal => value !== null);
  if (usable.length < 3) return null;
  let same = 0;
  let total = 0;
  for (let i = 2; i < usable.length; i += 1) {
    const a = usable[i - 1]!.minus(usable[i - 2]!);
    const b = usable[i]!.minus(usable[i - 1]!);
    if (a.eq(0) || b.eq(0)) continue;
    total += 1;
    if (a.s === b.s) same += 1;
  }
  if (total === 0) return null;
  return new Decimal(same).div(total);
}

function detectManipulation(prices: Array<Decimal | null>, volumes: Array<Decimal | null>): boolean {
  const mom = priceMomentum(prices);
  const vol = ratioChange(volumes);
  if (mom === null || vol === null) return false;
  // Large absolute price move with collapsing volume is a warning, not a fill.
  return mom.abs().gte("0.2") && vol.lte("-0.5");
}

export function pulsePassesConfig(_config: StrategyConfig): boolean {
  return true;
}
