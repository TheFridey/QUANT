import {
  AURUM_GENERIC_GOLD_DFB_V1,
  assessQuoteAdmission,
  deriveSpreadBetQuote,
  evaluateSession,
  type QuoteAdmission,
  type QuoteQuality,
  type ReferenceQuote,
  type SessionEval,
  type SimulatedSpreadBetQuote,
} from "@odin/shared";
import type { OandaFailureCode, OandaPriceSnapshot, OandaResult } from "./providers/oanda-practice.js";
import {
  DEFAULT_CIRCUIT_POLICY,
  admitRequest,
  circuitKey,
  initialCircuit,
  recordFailure,
  recordSuccess,
  type CircuitPolicy,
  type CircuitRecord,
  type ProviderFailureKind,
} from "./provider-circuit.js";

/**
 * OPERATION AURUM M1: XAU/USD shadow ingestion core. **Default off, read-only, never executable.**
 *
 * One poll asks the existing OANDA practice pricing endpoint for XAU_USD, through a per-instrument circuit
 * breaker with generation tokens (N3). Each accepted quote keeps the provider's actual bid and ask, the event
 * time and QUANT's receive time, honest provenance (OANDA *practice*, dealer-indicative) and a full quality
 * assessment (spread cap, gold session, age, tradeability). Duplicates and out-of-order quotes are counted and
 * dropped. Accepted quotes go to a bounded in-memory buffer only: nothing here writes to the database, submits
 * an order or reaches the trading engine. Every quote and every derived simulated quote carries
 * `executable: false` as a literal type, so no caller can treat one as an order price at this stage.
 *
 * Wiring this into a scheduled worker job, and persisting quotes, are separate decisions (docs/aurum/FEED.md).
 */

export const GOLD_PROVIDER_ID = "oanda_practice";
export const GOLD_PROVIDER_INSTRUMENT = "XAU_USD";
export const GOLD_INSTRUMENT_ID = "commodity:XAUUSD";

export type GoldShadowConfig = {
  /** Master switch. Off by default; turning it on is an operator decision. */
  enabled: boolean;
  /** Mandatory spread cap in basis points; a quote above it is flagged, never silently accepted. */
  maxSpreadBps: number;
  /** Maximum age from both the provider event time and the receive time. */
  maxQuoteAgeMs: number;
  clockSkewToleranceMs: number;
  /** Bounded buffer of accepted quotes (oldest dropped first). */
  bufferSize: number;
  /** Polls closer together than this are refused without a request. */
  minPollIntervalMs: number;
  circuit: CircuitPolicy;
};

/** Proposed defaults (pending operator approval): observed XAU spread on practice was about 1.2 bps on 6 Nov. */
export const DEFAULT_GOLD_SHADOW_CONFIG: Readonly<GoldShadowConfig> = Object.freeze({
  enabled: false,
  maxSpreadBps: 10,
  maxQuoteAgeMs: 5_000,
  clockSkewToleranceMs: 250,
  bufferSize: 720,
  minPollIntervalMs: 5_000,
  circuit: DEFAULT_CIRCUIT_POLICY,
});

export function validateGoldShadowConfig(c: GoldShadowConfig): { ok: true } | { ok: false; reason: string } {
  const pos = (n: number) => typeof n === "number" && Number.isFinite(n) && n > 0;
  if (typeof c.enabled !== "boolean") return { ok: false, reason: "ENABLED_NOT_BOOLEAN" };
  if (!pos(c.maxSpreadBps) || c.maxSpreadBps > 100) return { ok: false, reason: "INVALID_SPREAD_CAP" };
  if (!pos(c.maxQuoteAgeMs) || c.maxQuoteAgeMs > 60_000) return { ok: false, reason: "INVALID_MAX_AGE" };
  if (!(c.clockSkewToleranceMs >= 0 && c.clockSkewToleranceMs <= 1_000)) return { ok: false, reason: "INVALID_SKEW" };
  if (!Number.isInteger(c.bufferSize) || c.bufferSize < 1 || c.bufferSize > 100_000) return { ok: false, reason: "INVALID_BUFFER" };
  if (!pos(c.minPollIntervalMs) || c.minPollIntervalMs < 1_000) return { ok: false, reason: "INVALID_POLL_INTERVAL" };
  return { ok: true };
}

export type GoldReferenceQuote = ReferenceQuote & {
  executable: false;
  receivedAt: string;
  provenance: {
    provider: typeof GOLD_PROVIDER_ID;
    providerInstrument: typeof GOLD_PROVIDER_INSTRUMENT;
    environment: "PRACTICE";
    coverage: QuoteQuality["coverage"];
    timeliness: QuoteQuality["timeliness"];
    disclosure: "OANDA practice dealer-indicative price. Not an exchange price and not a broker quote for this account.";
  };
  mid: string;
  spreadBps: number;
  providerTradeable: boolean | null;
  session: Pick<SessionEval, "status" | "reason">;
  /** Quality assessment at receive time. `admissible` means the quote passed every quality rule, not that it may trade. */
  quality: QuoteAdmission;
};

export type GoldSimulatedQuote = SimulatedSpreadBetQuote & { executable: false };

export type ShadowPollResult =
  | { status: "DISABLED" }
  | { status: "INVALID_CONFIG"; reason: string }
  | { status: "THROTTLED"; nextPollAt: number }
  | { status: "CIRCUIT_OPEN"; retryAt: number | null; reason: string }
  | { status: "PROVIDER_FAILURE"; code: OandaFailureCode | "NO_QUOTE" | "THREW"; error: string; circuit: CircuitRecord["state"] }
  | { status: "REJECTED"; reason: "MISSING_EVENT_TIME" | "ONE_SIDED"; snapshot: Pick<OandaPriceSnapshot, "time" | "bid" | "ask"> }
  | { status: "DUPLICATE"; eventTime: string }
  | { status: "OUT_OF_ORDER"; eventTime: string; lastEventTime: string }
  | { status: "ACCEPTED"; quote: GoldReferenceQuote; simulated: GoldSimulatedQuote | { unavailable: string } };

export type ShadowCounters = {
  polls: number;
  requests: number;
  accepted: number;
  duplicates: number;
  outOfOrder: number;
  rejected: number;
  providerFailures: number;
  circuitRefusals: number;
  throttled: number;
  qualityFailures: number;
};

export type PricingFetcher = (instruments: readonly string[]) => Promise<OandaResult<OandaPriceSnapshot[]>>;

export function failureKindFor(code: OandaFailureCode | "NO_QUOTE" | "THREW"): ProviderFailureKind {
  switch (code) {
    case "AUTH_FAILED":
      return "AUTH_FAILED";
    case "MISSING_CREDENTIALS":
    case "INVALID_CONFIGURATION":
      return "INVALID_CONFIGURATION";
    case "RATE_LIMITED":
      return "RATE_LIMITED";
    case "HTTP_ERROR":
      return "HTTP_5XX";
    case "INVALID":
    case "NO_QUOTE":
      return "BAD_PAYLOAD";
    case "THREW":
      return "NETWORK";
  }
}

function spreadBpsOf(bid: number, ask: number): number {
  return ((ask - bid) / ((ask + bid) / 2)) * 10_000;
}

export class GoldShadowFeed {
  private circuit: CircuitRecord = initialCircuit(circuitKey(GOLD_PROVIDER_ID, GOLD_PROVIDER_INSTRUMENT));
  private readonly buffer: GoldReferenceQuote[] = [];
  private lastPollAt: number | null = null;
  private inFlight = false;
  readonly counters: ShadowCounters = {
    polls: 0,
    requests: 0,
    accepted: 0,
    duplicates: 0,
    outOfOrder: 0,
    rejected: 0,
    providerFailures: 0,
    circuitRefusals: 0,
    throttled: 0,
    qualityFailures: 0,
  };

  constructor(
    private readonly config: GoldShadowConfig,
    private readonly deps: { pricing: PricingFetcher; now: () => Date },
  ) {}

  private latest(): GoldReferenceQuote | null {
    return this.buffer.length > 0 ? this.buffer[this.buffer.length - 1]! : null;
  }

  /** One bounded poll. Never throws; never more than one request in flight. */
  async poll(): Promise<ShadowPollResult> {
    this.counters.polls++;
    const valid = validateGoldShadowConfig(this.config);
    if (!valid.ok) return { status: "INVALID_CONFIG", reason: valid.reason };
    if (this.config.enabled !== true) return { status: "DISABLED" };
    const startMs = this.deps.now().getTime();
    if (this.inFlight || (this.lastPollAt !== null && startMs - this.lastPollAt < this.config.minPollIntervalMs)) {
      this.counters.throttled++;
      return { status: "THROTTLED", nextPollAt: (this.lastPollAt ?? startMs) + this.config.minPollIntervalMs };
    }
    const gate = admitRequest(this.circuit, startMs, this.config.circuit);
    this.circuit = gate.record;
    if (!gate.admission.allowed) {
      this.counters.circuitRefusals++;
      return { status: "CIRCUIT_OPEN", retryAt: gate.admission.retryAt, reason: gate.admission.reason };
    }
    const token = gate.admission.token;
    this.lastPollAt = startMs;
    this.inFlight = true;
    this.counters.requests++;
    let result: OandaResult<OandaPriceSnapshot[]>;
    try {
      result = await this.deps.pricing([GOLD_PROVIDER_INSTRUMENT]);
    } catch (err) {
      result = { ok: false, code: "INVALID", error: `THREW:${err instanceof Error ? err.message : String(err)}` };
      return this.fail("THREW", result.error, token);
    } finally {
      this.inFlight = false;
    }
    if (!result.ok) return this.fail(result.code, result.error, token);
    const snap = result.data.find((s) => s.instrument === GOLD_PROVIDER_INSTRUMENT);
    if (!snap) return this.fail("NO_QUOTE", "XAU_USD missing from pricing response", token);
    // The provider answered: that is a success for the breaker, whatever the quote's quality.
    this.circuit = recordSuccess(this.circuit, this.deps.now().getTime(), token);
    return this.accept(snap, this.deps.now());
  }

  private fail(code: OandaFailureCode | "NO_QUOTE" | "THREW", error: string, token: number): ShadowPollResult {
    this.counters.providerFailures++;
    this.circuit = recordFailure(this.circuit, { kind: failureKindFor(code), error, token }, this.deps.now().getTime(), this.config.circuit);
    return { status: "PROVIDER_FAILURE", code, error, circuit: this.circuit.state };
  }

  private accept(snap: OandaPriceSnapshot, receivedAt: Date): ShadowPollResult {
    const bid = snap.bid === null ? Number.NaN : Number(snap.bid);
    const ask = snap.ask === null ? Number.NaN : Number(snap.ask);
    if (!snap.time) {
      this.counters.rejected++;
      return { status: "REJECTED", reason: "MISSING_EVENT_TIME", snapshot: { time: snap.time, bid: snap.bid, ask: snap.ask } };
    }
    if (!(bid > 0) || !(ask > 0) || snap.bid === null || snap.ask === null) {
      this.counters.rejected++;
      return { status: "REJECTED", reason: "ONE_SIDED", snapshot: { time: snap.time, bid: snap.bid, ask: snap.ask } };
    }
    const last = this.latest();
    if (last) {
      const lastMs = Date.parse(last.eventTime);
      const thisMs = Date.parse(snap.time);
      if (thisMs === lastMs && last.bid === snap.bid && last.ask === snap.ask) {
        this.counters.duplicates++;
        return { status: "DUPLICATE", eventTime: snap.time };
      }
      // An older event, or a different price at the same event time, never replaces the newer quote.
      if (thisMs <= lastMs) {
        this.counters.outOfOrder++;
        return { status: "OUT_OF_ORDER", eventTime: snap.time, lastEventTime: last.eventTime };
      }
    }
    const session = evaluateSession({ session: "METALS_ENERGY_CFD", now: receivedAt });
    const quality = assessQuoteAdmission({
      quality: snap.quality,
      dataState: "DEMO",
      bid: snap.bid,
      ask: snap.ask,
      receivedAt,
      now: receivedAt,
      maxAgeMs: this.config.maxQuoteAgeMs,
      session: session.status,
      // Quality only: the entry flag is assessed separately and is off. `executable` is false regardless.
      instrumentEnabled: true,
      maxSpreadBps: this.config.maxSpreadBps,
      clockSkewToleranceMs: this.config.clockSkewToleranceMs,
    });
    if (!quality.admissible) this.counters.qualityFailures++;
    const quote: GoldReferenceQuote = {
      kind: "REFERENCE_MARKET_QUOTE",
      quoteId: `${GOLD_PROVIDER_ID}:${GOLD_PROVIDER_INSTRUMENT}:${snap.time}`,
      instrumentId: GOLD_INSTRUMENT_ID,
      provider: GOLD_PROVIDER_ID,
      bid: snap.bid,
      ask: snap.ask,
      eventTime: snap.time,
      receivedAt: receivedAt.toISOString(),
      executable: false,
      provenance: {
        provider: GOLD_PROVIDER_ID,
        providerInstrument: GOLD_PROVIDER_INSTRUMENT,
        environment: "PRACTICE",
        coverage: snap.quality.coverage,
        timeliness: snap.quality.timeliness,
        disclosure: "OANDA practice dealer-indicative price. Not an exchange price and not a broker quote for this account.",
      },
      mid: ((bid + ask) / 2).toFixed(5),
      spreadBps: ask > bid ? Number(spreadBpsOf(bid, ask).toFixed(4)) : 0,
      providerTradeable: snap.tradeable,
      session: { status: session.status, reason: session.reason },
      quality,
    };
    this.buffer.push(quote);
    while (this.buffer.length > this.config.bufferSize) this.buffer.shift();
    this.counters.accepted++;
    const sim = deriveSpreadBetQuote(AURUM_GENERIC_GOLD_DFB_V1, quote, "BASELINE");
    return { status: "ACCEPTED", quote, simulated: sim.ok ? { ...sim.value, executable: false } : { unavailable: sim.reason } };
  }

  /** Read-only state for the command-centre API. Ages are computed at `now`, not at receive time. */
  status(now: Date = this.deps.now()) {
    const latest = this.latest();
    return {
      enabled: this.config.enabled === true,
      provider: GOLD_PROVIDER_ID,
      instrument: GOLD_PROVIDER_INSTRUMENT,
      circuit: { ...this.circuit },
      latest,
      quoteAgeMs: latest ? now.getTime() - Date.parse(latest.eventTime) : null,
      receiveAgeMs: latest ? now.getTime() - Date.parse(latest.receivedAt) : null,
      buffered: this.buffer.length,
      counters: { ...this.counters },
      session: evaluateSession({ session: "METALS_ENERGY_CFD", now }),
    };
  }

  /** Copy of the bounded buffer, oldest first. */
  quotes(): GoldReferenceQuote[] {
    return [...this.buffer];
  }
}
