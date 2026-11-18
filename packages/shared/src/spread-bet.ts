import Decimal from "decimal.js";
import { bookedAmountFits, spreadDecimal, SpreadDecimal } from "./spread-bet-domain.js";

const d = (value: string): Decimal => new SpreadDecimal(value);

/**
 * OPERATION AURUM: simulated UK financial spread betting (GBP per point) on a USD-quoted reference.
 * **Pure and unwired.** Nothing in the order path calls this; wiring is PCR-AURUM-01 (protected).
 *
 * Semantics (docs/aurum/SPREAD-BET-ACCOUNTING.md):
 *   - The reference price is USD per troy ounce. A point is `pointSize` USD of price movement.
 *   - Exposure is a stake in GBP per point. P&L is GBP by construction: no USD→GBP conversion of P&L.
 *   - LONG opens at ask, closes at bid. SHORT opens at bid, closes at ask. Spread is inside those prices,
 *     so it is never deducted a second time.
 *   - Opening reserves margin; it does not buy notional. Cash moves only on realised P&L and costs.
 *
 * Every function fails closed: invalid, non-finite or inconsistent input is a named rejection.
 * Simulated quotes are labelled simulation-derived and must never be presented as a broker's quote.
 */

export type Direction = "LONG" | "SHORT";

/** Runtime guard: anything other than exactly "LONG" or "SHORT" is refused, never treated as SHORT. */
export function isDirection(value: unknown): value is Direction {
  return value === "LONG" || value === "SHORT";
}

function requireDirection(value: unknown): Direction {
  if (!isDirection(value)) throw new Error("INVALID_DIRECTION");
  return value;
}

export type SpreadBetProductSpec = {
  /** Immutable id. Any change to a field creates a new id. */
  id: string;
  label: string;
  /** GENERIC_SIMULATION unless every field is verified against a broker's own documentation. */
  provenance: "GENERIC_SIMULATION" | "BROKER_DOCUMENTED";
  sourceUrls: readonly string[];
  verifiedAt: string | null;
  referenceInstrumentId: string;
  accountCurrency: "GBP";
  /** USD of reference price movement per point, e.g. "1" (one point = $1.00/oz). */
  pointSize: string;
  /** Decimal places of simulated bid/ask. */
  priceDp: number;
  minStakeGbp: string;
  stakeIncrementGbp: string;
  maxStakeGbp: string;
  /** Initial margin as a fraction of GBP notional (stake × price/pointSize). "0.05" = 20:1. */
  marginRate: string;
  /** Simulated dealing spread in points per cost scenario. The executable spread is never narrower than the reference's. */
  spreadPoints: { BASELINE: string; ELEVATED: string; SEVERE: string };
  /** Overnight funding is not modelled; positions must be flat before the funding cut-off while this is false. */
  overnightFundingModelled: false;
  guaranteedStopsModelled: false;
};

export type CostScenario = keyof SpreadBetProductSpec["spreadPoints"];

export type ReferenceQuote = {
  kind: "REFERENCE_MARKET_QUOTE";
  quoteId: string;
  instrumentId: string;
  provider: string;
  bid: string;
  ask: string;
  eventTime: string;
};

export type SimulatedSpreadBetQuote = {
  kind: "SIMULATED_SPREAD_BET_QUOTE";
  productId: string;
  derivedFromQuoteId: string;
  scenario: CostScenario;
  bid: string;
  ask: string;
  spreadPoints: string;
  eventTime: string;
  disclosure: "Simulation-derived from a reference quote. Not a broker quote.";
};

export type Result<T, R extends string> = { ok: true; value: T } | { ok: false; reason: R };

const fail = <R extends string>(reason: R) => ({ ok: false as const, reason });
const ok = <T>(value: T) => ({ ok: true as const, value });

function dec(value: string): Decimal | null {
  return spreadDecimal(value);
}

export type SpecReason = "INVALID_SPEC";

/** Validates internal consistency of a product spec. Callers must check this before any other function. */
export function validateProductSpec(spec: SpreadBetProductSpec): Result<SpreadBetProductSpec, SpecReason> {
  if (!spec || !spec.spreadPoints || !Array.isArray(spec.sourceUrls)) return fail("INVALID_SPEC");
  const point = dec(spec.pointSize);
  const min = dec(spec.minStakeGbp);
  const inc = dec(spec.stakeIncrementGbp);
  const max = dec(spec.maxStakeGbp);
  const margin = dec(spec.marginRate);
  const spreads = [spec.spreadPoints.BASELINE, spec.spreadPoints.ELEVATED, spec.spreadPoints.SEVERE].map(dec);
  if (!point || !min || !inc || !max || !margin || spreads.some((s) => s === null)) return fail("INVALID_SPEC");
  if (point.lte(0) || min.lte(0) || inc.lte(0) || max.lt(min)) return fail("INVALID_SPEC");
  if (!min.mod(inc).isZero() || !max.mod(inc).isZero()) return fail("INVALID_SPEC");
  if (margin.lte(0) || margin.gt(1)) return fail("INVALID_SPEC");
  if (spreads.some((s) => s!.lt(0))) return fail("INVALID_SPEC");
  const b = d(spec.spreadPoints.BASELINE);
  const e = d(spec.spreadPoints.ELEVATED);
  const s = d(spec.spreadPoints.SEVERE);
  if (e.lt(b) || s.lt(e)) return fail("INVALID_SPEC");
  if (!Number.isInteger(spec.priceDp) || spec.priceDp < 0 || spec.priceDp > 8) return fail("INVALID_SPEC");
  if (spec.accountCurrency !== "GBP") return fail("INVALID_SPEC");
  if (spec.provenance !== "GENERIC_SIMULATION" && spec.provenance !== "BROKER_DOCUMENTED") return fail("INVALID_SPEC");
  if (spec.overnightFundingModelled !== false || spec.guaranteedStopsModelled !== false) return fail("INVALID_SPEC");
  if (spec.provenance === "BROKER_DOCUMENTED" && (spec.sourceUrls.length === 0 || !spec.verifiedAt)) {
    return fail("INVALID_SPEC");
  }
  return ok(spec);
}

export type QuoteReason = "INVALID_SPEC" | "INVALID_SCENARIO" | "WRONG_INSTRUMENT" | "INVALID_PRICE" | "CROSSED_OR_LOCKED" | "INVALID_EVENT_TIME";

/**
 * Derives a simulated executable spread-bet quote from a structurally valid reference quote. Freshness,
 * session and provider-tradeability belong to `assessQuoteAdmission` and must be checked by the caller.
 * The simulated spread is max(reference spread, scenario spread); bid rounds down and ask rounds up.
 */
export function deriveSpreadBetQuote(
  spec: SpreadBetProductSpec,
  ref: ReferenceQuote,
  scenario: CostScenario,
): Result<SimulatedSpreadBetQuote, QuoteReason> {
  if (!validateProductSpec(spec).ok) return fail("INVALID_SPEC");
  if (!Object.prototype.hasOwnProperty.call(spec.spreadPoints, scenario)) return fail("INVALID_SCENARIO");
  if (ref.kind !== "REFERENCE_MARKET_QUOTE" || ref.instrumentId !== spec.referenceInstrumentId) {
    return fail("WRONG_INSTRUMENT");
  }
  const bid = dec(ref.bid);
  const ask = dec(ref.ask);
  if (!bid || !ask || bid.lte(0) || ask.lte(0)) return fail("INVALID_PRICE");
  if (ask.lte(bid)) return fail("CROSSED_OR_LOCKED");
  if (Number.isNaN(Date.parse(ref.eventTime))) return fail("INVALID_EVENT_TIME");
  const point = d(spec.pointSize);
  const refSpread = ask.minus(bid);
  const scenarioSpread = d(spec.spreadPoints[scenario]).times(point);
  const spread = SpreadDecimal.max(refSpread, scenarioSpread);
  const mid = bid.plus(ask).div(2);
  const half = spread.div(2);
  const simBid = mid.minus(half).toDecimalPlaces(spec.priceDp, Decimal.ROUND_FLOOR);
  const simAsk = mid.plus(half).toDecimalPlaces(spec.priceDp, Decimal.ROUND_CEIL);
  if (simBid.lte(0) || !dec(simBid.toFixed()) || !dec(simAsk.toFixed())) return fail("INVALID_PRICE");
  const spreadPoints = simAsk.minus(simBid).div(point);
  if (!dec(spreadPoints.toFixed())) return fail("INVALID_PRICE");
  return ok({
    kind: "SIMULATED_SPREAD_BET_QUOTE",
    productId: spec.id,
    derivedFromQuoteId: ref.quoteId,
    scenario,
    bid: simBid.toFixed(spec.priceDp),
    ask: simAsk.toFixed(spec.priceDp),
    spreadPoints: spreadPoints.toFixed(),
    eventTime: ref.eventTime,
    disclosure: "Simulation-derived from a reference quote. Not a broker quote.",
  });
}

/** Executable price for opening: LONG at ask, SHORT at bid. */
export function entryPrice(direction: Direction, q: Pick<SimulatedSpreadBetQuote, "bid" | "ask">): string {
  requireDirection(direction);
  requireQuotePrices(q);
  return direction === "LONG" ? q.ask : q.bid;
}

/** Executable price for closing: LONG at bid, SHORT at ask. */
export function exitPrice(direction: Direction, q: Pick<SimulatedSpreadBetQuote, "bid" | "ask">): string {
  requireDirection(direction);
  requireQuotePrices(q);
  return direction === "LONG" ? q.bid : q.ask;
}

function requireQuotePrices(q: Pick<SimulatedSpreadBetQuote, "bid" | "ask">): void {
  const bid = dec(q?.bid);
  const ask = dec(q?.ask);
  if (!bid || !ask || bid.lte(0) || ask.lte(bid)) throw new Error("INVALID_INPUT");
}

function validStake(spec: SpreadBetProductSpec, stake: Decimal): boolean {
  // Partial closes may be below the entry minimum, but must remain on the stake grid.
  return stake.gt(0) && stake.lte(spec.maxStakeGbp) && stake.mod(spec.stakeIncrementGbp).isZero();
}

/**
 * Exact GBP P&L for a stake between two executable prices, unrounded. Round only when booking with
 * `bookGbp`. LONG: (exit − entry)/point × stake. SHORT: (entry − exit)/point × stake.
 */
export function pnlGbp(input: {
  spec: SpreadBetProductSpec;
  direction: Direction;
  stakeGbp: string;
  entry: string;
  exit: string;
}): Result<Decimal, "INVALID_SPEC" | "INVALID_INPUT"> {
  if (!validateProductSpec(input.spec).ok) return fail("INVALID_SPEC");
  if (!isDirection(input.direction)) return fail("INVALID_INPUT");
  const stake = dec(input.stakeGbp);
  const entry = dec(input.entry);
  const exit = dec(input.exit);
  if (!stake || !entry || !exit || !validStake(input.spec, stake) || entry.lte(0) || exit.lte(0)) return fail("INVALID_INPUT");
  const move = input.direction === "LONG" ? exit.minus(entry) : entry.minus(exit);
  const pnl = move.div(d(input.spec.pointSize)).times(stake);
  return bookedAmountFits(pnl) ? ok(pnl) : fail("INVALID_INPUT");
}

/** Books an exact GBP amount to pennies, rounding toward negative infinity (profits down, losses up). */
export function bookGbp(amount: Decimal): string {
  if (!bookedAmountFits(amount)) throw new Error("INVALID_INPUT");
  const booked = amount.toDecimalPlaces(2, Decimal.ROUND_FLOOR);
  if (!bookedAmountFits(booked)) throw new Error("INVALID_INPUT");
  return booked.toFixed(2);
}

/** GBP notional exposure: stake × price / pointSize. Not a cash outlay. */
export function notionalGbp(spec: SpreadBetProductSpec, stakeGbp: string, priceUsd: string): Decimal {
  if (!validateProductSpec(spec).ok) throw new Error("INVALID_SPEC");
  const stake = dec(stakeGbp);
  const price = dec(priceUsd);
  if (!stake || !price || !validStake(spec, stake) || price.lte(0)) throw new Error("INVALID_INPUT");
  const notional = stake.times(price).div(d(spec.pointSize));
  if (!bookedAmountFits(notional)) throw new Error("INVALID_INPUT");
  return notional;
}

/** Initial margin reserved for a position, rounded up to the penny. */
export function marginGbp(spec: SpreadBetProductSpec, stakeGbp: string, priceUsd: string): string {
  const margin = notionalGbp(spec, stakeGbp, priceUsd).times(d(spec.marginRate)).toDecimalPlaces(2, Decimal.ROUND_CEIL);
  if (!bookedAmountFits(margin)) throw new Error("INVALID_INPUT");
  return margin.toFixed(2);
}

export const SIZING_REASONS = [
  "INVALID_SPEC",
  "INVALID_INPUT",
  "INVALID_RISK_FRACTION",
  "STOP_ON_WRONG_SIDE",
  "STOP_INSIDE_SPREAD",
  "STOP_DISTANCE_TOO_SMALL",
  "MIN_STAKE_EXCEEDS_RISK",
  "INSUFFICIENT_MARGIN",
  "MARGIN_UTILISATION_LIMIT",
] as const;
export type SizingReason = (typeof SIZING_REASONS)[number];

export type StakeSizing = {
  stakeGbp: string;
  stopDistancePoints: string;
  /** Loss if filled at the stop plus the slippage allowance. An estimate; ordinary stops are not guaranteed. */
  estimatedLossAtStopGbp: string;
  marginGbp: string;
  permittedRiskGbp: string;
  cappedAtMaxStake: boolean;
  disclosure: "Estimated loss at stop is not a maximum loss: ordinary stops can gap.";
};

/**
 * Stake per point from permitted monetary risk and stop distance, rounded down to the stake increment.
 * A stake below the product minimum is a rejection, never a round-up. Margin checks are against the
 * caller's available margin and a utilisation ceiling; neither is relaxed to fit.
 *
 * `entry` must be the executable entry price (ask for LONG, bid for SHORT) and `closingSide` the current
 * executable exit price (bid for LONG, ask for SHORT). The stop must lie beyond the closing side, or it
 * would trigger at once and fill through it. The spread is already inside `entry − stop`.
 */
export function sizeStake(input: {
  spec: SpreadBetProductSpec;
  direction: Direction;
  equityGbp: string;
  riskFraction: string;
  entry: string;
  closingSide: string;
  stop: string;
  slippageAllowancePoints: string;
  availableMarginGbp: string;
  usedMarginGbp: string;
  maxMarginUtilisation: string;
}): Result<StakeSizing, SizingReason> {
  const { spec } = input;
  if (!validateProductSpec(spec).ok) return fail("INVALID_SPEC");
  const equity = dec(input.equityGbp);
  const fraction = dec(input.riskFraction);
  const entry = dec(input.entry);
  const stop = dec(input.stop);
  const closing = dec(input.closingSide);
  const slip = dec(input.slippageAllowancePoints);
  const avail = dec(input.availableMarginGbp);
  const used = dec(input.usedMarginGbp);
  const maxUtil = dec(input.maxMarginUtilisation);
  if (!isDirection(input.direction)) return fail("INVALID_INPUT");
  if (!equity || !entry || !closing || !stop || !slip || !avail || !used || !maxUtil) return fail("INVALID_INPUT");
  if (equity.lte(0) || entry.lte(0) || closing.lte(0) || stop.lte(0) || slip.lt(0) || avail.lt(0) || used.lt(0)) return fail("INVALID_INPUT");
  if (maxUtil.lte(0) || maxUtil.gt(1)) return fail("INVALID_INPUT");
  if (!fraction || fraction.lte(0) || fraction.gt("0.02")) return fail("INVALID_RISK_FRACTION");
  if (input.direction === "LONG" ? stop.gte(entry) : stop.lte(entry)) return fail("STOP_ON_WRONG_SIDE");
  if (input.direction === "LONG" ? closing.gte(entry) : closing.lte(entry)) return fail("INVALID_INPUT");
  if (input.direction === "LONG" ? stop.gte(closing) : stop.lte(closing)) return fail("STOP_INSIDE_SPREAD");

  const point = d(spec.pointSize);
  const stopPoints = entry.minus(stop).abs().div(point);
  if (stopPoints.lt(1)) return fail("STOP_DISTANCE_TOO_SMALL");
  const lossPerStakeUnit = stopPoints.plus(slip);
  const permitted = equity.times(fraction);
  const inc = d(spec.stakeIncrementGbp);
  const raw = permitted.div(lossPerStakeUnit);
  let stake = raw.div(inc).floor().times(inc);
  const max = d(spec.maxStakeGbp);
  const capped = stake.gt(max);
  if (capped) stake = max;
  // Keep the booked (rounded-up) loss estimate within the booked (rounded-down) permitted risk.
  const permittedBooked = permitted.toDecimalPlaces(2, Decimal.ROUND_FLOOR);
  stake = SpreadDecimal.min(stake, permittedBooked.div(lossPerStakeUnit).div(inc).floor().times(inc));
  if (stake.lt(d(spec.minStakeGbp))) return fail("MIN_STAKE_EXCEEDS_RISK");
  if (stake.times(lossPerStakeUnit).toDecimalPlaces(2, Decimal.ROUND_CEIL).gt(permittedBooked)) return fail("INVALID_INPUT");

  const notional = stake.times(entry).div(point);
  if (!bookedAmountFits(notional)) return fail("INVALID_INPUT");
  const margin = notional.times(d(spec.marginRate)).toDecimalPlaces(2, Decimal.ROUND_CEIL);
  if (!bookedAmountFits(margin)) return fail("INVALID_INPUT");
  if (margin.gt(avail)) return fail("INSUFFICIENT_MARGIN");
  if (used.plus(margin).div(equity).gt(maxUtil)) return fail("MARGIN_UTILISATION_LIMIT");

  return ok({
    stakeGbp: stake.toFixed(),
    stopDistancePoints: stopPoints.toFixed(),
    estimatedLossAtStopGbp: stake.times(lossPerStakeUnit).toDecimalPlaces(2, Decimal.ROUND_CEIL).toFixed(2),
    marginGbp: margin.toFixed(2),
    permittedRiskGbp: permittedBooked.toFixed(2),
    // P4: true only when the final stake is the product maximum because risk would have allowed more. The
    // rounding loop below the cap can reduce the stake further, and then it is no longer "capped".
    cappedAtMaxStake: capped && stake.eq(max),
    disclosure: "Estimated loss at stop is not a maximum loss: ordinary stops can gap.",
  });
}

/**
 * Stop fill under a gap: an ordinary stop fills at the first executable closing price at or through
 * the stop, never at the stop level when the market has gapped past it.
 */
export function stopFillPrice(direction: Direction, stop: string, closingSidePrice: string): string | null {
  requireDirection(direction);
  const s = dec(stop);
  const p = dec(closingSidePrice);
  if (!s || !p || s.lte(0) || p.lte(0)) throw new Error("INVALID_INPUT");
  if (direction === "LONG") return p.lte(s) ? p.toFixed() : null;
  return p.gte(s) ? p.toFixed() : null;
}

/** Initial generic simulation profile. Not broker parity; see docs/aurum/PRODUCT-SPECIFICATION.md. */
export const AURUM_GENERIC_GOLD_DFB_V1: SpreadBetProductSpec = Object.freeze({
  id: "aurum-generic-gold-dfb-gbp-v1",
  label: "Generic gold daily funded bet (simulation, GBP per $1 point)",
  provenance: "GENERIC_SIMULATION",
  sourceUrls: Object.freeze([]) as readonly string[],
  verifiedAt: null,
  referenceInstrumentId: "commodity:XAUUSD",
  accountCurrency: "GBP",
  pointSize: "1",
  priceDp: 2,
  minStakeGbp: "0.5",
  stakeIncrementGbp: "0.01",
  maxStakeGbp: "5",
  marginRate: "0.05",
  spreadPoints: Object.freeze({ BASELINE: "0.6", ELEVATED: "1.5", SEVERE: "4" }),
  overnightFundingModelled: false,
  guaranteedStopsModelled: false,
}) as SpreadBetProductSpec;
