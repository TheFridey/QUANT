import type { QuoteQuality } from "./quote-quality.js";
import type { SessionStatus } from "./sessions.js";

/**
 * HORIZON Phase II, PCR-2 C1/C5 decision function. **Pure and unwired.**
 *
 * Decides whether one non-crypto quote could qualify as an execution-grade paper quote, from its honest
 * `QuoteQuality` descriptor, its receive time, the instrument session and an operator flag. It does not
 * relabel anything: DEMO/DELAYED/LIVE `dataState` semantics are untouched, and no risk or settlement code
 * calls this yet. Wiring it into `freshnessGate` / `gateAndQuote` is a protected change (see
 * `docs/horizon/phase-ii/PROTECTED-APPROVAL.md`); both must call this one function so admission and
 * settlement cannot disagree (C5).
 *
 * Every rule fails closed: missing, unknown or non-finite inputs are rejections with a named reason.
 */

export const QUOTE_ADMISSION_REASONS = [
  "DATA_STATE_NOT_ADMISSIBLE",
  "NOT_REAL_TIME",
  "REFERENCE_RATE",
  "COVERAGE_NOT_EXECUTABLE",
  "ONE_SIDED_QUOTE",
  "CROSSED_OR_LOCKED_QUOTE",
  "MISSING_EVENT_TIME",
  "FUTURE_EVENT_TIME",
  "QUOTE_STALE",
  "RECEIVE_STALE",
  "FUTURE_RECEIVE_TIME",
  "PROVIDER_NOT_TRADEABLE",
  "SESSION_NOT_OPEN",
  "SPREAD_UNKNOWN",
  "SPREAD_ABOVE_CAP",
  "INSTRUMENT_NOT_ENABLED",
  "INVALID_LIMIT",
] as const;
export type QuoteAdmissionReason = (typeof QUOTE_ADMISSION_REASONS)[number];

/** Coverages that can stand behind an internal paper fill. Reference rates, recorded and unknown never can. */
export const EXECUTABLE_COVERAGES = ["CONSOLIDATED", "SINGLE_VENUE", "DEALER_INDICATIVE"] as const;

/**
 * Stored freshness labels this function may consider at all. DELAYED, STALE and REPLAY are refused whatever the
 * descriptor says, so a mislabelled descriptor can never lift a delayed or stale observation (safety review M1).
 */
export const ADMISSIBLE_DATA_STATES = ["LIVE", "DEMO"] as const;

export type QuoteAdmissionInput = {
  quality: QuoteQuality;
  /** The observation's stored `dataState` / freshness label. */
  dataState: string;
  /** Provider bid and ask as received (decimal text or number); used to detect crossed/locked books. */
  bid: string | number | null;
  ask: string | number | null;
  /** When QUANT received the quote. */
  receivedAt: Date;
  /** Decision time. */
  now: Date;
  /** Maximum age, from both the provider event time and the receive time. Must be a positive finite number. */
  maxAgeMs: number;
  /** Session status of the instrument at `now` (`evaluateSession`). */
  session: SessionStatus;
  /** Operator-controlled, per-instrument paper-entry flag. Default off. */
  instrumentEnabled: boolean;
  /** Optional per-instrument spread cap in basis points. When set, a missing spread is a rejection. */
  maxSpreadBps?: number | null;
  /** Clock tolerance for event times slightly ahead of `now`. Defaults to 0; never more than 1000 ms. */
  clockSkewToleranceMs?: number;
};

export type QuoteAdmission = {
  admissible: boolean;
  /** Every failed rule, in a stable order. Empty only when admissible. */
  reasons: QuoteAdmissionReason[];
  /** Provider event age at `now`, in ms, when computable. */
  eventAgeMs: number | null;
  receiveAgeMs: number | null;
};

function finite(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function assessQuoteAdmission(input: QuoteAdmissionInput): QuoteAdmission {
  const reasons: QuoteAdmissionReason[] = [];
  const q = input.quality;
  const nowMs = input.now instanceof Date ? input.now.getTime() : Number.NaN;
  const maxAge = Number.isFinite(input.maxAgeMs) && input.maxAgeMs > 0 ? input.maxAgeMs : null;
  const rawSkew = input.clockSkewToleranceMs ?? 0;
  const skewValid = Number.isFinite(rawSkew) && rawSkew >= 0;
  const skew = skewValid ? Math.min(rawSkew, 1000) : 0;

  // A non-finite clock or tolerance would silently disable every time check below, so it is a refusal.
  if (maxAge === null || !skewValid || !Number.isFinite(nowMs)) reasons.push("INVALID_LIMIT");
  if (!(ADMISSIBLE_DATA_STATES as readonly string[]).includes(input.dataState)) reasons.push("DATA_STATE_NOT_ADMISSIBLE");

  if (q.coverage === "REFERENCE_RATE" || q.timeliness === "REFERENCE") reasons.push("REFERENCE_RATE");
  if (q.timeliness !== "REAL_TIME") reasons.push("NOT_REAL_TIME");
  if (!(EXECUTABLE_COVERAGES as readonly string[]).includes(q.coverage)) reasons.push("COVERAGE_NOT_EXECUTABLE");

  const bid = finite(input.bid);
  const ask = finite(input.ask);
  if (!q.twoSided || bid === null || ask === null || bid <= 0 || ask <= 0) {
    reasons.push("ONE_SIDED_QUOTE");
  } else if (ask <= bid) {
    reasons.push("CROSSED_OR_LOCKED_QUOTE");
  }

  // Event age is recomputed from the event time at decision time; the descriptor's own age is when it was built.
  const eventMs = q.eventTime ? Date.parse(q.eventTime) : Number.NaN;
  let eventAgeMs: number | null = null;
  if (!Number.isFinite(eventMs)) {
    reasons.push("MISSING_EVENT_TIME");
  } else if (Number.isFinite(nowMs)) {
    eventAgeMs = nowMs - eventMs;
    if (eventAgeMs < -skew) reasons.push("FUTURE_EVENT_TIME");
    else if (maxAge !== null && eventAgeMs > maxAge) reasons.push("QUOTE_STALE");
  }

  const receivedMs = input.receivedAt.getTime();
  let receiveAgeMs: number | null = null;
  if (!Number.isFinite(receivedMs)) {
    reasons.push("RECEIVE_STALE");
  } else if (Number.isFinite(nowMs)) {
    receiveAgeMs = nowMs - receivedMs;
    if (receiveAgeMs < -skew) reasons.push("FUTURE_RECEIVE_TIME");
    else if (maxAge !== null && receiveAgeMs > maxAge) reasons.push("RECEIVE_STALE");
  }

  // Only an explicit provider "false" refuses here; null means the provider does not report the flag.
  if (q.providerTradeable === false) reasons.push("PROVIDER_NOT_TRADEABLE");
  if (input.session !== "OPEN") reasons.push("SESSION_NOT_OPEN");

  // The spread is computed from the bid/ask passed in, not the descriptor's own figure, so the two cannot disagree.
  const cap = input.maxSpreadBps;
  if (cap !== null && cap !== undefined) {
    const spreadBps = bid !== null && ask !== null && ask > bid && bid > 0 ? ((ask - bid) / ((ask + bid) / 2)) * 10_000 : null;
    if (!Number.isFinite(cap) || cap <= 0) reasons.push("INVALID_LIMIT");
    else if (spreadBps === null) reasons.push("SPREAD_UNKNOWN");
    else if (spreadBps > cap) reasons.push("SPREAD_ABOVE_CAP");
  }

  if (input.instrumentEnabled !== true) reasons.push("INSTRUMENT_NOT_ENABLED");

  const unique = [...new Set(reasons)];
  unique.sort((a, b) => QUOTE_ADMISSION_REASONS.indexOf(a) - QUOTE_ADMISSION_REASONS.indexOf(b));
  return { admissible: unique.length === 0, reasons: unique, eventAgeMs, receiveAgeMs };
}
