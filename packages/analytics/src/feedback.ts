import { DEFAULT_STRATEGY, Decimal, d, usd } from "@odin/shared";
import { collectTimestamps, viewHash, type PitObservation, type PointInTimeView } from "./entry-view.js";
import { lotExcursion, type Lot, type LotExcursion, type MarkObservation } from "./lot-history.js";

/**
 * GENESIS Phase 7: trade feedback evidence built from ASCEND-09 trade memory. Pure and read-only.
 *
 * Every per-lot record is split in two, and the split is the point of this module:
 *
 * - `decisionRecord`: only what QUANT knew at the entry fill, taken from the **stored** ENTRY snapshot
 *   (`TradeLotSnapshot.view`). It is never rebuilt from current rows. A snapshot whose hash, identity or
 *   temporal boundary does not check out is not used (`decisionRecordState` says why) and the record is
 *   null. Every timestamp in it is at or before `decisionRecord.asOf` (the entry fill time).
 * - `retrospective`: the realised outcome and everything computed with hindsight. Marks inside the
 *   holding window go to `inTrade`; marks after the exit go to `postExit` and only there.
 *
 * Feedback rows carry `source` (OBSERVED_FILL for lots rebuilt from fills, HYPOTHETICAL for
 * counterfactual non-trades) and `derivedFromOwnPrediction`. `buildTrainingData` refuses any row whose
 * label derives from QUANT's own predictions and never mixes hypothetical rows into observed ones.
 *
 * Classification is a set of explicit, factual rules (see FEEDBACK_RULES and `classifyLot`), not a
 * causal claim. Nothing here feeds back into a running engine, risk limits or promotion.
 */

export const FEEDBACK_VERSION = "feedback-1.0.0";

export type FeedbackSource = "OBSERVED_FILL" | "HYPOTHETICAL";
/** Where a row's label comes from. QUANT_PREDICTION labels are refused for training. */
export type LabelOrigin = "REALISED_LEDGER" | "MARKET_BARS" | "QUANT_PREDICTION";

export type ErrorClass =
  | "SIGNAL_ERROR"
  | "EXECUTION_COST_ERROR"
  | "SIZING_ERROR"
  | "REGIME_MISMATCH"
  | "EXIT_TIMING"
  | "TURNOVER"
  | "UNATTRIBUTED"
  | "NO_ERROR";

/** Primary class priority for losing lots: the first rule that matches wins; every match is listed. */
export const LOSS_CLASS_PRIORITY: readonly ErrorClass[] = [
  "EXECUTION_COST_ERROR",
  "TURNOVER",
  "EXIT_TIMING",
  "SIZING_ERROR",
  "REGIME_MISMATCH",
  "SIGNAL_ERROR",
];

/** Thresholds for the classification rules and buckets. Percentages are in percent (2 = 2 %). */
export const FEEDBACK_RULES = {
  /** EXECUTION_COST_ERROR: realised comparable cost exceeds expected by more than this share of expected… */
  costExcessRatio: "0.5",
  /** …and by more than this many bps of entry notional (materiality floor). */
  costExcessMinBps: "10",
  /** EXIT_TIMING (in-trade): MFE at least this large, yet the lot closed at a loss. */
  exitTimingMfePct: "2",
  /** SIGNAL_ERROR: MFE below this: the trade never moved meaningfully in favour. */
  signalMaxMfePct: "0.5",
  /** SIZING_ERROR: entry notional above this share of entry liquidity (half the default participation cap). */
  sizingLiquiditySharePct: d(DEFAULT_STRATEGY.maxParticipationPctLiquidity).div(2).toString(),
  /** Regime proxy: |priceChangeH1| at entry at or above this is a trend. */
  regimeTrendH1Pct: "2",
  /** Volatility proxy: |priceChangeM5| at entry. */
  volatilityLowM5Pct: "1",
  volatilityHighM5Pct: "3",
  /** Liquidity buckets (USD at entry). */
  liquidityLowUsd: "50000",
  liquidityHighUsd: "250000",
  /** Post-exit horizon for the retrospective stop-recovery check. */
  postExitHorizonSeconds: 4 * 3600,
  /** Aggregation buckets with fewer closed lots than this are flagged smallSample. */
  minSample: 10,
} as const;

const RULE_TEXT = [
  "Only CLOSED lots are classified; OPEN lots have no retrospective.",
  "A lot with realised net P&L >= 0 is NO_ERROR (EXECUTION_COST_ERROR may still be listed as a secondary match).",
  `Losing lots: first match in ${LOSS_CLASS_PRIORITY.join(" > ")}; UNATTRIBUTED when none match.`,
  `EXECUTION_COST_ERROR: realised comparable cost (fees, plus slippage when an expected slippage was recorded) exceeds expected by > ${FEEDBACK_RULES.costExcessRatio}x expected and > ${FEEDBACK_RULES.costExcessMinBps} bps of entry notional; primary only when the excess alone explains the loss.`,
  "TURNOVER: the mid-to-mid price move was smaller in magnitude than realised costs (fees + slippage), so costs decided the outcome.",
  `EXIT_TIMING: in-trade MFE >= ${FEEDBACK_RULES.exitTimingMfePct}% yet closed at a loss (IN_TRADE), or a STOP_LOSS/TRAILING_STOP exit after which price recovered to the entry fill price within ${FEEDBACK_RULES.postExitHorizonSeconds}s (POST_EXIT, hindsight).`,
  `SIZING_ERROR: entry notional > ${FEEDBACK_RULES.sizingLiquiditySharePct}% of entry liquidity (decision record), or an ADD priced below the entry fill price (averaging down).`,
  `REGIME_MISMATCH: long entry while the entry regime proxy (priceChangeH1 <= -${FEEDBACK_RULES.regimeTrendH1Pct}%) was TREND_DOWN.`,
  `SIGNAL_ERROR: in-trade marks exist and MFE < ${FEEDBACK_RULES.signalMaxMfePct}%: price never moved meaningfully in favour.`,
  "Expected net outcome: QUANT records no return forecast at entry, so expected gross edge is NOT_RECORDED; only expected costs are compared.",
  "Regime / volatility / liquidity buckets use only the decision record (entry snapshot); UNKNOWN without one.",
];

// ---------------------------------------------------------------------------------------------------
// Decision record (point in time)
// ---------------------------------------------------------------------------------------------------

/** A stored ENTRY row of TradeLotSnapshot, as read by the API. */
export type StoredEntrySnapshot = {
  id: string;
  accountId: string;
  fillId: string;
  entryFillId: string;
  phase: string;
  asOf: string;
  viewHash: string;
  view: unknown;
};

export type DecisionRecordState =
  | "RECORDED"
  | "NOT_RECORDED_YET"
  | "HASH_MISMATCH"
  | "IDENTITY_MISMATCH"
  | "TEMPORAL_BOUNDARY_VIOLATED";

export type RegimeBucket = "TREND_UP" | "TREND_DOWN" | "RANGE" | "UNKNOWN";
export type LevelBucket = "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";

export type DecisionRecord = {
  /** Entry fill time: no timestamp in this record is later. */
  asOf: string;
  snapshotId: string;
  viewHash: string;
  builderVersion: string;
  pairAddress: string;
  strategyInstanceId: string | null;
  strategyVersion: string | null;
  /** Distinct model versions of the cycle's decisions recorded at entry, sorted. */
  modelVersions: string[];
  configHash: string | null;
  entry: { side: "BUY" | "SELL"; qty: string; priceUsd: string; notionalUsd: string; liquidityUsd: string; at: string };
  market: {
    observationId: string | null;
    observedAt: string | null;
    freshness: string | null;
    priceUsd: string | null;
    liquidityUsd: string | null;
    volume24hUsd: string | null;
    priceChangeM5Pct: string | null;
    priceChangeH1Pct: string | null;
  };
  buckets: { regime: RegimeBucket; volatility: LevelBucket; liquidity: LevelBucket };
  expected: {
    /** Expected fee rate (bps of notional) from the EXECUTOR decision or the cycle plan; null when not recorded. */
    feeBps: string | null;
    feeBasis: "EXECUTOR_FEE" | "PLAN_COST_MINUS_NOTIONAL" | "NOT_RECORDED";
    /** Expected slippage (bps) from the EXECUTOR decision; null when not recorded. */
    slippageBps: string | null;
    /** QUANT records no return forecast at entry. */
    grossEdgeState: "NOT_RECORDED";
  };
  decisions: Array<{ agent: string; modelVersion: string; decision: string; confidence: string; reasonCodes: string[]; at: string }>;
  decisionUnavailable: boolean;
};

const pctOf = (value: string | null | undefined) => (value == null || value === "" ? null : d(value));

function regimeBucket(h1: Decimal | null): RegimeBucket {
  if (h1 === null) return "UNKNOWN";
  const trend = d(FEEDBACK_RULES.regimeTrendH1Pct);
  if (h1.gte(trend)) return "TREND_UP";
  if (h1.lte(trend.neg())) return "TREND_DOWN";
  return "RANGE";
}

function volatilityBucket(m5: Decimal | null): LevelBucket {
  if (m5 === null) return "UNKNOWN";
  const abs = m5.abs();
  if (abs.lt(d(FEEDBACK_RULES.volatilityLowM5Pct))) return "LOW";
  if (abs.lt(d(FEEDBACK_RULES.volatilityHighM5Pct))) return "MEDIUM";
  return "HIGH";
}

function liquidityBucket(value: Decimal | null): LevelBucket {
  if (value === null || value.lte(0)) return "UNKNOWN";
  if (value.lt(d(FEEDBACK_RULES.liquidityLowUsd))) return "LOW";
  if (value.lt(d(FEEDBACK_RULES.liquidityHighUsd))) return "MEDIUM";
  return "HIGH";
}

function bps(numerator: Decimal, denominator: Decimal): string | null {
  return denominator.lte(0) ? null : numerator.div(denominator).mul(10_000).toDecimalPlaces(4).toFixed(4);
}

/**
 * Decision record from a stored ENTRY snapshot. Returns null with a reason when there is no snapshot or
 * it fails any check: re-hash, identity (fill, lot, account, phase, asOf) or temporal boundary (any
 * timestamp later than asOf). Never falls back to current rows.
 */
export function decisionRecordFromSnapshot(
  snapshot: StoredEntrySnapshot | null,
  lot: Pick<Lot, "entryFillId" | "accountId" | "pairAddress">,
): { state: DecisionRecordState; record: DecisionRecord | null } {
  if (!snapshot) return { state: "NOT_RECORDED_YET", record: null };
  const view = snapshot.view as PointInTimeView;
  if (!view || typeof view !== "object" || viewHash(view) !== snapshot.viewHash) return { state: "HASH_MISMATCH", record: null };
  const identity =
    snapshot.phase === "ENTRY" &&
    view.phase === "ENTRY" &&
    view.asOf === snapshot.asOf &&
    view.fill?.id === snapshot.fillId &&
    snapshot.fillId === lot.entryFillId &&
    view.entryFillId === lot.entryFillId &&
    view.accountId === lot.accountId &&
    snapshot.accountId === lot.accountId;
  if (!identity) return { state: "IDENTITY_MISMATCH", record: null };
  const limit = Date.parse(view.asOf);
  if (collectTimestamps(view).some((item) => Date.parse(item.at) > limit)) return { state: "TEMPORAL_BOUNDARY_VIOLATED", record: null };

  const observation = view.decisionObservation ?? view.fillObservation;
  const executor = view.estimatedCost.executorDecision;
  const estNotional = pctOf(view.estimatedCost.estimatedNotionalUsd);
  const estCost = pctOf(view.estimatedCost.estimatedCostUsd);
  let feeBps: string | null = null;
  let feeBasis: DecisionRecord["expected"]["feeBasis"] = "NOT_RECORDED";
  const executorNotional = pctOf(executor?.notionalUsd) ?? estNotional;
  if (executor?.feeUsd !== undefined && executorNotional !== null) {
    feeBps = bps(d(executor.feeUsd), executorNotional);
    feeBasis = feeBps === null ? "NOT_RECORDED" : "EXECUTOR_FEE";
  } else if (view.fill.side === "BUY" && estCost !== null && estNotional !== null && estCost.gte(estNotional)) {
    // For a BUY the planner's estimatedCostUsd is notional + fee (agent-core plan.ts).
    feeBps = bps(estCost.minus(estNotional), estNotional);
    feeBasis = feeBps === null ? "NOT_RECORDED" : "PLAN_COST_MINUS_NOTIONAL";
  }
  const liquidity = pctOf(observation?.liquidityUsd) ?? pctOf(view.fill.liquidityUsd);
  const record: DecisionRecord = {
    asOf: view.asOf,
    snapshotId: snapshot.id,
    viewHash: snapshot.viewHash,
    builderVersion: view.builderVersion,
    pairAddress: lot.pairAddress,
    strategyInstanceId: view.strategy.strategyInstanceId,
    strategyVersion: view.strategy.strategyVersion,
    modelVersions: [...new Set(view.decisions.map((row) => row.modelVersion))].sort(),
    configHash: view.config.configHash,
    entry: {
      side: view.fill.side,
      qty: view.fill.qty,
      priceUsd: view.fill.priceUsd,
      notionalUsd: view.fill.notionalUsd,
      liquidityUsd: view.fill.liquidityUsd,
      at: view.fill.at,
    },
    market: {
      observationId: observation?.id ?? null,
      observedAt: observation?.receivedAt ?? null,
      freshness: observation?.freshness ?? null,
      priceUsd: observation?.priceUsd ?? null,
      liquidityUsd: observation?.liquidityUsd ?? null,
      volume24hUsd: observation?.volume24hUsd ?? null,
      priceChangeM5Pct: observation?.priceChangeM5 ?? null,
      priceChangeH1Pct: observation?.priceChangeH1 ?? null,
    },
    buckets: {
      regime: regimeBucket(pctOf(observation?.priceChangeH1)),
      volatility: volatilityBucket(pctOf(observation?.priceChangeM5)),
      liquidity: liquidityBucket(liquidity),
    },
    expected: {
      feeBps,
      feeBasis,
      slippageBps: executor?.slippageBps ?? null,
      grossEdgeState: "NOT_RECORDED",
    },
    decisions: view.decisions.map((row) => ({
      agent: row.agent,
      modelVersion: row.modelVersion,
      decision: row.decision,
      confidence: row.confidence,
      reasonCodes: row.reasonCodes,
      at: row.createdAt,
    })),
    decisionUnavailable: view.decisionUnavailable,
  };
  return { state: "RECORDED", record };
}

// ---------------------------------------------------------------------------------------------------
// Retrospective (hindsight)
// ---------------------------------------------------------------------------------------------------

export type HoldingBucket = "LT_5M" | "5M_1H" | "1H_4H" | "4H_24H" | "GTE_24H";

export function holdingBucket(seconds: number): HoldingBucket {
  if (seconds < 300) return "LT_5M";
  if (seconds < 3600) return "5M_1H";
  if (seconds < 4 * 3600) return "1H_4H";
  if (seconds < 24 * 3600) return "4H_24H";
  return "GTE_24H";
}

export type PostExitWindow = {
  /** Hindsight only: marks strictly after the exit, up to closedAt + horizon (and asOf). */
  basis: "POST_EXIT_HINDSIGHT";
  windowStart: string;
  windowEnd: string;
  horizonSeconds: number;
  horizonComplete: boolean;
  observations: number;
  highUsd: string | null;
  lowUsd: string | null;
  /** True when a mark at or above the entry fill price arrived within the horizon. */
  recoveredToEntry: boolean | null;
  firstRecoveryAt: string | null;
};

export type ClassificationMatch = { class: ErrorClass; rule: string; dataBasis: "DECISION_RECORD" | "IN_TRADE" | "POST_EXIT" | "REALISED"; evidence: Record<string, string | number | boolean | null> };

export type LotClassification = {
  primary: ErrorClass;
  matched: ClassificationMatch[];
  /** Rules that could not be evaluated for lack of data. */
  notEvaluable: string[];
};

export type Retrospective = {
  closedAt: string;
  holdingSeconds: number;
  holdingBucket: HoldingBucket;
  exitReason: string;
  exitReasonSource: string;
  realised: {
    netPnlUsd: string;
    feesUsd: string;
    slippageUsd: string;
    costUsd: string;
    /** netPnlUsd + fees + slippage: the price move at mid. */
    midMovePnlUsd: string;
    entryNotionalUsd: string;
    exitNotionalUsd: string;
    /** netPnlUsd / entry notional × 100. */
    returnPct: string | null;
  };
  expectedVsRealised: {
    /** No return forecast is recorded at entry, so expected net is unavailable. */
    expectedNetUsd: null;
    expectedNetState: "NO_FORECAST_RECORDED";
    realisedNetUsd: string;
    costComparison: "FEES_AND_SLIPPAGE" | "FEES_ONLY" | "NOT_COMPARABLE";
    expectedCostUsd: string | null;
    realisedComparableCostUsd: string | null;
    costExcessUsd: string | null;
  };
  inTrade: LotExcursion;
  postExit: PostExitWindow;
  classification: LotClassification;
};

export type LotFeedback = {
  lotKey: string;
  source: "OBSERVED_FILL";
  labelOrigin: "REALISED_LEDGER";
  derivedFromOwnPrediction: false;
  accountId: string;
  pairAddress: string;
  status: "OPEN" | "CLOSED";
  openedAt: string;
  strategyInstanceId: string | null;
  strategyVersion: string | null;
  decisionRecordState: DecisionRecordState;
  decisionRecord: DecisionRecord | null;
  retrospectiveState: "CLOSED" | "LOT_OPEN";
  retrospective: Retrospective | null;
  marksTruncated: boolean;
};

const ZERO = new Decimal(0);

function postExitWindow(lot: Lot, marks: readonly MarkObservation[], asOf: string, horizonSeconds: number): PostExitWindow {
  const start = Date.parse(lot.closedAt!);
  const horizonEnd = start + horizonSeconds * 1000;
  const asOfMs = Date.parse(asOf);
  const end = Math.min(horizonEnd, asOfMs);
  const entry = d(lot.entryPriceUsd);
  let hi: Decimal | null = null;
  let lo: Decimal | null = null;
  let count = 0;
  let firstRecoveryAt: string | null = null;
  const sorted = [...marks].sort((left, right) => Date.parse(left.receivedAt) - Date.parse(right.receivedAt));
  for (const row of sorted) {
    if (row.pairAddress !== lot.pairAddress || row.priceUsd === null) continue;
    const at = Date.parse(row.receivedAt);
    if (!(at > start && at <= end)) continue;
    const price = d(row.priceUsd);
    if (price.lte(0)) continue;
    count += 1;
    hi = hi === null || price.gt(hi) ? price : hi;
    lo = lo === null || price.lt(lo) ? price : lo;
    if (firstRecoveryAt === null && price.gte(entry)) firstRecoveryAt = row.receivedAt;
  }
  return {
    basis: "POST_EXIT_HINDSIGHT",
    windowStart: lot.closedAt!,
    windowEnd: new Date(end).toISOString(),
    horizonSeconds,
    horizonComplete: asOfMs >= horizonEnd,
    observations: count,
    highUsd: hi === null ? null : usd(hi),
    lowUsd: lo === null ? null : usd(lo),
    recoveredToEntry: count === 0 ? null : firstRecoveryAt !== null,
    firstRecoveryAt,
  };
}

/** Rule-by-rule classification of a CLOSED lot (see RULE_TEXT / FEEDBACK_RULES). */
export function classifyLot(input: {
  lot: Lot;
  record: DecisionRecord | null;
  realised: Retrospective["realised"];
  cost: Pick<Retrospective["expectedVsRealised"], "expectedCostUsd" | "costExcessUsd">;
  inTrade: LotExcursion;
  postExit: PostExitWindow;
  exitReason: string;
}): LotClassification {
  const { lot, record, realised, inTrade, postExit } = input;
  const matched: ClassificationMatch[] = [];
  const notEvaluable: string[] = [];
  const net = d(realised.netPnlUsd);
  const loss = net.lt(0);
  const entryNotional = d(realised.entryNotionalUsd);

  // EXECUTION_COST_ERROR
  let costExplainsLoss = false;
  if (input.cost.expectedCostUsd === null || input.cost.costExcessUsd === null) notEvaluable.push("EXECUTION_COST_ERROR: no expected cost recorded");
  else {
    const expected = d(input.cost.expectedCostUsd);
    const excess = d(input.cost.costExcessUsd);
    const floor = entryNotional.mul(d(FEEDBACK_RULES.costExcessMinBps)).div(10_000);
    if (excess.gt(expected.mul(d(FEEDBACK_RULES.costExcessRatio))) && excess.gt(floor)) {
      costExplainsLoss = loss && net.plus(excess).gte(0);
      matched.push({
        class: "EXECUTION_COST_ERROR",
        rule: "REALISED_COST_MATERIALLY_ABOVE_EXPECTED",
        dataBasis: "REALISED",
        evidence: { expectedCostUsd: usd(expected), costExcessUsd: usd(excess), excessExplainsLoss: costExplainsLoss },
      });
    }
  }

  if (loss) {
    // TURNOVER
    const midMove = d(realised.midMovePnlUsd);
    const cost = d(realised.costUsd);
    if (midMove.abs().lt(cost)) {
      matched.push({ class: "TURNOVER", rule: "PRICE_MOVE_SMALLER_THAN_COSTS", dataBasis: "REALISED", evidence: { midMovePnlUsd: realised.midMovePnlUsd, costUsd: realised.costUsd } });
    }
    // EXIT_TIMING
    if (inTrade.mfePct !== null && d(inTrade.mfePct).gte(d(FEEDBACK_RULES.exitTimingMfePct))) {
      matched.push({ class: "EXIT_TIMING", rule: "GAVE_BACK_MFE", dataBasis: "IN_TRADE", evidence: { mfePct: inTrade.mfePct, netPnlUsd: realised.netPnlUsd } });
    } else if ((input.exitReason === "STOP_LOSS" || input.exitReason === "TRAILING_STOP") && postExit.recoveredToEntry === true) {
      matched.push({
        class: "EXIT_TIMING",
        rule: "STOP_THEN_RECOVERED_WITHIN_HORIZON",
        dataBasis: "POST_EXIT",
        evidence: { exitReason: input.exitReason, firstRecoveryAt: postExit.firstRecoveryAt, horizonSeconds: postExit.horizonSeconds },
      });
    }
    if (inTrade.mfePct === null && postExit.recoveredToEntry === null) notEvaluable.push("EXIT_TIMING: no marks in or after the trade");
    // SIZING_ERROR
    const entryLiquidity = record ? pctOf(record.market.liquidityUsd) ?? pctOf(record.entry.liquidityUsd) : null;
    const entryEvent = lot.events[0]!;
    const averagedDown = lot.events.find((event) => event.kind === "ADD" && d(event.priceUsd).lt(d(entryEvent.priceUsd)));
    if (record && entryLiquidity !== null && entryLiquidity.gt(0)) {
      const share = d(record.entry.notionalUsd).div(entryLiquidity).mul(100);
      if (share.gt(d(FEEDBACK_RULES.sizingLiquiditySharePct))) {
        matched.push({ class: "SIZING_ERROR", rule: "ENTRY_NOTIONAL_LARGE_VS_LIQUIDITY", dataBasis: "DECISION_RECORD", evidence: { liquiditySharePct: share.toDecimalPlaces(4).toFixed(4) } });
      }
    } else notEvaluable.push("SIZING_ERROR (liquidity share): no decision record liquidity");
    if (averagedDown && !matched.some((row) => row.class === "SIZING_ERROR")) {
      matched.push({ class: "SIZING_ERROR", rule: "ADDED_BELOW_ENTRY_PRICE", dataBasis: "REALISED", evidence: { addFillId: averagedDown.fillId, addPriceUsd: averagedDown.priceUsd, entryPriceUsd: entryEvent.priceUsd } });
    }
    // REGIME_MISMATCH
    if (!record || record.buckets.regime === "UNKNOWN") notEvaluable.push("REGIME_MISMATCH: no entry regime");
    else if (record.entry.side === "BUY" && record.buckets.regime === "TREND_DOWN") {
      matched.push({ class: "REGIME_MISMATCH", rule: "LONG_INTO_DOWNTREND", dataBasis: "DECISION_RECORD", evidence: { priceChangeH1Pct: record.market.priceChangeH1Pct } });
    }
    // SIGNAL_ERROR
    if (inTrade.observations === 0 || inTrade.mfePct === null) notEvaluable.push("SIGNAL_ERROR: no in-trade marks");
    else if (d(inTrade.mfePct).lt(d(FEEDBACK_RULES.signalMaxMfePct))) {
      matched.push({ class: "SIGNAL_ERROR", rule: "NEVER_MOVED_IN_FAVOUR", dataBasis: "IN_TRADE", evidence: { mfePct: inTrade.mfePct, maePct: inTrade.maePct } });
    }
  }

  let primary: ErrorClass;
  if (!loss) primary = "NO_ERROR";
  else {
    primary = "UNATTRIBUTED";
    for (const candidate of LOSS_CLASS_PRIORITY) {
      if (candidate === "EXECUTION_COST_ERROR" && !costExplainsLoss) continue;
      if (matched.some((row) => row.class === candidate)) {
        primary = candidate;
        break;
      }
    }
  }
  return { primary, matched, notEvaluable };
}

/**
 * Feedback for one lot. `marks` should cover [openedAt, closedAt + horizon]; the function itself splits
 * them into in-trade ([openedAt, closedAt]) and post-exit ((closedAt, closedAt + horizon] ∩ ≤ asOf).
 * The decision record never sees marks.
 */
export function lotFeedback(input: {
  lot: Lot;
  entrySnapshot: StoredEntrySnapshot | null;
  marks: readonly MarkObservation[];
  asOf: string;
  postExitHorizonSeconds?: number;
  marksTruncated?: boolean;
}): LotFeedback {
  const { lot } = input;
  const { state, record } = decisionRecordFromSnapshot(input.entrySnapshot, lot);
  const entryEvent = lot.events[0]!;
  const base = {
    lotKey: lot.lotKey,
    source: "OBSERVED_FILL" as const,
    labelOrigin: "REALISED_LEDGER" as const,
    derivedFromOwnPrediction: false as const,
    accountId: lot.accountId,
    pairAddress: lot.pairAddress,
    status: lot.status,
    openedAt: lot.openedAt,
    strategyInstanceId: entryEvent.strategyInstanceId,
    strategyVersion: entryEvent.strategyVersion,
    decisionRecordState: state,
    decisionRecord: record,
    marksTruncated: input.marksTruncated ?? false,
  };
  if (lot.status !== "CLOSED" || lot.closedAt === null) return { ...base, retrospectiveState: "LOT_OPEN", retrospective: null };

  const horizon = input.postExitHorizonSeconds ?? FEEDBACK_RULES.postExitHorizonSeconds;
  const inTrade = lotExcursion({ ...lot, referencePriceUsd: lot.entryPriceUsd }, input.marks, input.asOf);
  const postExit = postExitWindow(lot, input.marks, input.asOf, horizon);
  const exitEvent = [...lot.events].reverse().find((event) => event.kind === "EXIT") ?? lot.events[lot.events.length - 1]!;
  const exitReason = exitEvent.exitReason?.code ?? "UNKNOWN";
  const fees = d(lot.feesUsd);
  const slippage = d(lot.slippageUsd);
  const net = d(lot.realizedPnlUsd);
  const entryNotional = d(lot.entryNotionalUsd);
  const exitNotional = d(lot.exitNotionalUsd);
  const realised: Retrospective["realised"] = {
    netPnlUsd: usd(net),
    feesUsd: usd(fees),
    slippageUsd: usd(slippage),
    costUsd: usd(fees.plus(slippage)),
    midMovePnlUsd: usd(net.plus(fees).plus(slippage)),
    entryNotionalUsd: usd(entryNotional),
    exitNotionalUsd: usd(exitNotional),
    returnPct: entryNotional.lte(0) ? null : net.div(entryNotional).mul(100).toDecimalPlaces(4).toFixed(4),
  };

  // Expected costs: the entry snapshot's rates applied to the lot's realised turnover (entry + exit notional).
  let costComparison: Retrospective["expectedVsRealised"]["costComparison"] = "NOT_COMPARABLE";
  let expectedCost: Decimal | null = null;
  let realisedComparable: Decimal | null = null;
  if (record?.expected.feeBps != null) {
    const turnover = entryNotional.plus(exitNotional);
    const rate = d(record.expected.feeBps).plus(record.expected.slippageBps != null ? d(record.expected.slippageBps) : ZERO);
    expectedCost = turnover.mul(rate).div(10_000);
    costComparison = record.expected.slippageBps != null ? "FEES_AND_SLIPPAGE" : "FEES_ONLY";
    realisedComparable = costComparison === "FEES_AND_SLIPPAGE" ? fees.plus(slippage) : fees;
  }
  const costExcess = expectedCost !== null && realisedComparable !== null ? realisedComparable.minus(expectedCost) : null;
  const expectedVsRealised: Retrospective["expectedVsRealised"] = {
    expectedNetUsd: null,
    expectedNetState: "NO_FORECAST_RECORDED",
    realisedNetUsd: usd(net),
    costComparison,
    expectedCostUsd: expectedCost === null ? null : usd(expectedCost),
    realisedComparableCostUsd: realisedComparable === null ? null : usd(realisedComparable),
    costExcessUsd: costExcess === null ? null : usd(costExcess),
  };
  const classification = classifyLot({ lot, record, realised, cost: expectedVsRealised, inTrade, postExit, exitReason });
  return {
    ...base,
    retrospectiveState: "CLOSED",
    retrospective: {
      closedAt: lot.closedAt,
      holdingSeconds: lot.holdingSeconds,
      holdingBucket: holdingBucket(lot.holdingSeconds),
      exitReason,
      exitReasonSource: exitEvent.exitReason?.source ?? "UNKNOWN",
      realised,
      expectedVsRealised,
      inTrade,
      postExit,
      classification,
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------------------------------

export type FeedbackDimension =
  | "instrument"
  | "strategyInstance"
  | "strategyVersion"
  | "modelVersion"
  | "regime"
  | "volatility"
  | "liquidity"
  | "holdingDuration"
  | "exitReason";

export const FEEDBACK_DIMENSIONS: readonly FeedbackDimension[] = [
  "instrument",
  "strategyInstance",
  "strategyVersion",
  "modelVersion",
  "regime",
  "volatility",
  "liquidity",
  "holdingDuration",
  "exitReason",
];

export type FeedbackBucket = {
  key: string;
  count: number;
  wins: number;
  losses: number;
  netPnlUsd: string;
  feesUsd: string;
  avgNetPnlUsd: string;
  classifications: Partial<Record<ErrorClass, number>>;
  /** Fewer than FEEDBACK_RULES.minSample closed lots: do not draw conclusions. */
  smallSample: boolean;
};

export type FeedbackAggregate = {
  version: string;
  minSample: number;
  lots: { closed: number; open: number; withDecisionRecord: number; withoutDecisionRecord: number };
  totals: { netPnlUsd: string; feesUsd: string; wins: number; losses: number; smallSample: boolean };
  classifications: Record<ErrorClass, number>;
  dimensions: Record<FeedbackDimension, FeedbackBucket[]>;
  rules: string[];
};

function dimensionKey(row: LotFeedback, dimension: FeedbackDimension): string {
  const record = row.decisionRecord;
  const retro = row.retrospective!;
  switch (dimension) {
    case "instrument":
      return row.pairAddress;
    case "strategyInstance":
      return row.strategyInstanceId ?? "NONE";
    case "strategyVersion":
      return row.strategyVersion ?? "NONE";
    case "modelVersion":
      return record ? (record.modelVersions.join(",") || "NONE") : "NOT_RECORDED";
    case "regime":
      return record?.buckets.regime ?? "UNKNOWN";
    case "volatility":
      return record?.buckets.volatility ?? "UNKNOWN";
    case "liquidity":
      return record?.buckets.liquidity ?? "UNKNOWN";
    case "holdingDuration":
      return retro.holdingBucket;
    case "exitReason":
      return retro.exitReason;
  }
}

const emptyClassCounts = (): Record<ErrorClass, number> => ({
  SIGNAL_ERROR: 0,
  EXECUTION_COST_ERROR: 0,
  SIZING_ERROR: 0,
  REGIME_MISMATCH: 0,
  EXIT_TIMING: 0,
  TURNOVER: 0,
  UNATTRIBUTED: 0,
  NO_ERROR: 0,
});

/**
 * Breakdowns of CLOSED observed lots by each dimension: counts, wins/losses, net P&L, fees and primary
 * classification counts, with small-sample flags. Refuses hypothetical rows (they are never mixed in).
 */
export function aggregateFeedback(rows: readonly LotFeedback[]): FeedbackAggregate {
  for (const row of rows) {
    if (row.source !== "OBSERVED_FILL") throw new Error(`HYPOTHETICAL_ROW_IN_OBSERVED_AGGREGATE ${row.lotKey}`);
  }
  const closed = rows.filter((row) => row.retrospective !== null);
  const minSample = FEEDBACK_RULES.minSample;
  const classifications = emptyClassCounts();
  let net = ZERO;
  let fees = ZERO;
  let wins = 0;
  let losses = 0;
  for (const row of closed) {
    const retro = row.retrospective!;
    classifications[retro.classification.primary] += 1;
    net = net.plus(d(retro.realised.netPnlUsd));
    fees = fees.plus(d(retro.realised.feesUsd));
    if (d(retro.realised.netPnlUsd).gte(0)) wins += 1;
    else losses += 1;
  }
  const dimensions = {} as Record<FeedbackDimension, FeedbackBucket[]>;
  for (const dimension of FEEDBACK_DIMENSIONS) {
    const buckets = new Map<string, { rows: LotFeedback[] }>();
    for (const row of closed) {
      const key = dimensionKey(row, dimension);
      const entry = buckets.get(key) ?? { rows: [] };
      entry.rows.push(row);
      buckets.set(key, entry);
    }
    dimensions[dimension] = [...buckets.entries()]
      .map(([key, { rows: members }]) => {
        let bucketNet = ZERO;
        let bucketFees = ZERO;
        let bucketWins = 0;
        const counts: Partial<Record<ErrorClass, number>> = {};
        for (const member of members) {
          const retro = member.retrospective!;
          const value = d(retro.realised.netPnlUsd);
          bucketNet = bucketNet.plus(value);
          bucketFees = bucketFees.plus(d(retro.realised.feesUsd));
          if (value.gte(0)) bucketWins += 1;
          counts[retro.classification.primary] = (counts[retro.classification.primary] ?? 0) + 1;
        }
        return {
          key,
          count: members.length,
          wins: bucketWins,
          losses: members.length - bucketWins,
          netPnlUsd: usd(bucketNet),
          feesUsd: usd(bucketFees),
          avgNetPnlUsd: usd(bucketNet.div(members.length)),
          classifications: counts,
          smallSample: members.length < minSample,
        };
      })
      .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
  }
  const withRecord = rows.filter((row) => row.decisionRecord !== null).length;
  return {
    version: FEEDBACK_VERSION,
    minSample,
    lots: { closed: closed.length, open: rows.length - closed.length, withDecisionRecord: withRecord, withoutDecisionRecord: rows.length - withRecord },
    totals: { netPnlUsd: usd(net), feesUsd: usd(fees), wins, losses, smallSample: closed.length < minSample },
    classifications,
    dimensions,
    rules: [...RULE_TEXT],
  };
}

export function feedbackRules(): string[] {
  return [...RULE_TEXT];
}

// ---------------------------------------------------------------------------------------------------
// Hypothetical non-trades (counterfactual)
// ---------------------------------------------------------------------------------------------------

/** Funnel stages that mean QUANT decided not to trade the opportunity. */
export const REJECTION_STAGES = ["FILTERED", "REJECTED", "DROPPED"] as const;

export type RejectedOpportunity = {
  id: string;
  accountId: string;
  cycleId: string;
  pairAddress: string;
  stage: string;
  reasonCodes: string[];
  /** OpportunityFunnelEvent.createdAt: when the rejection was decided. */
  createdAt: string;
};

export type CounterfactualPolicy = {
  horizonSeconds: number;
  stopLossPct: string;
  takeProfitPct: string;
  notionalUsd: string;
  /** Assumed round-trip cost; defaults to twice the default fee (slippage not modelled). */
  roundTripCostBps: string;
};

export const DEFAULT_COUNTERFACTUAL_POLICY: CounterfactualPolicy = {
  horizonSeconds: 4 * 3600,
  stopLossPct: DEFAULT_STRATEGY.stopLossPct,
  takeProfitPct: DEFAULT_STRATEGY.takeProfitPct,
  notionalUsd: "100",
  roundTripCostBps: d(DEFAULT_STRATEGY.feeBps).mul(2).toString(),
};

export type HypotheticalStatus = "EVALUATED" | "NOT_A_REJECTION" | "NO_PRE_DECISION_PRICE" | "NO_BARS_AFTER_DECISION";

export type HypotheticalOutcome = {
  id: string;
  source: "HYPOTHETICAL";
  labelOrigin: "MARKET_BARS";
  derivedFromOwnPrediction: false;
  status: HypotheticalStatus;
  /** What was known at the rejection: features at or before createdAt only. */
  decisionRecord: {
    asOf: string;
    accountId: string;
    cycleId: string;
    pairAddress: string;
    stage: string;
    reasonCodes: string[];
    features: {
      observationId: string;
      observedAt: string;
      priceUsd: string | null;
      liquidityUsd: string | null;
      volume24hUsd: string | null;
      priceChangeM5Pct: string | null;
      priceChangeH1Pct: string | null;
      freshness: string;
    } | null;
  };
  /** Hindsight: what a long at the observed price would have done under the policy. */
  retrospective: {
    policy: CounterfactualPolicy;
    windowStart: string;
    windowEnd: string;
    horizonComplete: boolean;
    barsUsed: number;
    entryPriceUsd: string | null;
    exit: { at: string; priceUsd: string; reason: "STOP_LOSS" | "TAKE_PROFIT" | "TIME_EXIT" | "PROVISIONAL_LAST_BAR" } | null;
    grossReturnPct: string | null;
    netPnlUsd: string | null;
    /** Stops fill at the observed mark: gaps through the stop are not modelled; slippage not modelled. */
    caveats: string[];
  };
};

/**
 * Counterfactual outcome of a rejected opportunity: a long of `notionalUsd` at the latest pre-decision
 * price, exited at the first bar at or beyond the stop / take-profit, else at the last bar within the
 * horizon. Features are used only when received (and produced) at or before the decision; bars only
 * strictly after it and at or before asOf. Labelled HYPOTHETICAL; never an observed fill.
 */
export function counterfactualOutcome(input: {
  opportunity: RejectedOpportunity;
  features: readonly PitObservation[];
  bars: readonly MarkObservation[];
  asOf: string;
  policy?: CounterfactualPolicy;
}): HypotheticalOutcome {
  const policy = input.policy ?? DEFAULT_COUNTERFACTUAL_POLICY;
  const opp = input.opportunity;
  const decisionAt = Date.parse(opp.createdAt);
  const horizonEnd = decisionAt + policy.horizonSeconds * 1000;
  const asOfMs = Date.parse(input.asOf);
  const end = Math.min(horizonEnd, asOfMs);
  const preDecision = input.features
    .filter((row) => row.pairAddress === opp.pairAddress)
    .filter((row) => Date.parse(row.receivedAt) <= decisionAt && (row.eventTime === null || Date.parse(row.eventTime) <= decisionAt))
    .sort((left, right) => Date.parse(right.receivedAt) - Date.parse(left.receivedAt))[0];
  const features = preDecision
    ? {
        observationId: preDecision.id,
        observedAt: preDecision.receivedAt,
        priceUsd: preDecision.priceUsd,
        liquidityUsd: preDecision.liquidityUsd,
        volume24hUsd: preDecision.volume24hUsd,
        priceChangeM5Pct: preDecision.priceChangeM5,
        priceChangeH1Pct: preDecision.priceChangeH1,
        freshness: preDecision.freshness,
      }
    : null;
  const caveats = [
    "Stops and targets fill at the observed mark; gaps beyond them are not modelled.",
    `Round-trip cost assumed ${policy.roundTripCostBps} bps; slippage and market impact are not modelled.`,
    "Hypothetical only: never mixed with observed fills.",
  ];
  const result: HypotheticalOutcome = {
    id: opp.id,
    source: "HYPOTHETICAL",
    labelOrigin: "MARKET_BARS",
    derivedFromOwnPrediction: false,
    status: "EVALUATED",
    decisionRecord: { asOf: opp.createdAt, accountId: opp.accountId, cycleId: opp.cycleId, pairAddress: opp.pairAddress, stage: opp.stage, reasonCodes: [...opp.reasonCodes], features },
    retrospective: {
      policy,
      windowStart: opp.createdAt,
      windowEnd: new Date(Math.max(end, decisionAt)).toISOString(),
      horizonComplete: asOfMs >= horizonEnd,
      barsUsed: 0,
      entryPriceUsd: null,
      exit: null,
      grossReturnPct: null,
      netPnlUsd: null,
      caveats,
    },
  };
  if (!(REJECTION_STAGES as readonly string[]).includes(opp.stage)) return { ...result, status: "NOT_A_REJECTION" };
  const entryPrice = features?.priceUsd != null ? d(features.priceUsd) : null;
  if (entryPrice === null || entryPrice.lte(0)) return { ...result, status: "NO_PRE_DECISION_PRICE" };
  const bars = input.bars
    .filter((row) => row.pairAddress === opp.pairAddress && row.priceUsd !== null && d(row.priceUsd).gt(0))
    .filter((row) => {
      const at = Date.parse(row.receivedAt);
      return at > decisionAt && at <= end;
    })
    .sort((left, right) => Date.parse(left.receivedAt) - Date.parse(right.receivedAt));
  const retro = { ...result.retrospective, entryPriceUsd: usd(entryPrice), barsUsed: bars.length };
  if (bars.length === 0) return { ...result, status: "NO_BARS_AFTER_DECISION", retrospective: retro };
  const stop = entryPrice.mul(new Decimal(1).minus(d(policy.stopLossPct).div(100)));
  const target = entryPrice.mul(new Decimal(1).plus(d(policy.takeProfitPct).div(100)));
  let exit: NonNullable<HypotheticalOutcome["retrospective"]["exit"]> | null = null;
  for (const bar of bars) {
    const price = d(bar.priceUsd!);
    if (price.lte(stop)) {
      exit = { at: bar.receivedAt, priceUsd: usd(price), reason: "STOP_LOSS" };
      break;
    }
    if (price.gte(target)) {
      exit = { at: bar.receivedAt, priceUsd: usd(price), reason: "TAKE_PROFIT" };
      break;
    }
  }
  if (!exit) {
    const last = bars[bars.length - 1]!;
    exit = { at: last.receivedAt, priceUsd: usd(d(last.priceUsd!)), reason: retro.horizonComplete ? "TIME_EXIT" : "PROVISIONAL_LAST_BAR" };
  }
  const gross = d(exit.priceUsd).div(entryPrice).minus(1);
  const notional = d(policy.notionalUsd);
  const netPnl = notional.mul(gross).minus(notional.mul(d(policy.roundTripCostBps)).div(10_000));
  return {
    ...result,
    retrospective: { ...retro, exit, grossReturnPct: gross.mul(100).toDecimalPlaces(4).toFixed(4), netPnlUsd: usd(netPnl) },
  };
}

// ---------------------------------------------------------------------------------------------------
// Training-data guard (self-reinforcement)
// ---------------------------------------------------------------------------------------------------

/** A label-bearing row as a training pipeline would consume it. */
export type FeedbackRow = {
  id: string;
  source: FeedbackSource;
  labelOrigin: LabelOrigin;
  /** True when the label derives from QUANT's own predictions (forecasts, expected values, model scores). */
  derivedFromOwnPrediction: boolean;
  /** Features known at decision time only. */
  features: Record<string, string | null>;
  label: { netPnlUsd: string | null; returnPct: string | null };
};

/** Training row for an observed CLOSED lot: features from the decision record, label from the ledger. */
export function feedbackRowFromLot(row: LotFeedback): FeedbackRow | null {
  if (!row.retrospective) return null;
  const record = row.decisionRecord;
  return {
    id: row.lotKey,
    source: "OBSERVED_FILL",
    labelOrigin: "REALISED_LEDGER",
    derivedFromOwnPrediction: false,
    features: {
      pairAddress: row.pairAddress,
      strategyInstanceId: row.strategyInstanceId,
      strategyVersion: row.strategyVersion,
      priceChangeM5Pct: record?.market.priceChangeM5Pct ?? null,
      priceChangeH1Pct: record?.market.priceChangeH1Pct ?? null,
      liquidityUsd: record?.market.liquidityUsd ?? null,
      volume24hUsd: record?.market.volume24hUsd ?? null,
      regime: record?.buckets.regime ?? "UNKNOWN",
      volatility: record?.buckets.volatility ?? "UNKNOWN",
    },
    label: { netPnlUsd: row.retrospective.realised.netPnlUsd, returnPct: row.retrospective.realised.returnPct },
  };
}

/** Training row for an evaluated hypothetical. */
export function feedbackRowFromHypothetical(outcome: HypotheticalOutcome): FeedbackRow | null {
  if (outcome.status !== "EVALUATED") return null;
  const features = outcome.decisionRecord.features;
  return {
    id: outcome.id,
    source: "HYPOTHETICAL",
    labelOrigin: "MARKET_BARS",
    derivedFromOwnPrediction: false,
    features: {
      pairAddress: outcome.decisionRecord.pairAddress,
      stage: outcome.decisionRecord.stage,
      priceChangeM5Pct: features?.priceChangeM5Pct ?? null,
      priceChangeH1Pct: features?.priceChangeH1Pct ?? null,
      liquidityUsd: features?.liquidityUsd ?? null,
      volume24hUsd: features?.volume24hUsd ?? null,
    },
    label: { netPnlUsd: outcome.retrospective.netPnlUsd, returnPct: outcome.retrospective.grossReturnPct },
  };
}

const EXPECTED_ORIGIN: Record<FeedbackSource, LabelOrigin> = { OBSERVED_FILL: "REALISED_LEDGER", HYPOTHETICAL: "MARKET_BARS" };

/**
 * Build training data. Refuses (throws SELF_REINFORCEMENT_REFUSED) when any row's label derives from
 * QUANT's own predictions, either by flag or by labelOrigin, and refuses rows whose source/labelOrigin
 * pairing is inconsistent. Observed and hypothetical rows are returned separately and never mixed;
 * hypothetical rows are dropped unless `includeHypothetical` is set.
 */
export function buildTrainingData(
  rows: readonly FeedbackRow[],
  options: { includeHypothetical?: boolean } = {},
): { observed: FeedbackRow[]; hypothetical: FeedbackRow[]; droppedHypothetical: number } {
  const selfReferential = rows.filter((row) => row.derivedFromOwnPrediction !== false || row.labelOrigin === "QUANT_PREDICTION");
  if (selfReferential.length > 0) throw new Error(`SELF_REINFORCEMENT_REFUSED ${selfReferential.map((row) => row.id).join(",")}`);
  const inconsistent = rows.filter((row) => EXPECTED_ORIGIN[row.source] === undefined || EXPECTED_ORIGIN[row.source] !== row.labelOrigin);
  if (inconsistent.length > 0) throw new Error(`FEEDBACK_SOURCE_INCONSISTENT ${inconsistent.map((row) => row.id).join(",")}`);
  const observed = rows.filter((row) => row.source === "OBSERVED_FILL");
  const hypothetical = rows.filter((row) => row.source === "HYPOTHETICAL");
  return {
    observed: [...observed],
    hypothetical: options.includeHypothetical ? [...hypothetical] : [],
    droppedHypothetical: options.includeHypothetical ? 0 : hypothetical.length,
  };
}
