import {
  canPaperExecute,
  d,
  evaluateSession,
  isResearchOnly,
  usd,
  type AssetClass,
  type Instrument,
  type ProviderReadiness,
  type SessionStatus,
} from "@odin/shared";

/**
 * OPERATION HORIZON §4/§7 opportunity scanner (pure, read only).
 *
 * Two steps, both deterministic for a given input:
 * 1. A readiness ladder per registry instrument. Every blocker found is listed; the state is the earliest
 *    blocking rung. A registry entry alone never gets past NO_RECENT_QUOTE: OBSERVABLE and above need a
 *    fresh, LIVE, observed quote.
 * 2. A ranking of evaluable instruments by expected net edge after round-trip costs, from model evidence
 *    (GENESIS hypothetical shadow outcomes). No evidence means abstain. Volatility is reported, never ranked
 *    on. Correlation with current holdings only lowers the order; nothing is ever forced into the selection.
 *
 * Nothing here creates intents or orders or changes configuration.
 */

export const READINESS_STATES = [
  "NOT_SUPPORTED",
  "NO_PROVIDER",
  "PROVIDER_NOT_CONFIGURED",
  "SESSION_CLOSED",
  "NO_RECENT_QUOTE",
  "REFERENCE_ONLY",
  "STALE",
  "OBSERVABLE",
  "RESEARCH_ONLY",
  "PAPER_EXECUTABLE",
] as const;
export type ReadinessState = (typeof READINESS_STATES)[number];

const EVALUABLE: readonly ReadinessState[] = ["OBSERVABLE", "RESEARCH_ONLY", "PAPER_EXECUTABLE"];

export type ScannerReason = { code: string; stage: ReadinessState; detail: string };

export type PipelineFacts = {
  /** Provider the market-data gateway (or the worker) would use for this instrument; null when none routes it. */
  providerId: string | null;
  providerReadiness: ProviderReadiness | "NO_ROUTE";
  /** Whether the worker stores observations for this instrument in the current environment. */
  ingest: { active: boolean; reason: string | null };
  /** Known pipeline blockers between a signal and a paper fill (docs/horizon/DIAGNOSIS.md). */
  paperEntryBlockers: Array<{ code: string; detail: string }>;
};

export type PipelineConfig = {
  tradingEnvironment: string;
  marketDataPaperFxIngest: boolean;
};

const FRANKFURTER_INGESTED = new Set(["fx:EURUSD", "fx:GBPUSD"]);

/**
 * What the current code can do for one instrument (docs/horizon/DIAGNOSIS.md, 5 Nov 2026). Encodes the four
 * blocking layers: ingest, data shape, freshness label and fill economics. Update it when those change.
 */
export function describePipeline(
  instrument: Instrument,
  input: { gatewayReadiness: Partial<Record<string, ProviderReadiness>>; config: PipelineConfig },
): PipelineFacts {
  const paperEnv = input.config.tradingEnvironment === "MARKET_DATA_PAPER";
  const nonCryptoBlockers: PipelineFacts["paperEntryBlockers"] = [
    {
      code: "FRESHNESS_GATE",
      detail: "Risk engine admits LIVE data only; non-crypto quotes are labelled DELAYED or DEMO and cannot fill (protected change needed).",
    },
    {
      code: "FILL_PRECISION",
      detail: "Fills ignore registry tick/lot size, contract multiplier and quote-currency conversion (protected change needed).",
    },
  ];
  if (instrument.quote !== "USD") {
    nonCryptoBlockers.push({
      code: "NO_QUOTE_CCY_CONVERSION",
      detail: `${instrument.quote}→USD conversion has no production caller; a ${instrument.quote} level would be booked as USD.`,
    });
  }

  if (instrument.venue === "SOLANA_DEX") {
    return {
      providerId: "dexscreener",
      providerReadiness: "READY",
      ingest: paperEnv
        ? { active: true, reason: null }
        : { active: false, reason: `NOT_MARKET_DATA_PAPER: environment is ${input.config.tradingEnvironment}` },
      paperEntryBlockers: [],
    };
  }

  if (instrument.assetClass === "FX_SPOT") {
    const oanda = input.gatewayReadiness.oanda_practice;
    if (oanda === "READY" || oanda === "CONNECTING") {
      return {
        providerId: "oanda_practice",
        providerReadiness: oanda,
        ingest: { active: false, reason: "NO_INGEST_PATH: the worker does not store OANDA quotes" },
        paperEntryBlockers: nonCryptoBlockers,
      };
    }
    const frankfurter = input.gatewayReadiness.frankfurter_fx ?? "READY";
    let ingest: PipelineFacts["ingest"];
    if (!FRANKFURTER_INGESTED.has(instrument.id)) {
      ingest = { active: false, reason: "NO_INGEST_PATH: Frankfurter ingest covers EURUSD and GBPUSD only; OANDA credentials absent" };
    } else if (!paperEnv) {
      ingest = { active: false, reason: `NOT_MARKET_DATA_PAPER: environment is ${input.config.tradingEnvironment}` };
    } else if (!input.config.marketDataPaperFxIngest) {
      ingest = { active: false, reason: "INGEST_DISABLED: marketDataPaperFxIngest=false" };
    } else {
      ingest = { active: true, reason: null };
    }
    return { providerId: "frankfurter_fx", providerReadiness: frankfurter, ingest, paperEntryBlockers: nonCryptoBlockers };
  }

  if (instrument.assetClass === "EQUITY_ETF_PROXY") {
    return {
      providerId: "alpaca_paper",
      providerReadiness: input.gatewayReadiness.alpaca_paper ?? "MISSING_CREDENTIALS",
      ingest: { active: false, reason: "NO_INGEST_PATH: Alpaca is used only for held-mark refresh" },
      paperEntryBlockers: nonCryptoBlockers,
    };
  }

  // Commodities, indices and futures proxies: the gateway routes no provider (registry lists a stub).
  return {
    providerId: null,
    providerReadiness: "NO_ROUTE",
    ingest: { active: false, reason: "NO_INGEST_PATH" },
    paperEntryBlockers: nonCryptoBlockers,
  };
}

export type ScannerObservation = {
  receivedAt: Date;
  eventTime?: Date | null;
  price: number | null;
  bid: number | null;
  ask: number | null;
  /** LIVE | DELAYED | STALE | REPLAY | DEMO, as stored. */
  dataState: string;
  dataOrigin: string | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
};

export type StrategyAssignment = { id: string; name: string; status: string; moduleRef: string | null };

export type ReadinessResult = {
  instrumentId: string;
  state: ReadinessState;
  evaluable: boolean;
  paperExecutable: boolean;
  reasons: ScannerReason[];
  session: { status: SessionStatus; reason: string };
  quote: {
    ageMs: number | null;
    dataState: string | null;
    price: number | null;
    bid: number | null;
    ask: number | null;
    spreadBps: number | null;
    liquidityUsd: number | null;
    volume24hUsd: number | null;
  };
};

const rungOf = (state: ReadinessState) => READINESS_STATES.indexOf(state);

export function spreadBps(bid: number | null, ask: number | null): number | null {
  if (bid === null || ask === null || !Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask < bid) return null;
  const mid = (bid + ask) / 2;
  return ((ask - bid) / mid) * 10_000;
}

export function evaluateReadiness(input: {
  instrument: Instrument;
  enabled: boolean;
  pipeline: PipelineFacts;
  observation: ScannerObservation | null;
  strategies: StrategyAssignment[];
  now: Date;
  /** Quote age above which a LIVE quote is STALE (the engine's liveMaxAgeMs). */
  liveMaxAgeMs: number;
}): ReadinessResult {
  const { instrument, pipeline, observation, now } = input;
  const reasons: ScannerReason[] = [];
  const add = (stage: ReadinessState, code: string, detail: string) => reasons.push({ code, stage, detail });

  const researchOnly = isResearchOnly(instrument);
  if (!canPaperExecute(instrument) && !researchOnly) {
    add("NOT_SUPPORTED", "NO_SUPPORTED_EXECUTION_CAPABILITY", `Capabilities ${instrument.executionCapabilities.join(", ")} have no paper or research path.`);
  }

  if (pipeline.providerId === null) {
    add("NO_PROVIDER", "NO_PROVIDER", `No market-data provider routes ${instrument.id}; the registry lists ${instrument.providerId}, which produces no quote.`);
  } else {
    if (pipeline.providerReadiness !== "READY" && pipeline.providerReadiness !== "CONNECTING") {
      add("PROVIDER_NOT_CONFIGURED", `PROVIDER_${pipeline.providerReadiness}`, `${pipeline.providerId} readiness is ${pipeline.providerReadiness}.`);
    }
    if (!pipeline.ingest.active) {
      add("PROVIDER_NOT_CONFIGURED", "NOT_INGESTED", pipeline.ingest.reason ?? "No observations are stored for this instrument.");
    }
  }

  const session = evaluateSession({ session: instrument.session, now });
  if (session.status !== "OPEN") {
    add("SESSION_CLOSED", `SESSION_${session.status}`, `${instrument.session} session ${session.status.toLowerCase()} (${session.reason}).`);
  }

  const ageMs = observation ? now.getTime() - observation.receivedAt.getTime() : null;
  const spread = observation ? spreadBps(observation.bid, observation.ask) : null;
  if (!observation || observation.price === null || !Number.isFinite(observation.price) || observation.price <= 0) {
    add("NO_RECENT_QUOTE", "NO_QUOTE", observation ? "Latest observation has no price." : "No stored observation for this instrument in the current environment.");
  } else {
    const crypto = instrument.assetClass === "SPOT_CRYPTO_PAIR";
    if (observation.dataState !== "LIVE") {
      add("REFERENCE_ONLY", `DATA_${observation.dataState}`, `Quote is ${observation.dataState}${observation.dataOrigin ? ` (${observation.dataOrigin})` : ""}; reference only, cannot open risk.`);
    } else if (!crypto && spread === null) {
      add("REFERENCE_ONLY", "NO_TWO_SIDED_QUOTE", "No bid/ask; a level without a two-sided quote is a reference rate.");
    }
    if (ageMs !== null && ageMs < -5_000) {
      add("STALE", "FUTURE_TIMESTAMP", "Observation is timestamped in the future; clock skew.");
    } else if (ageMs !== null && ageMs > input.liveMaxAgeMs) {
      add("STALE", "QUOTE_STALE", `Quote age ${Math.round(ageMs / 1000)} s exceeds ${Math.round(input.liveMaxAgeMs / 1000)} s.`);
    }
  }

  if (researchOnly) add("RESEARCH_ONLY", "RESEARCH_ONLY", "Index level or research-only instrument: no paper fills by design.");

  for (const blocker of pipeline.paperEntryBlockers) add("OBSERVABLE", blocker.code, blocker.detail);
  if (!input.enabled) add("OBSERVABLE", "MARKET_DISABLED", "Disabled in the Market Selector.");
  if (!input.strategies.some((s) => s.status === "ACTIVE")) add("OBSERVABLE", "NO_STRATEGY_INSTANCE", "No ACTIVE StrategyInstance covers this instrument.");

  let state: ReadinessState = "PAPER_EXECUTABLE";
  for (const reason of reasons) if (rungOf(reason.stage) < rungOf(state)) state = reason.stage;
  // OBSERVABLE-stage blockers on a research-only instrument are moot: it is RESEARCH_ONLY.
  if (researchOnly && state === "OBSERVABLE") state = "RESEARCH_ONLY";

  return {
    instrumentId: instrument.id,
    state,
    evaluable: EVALUABLE.includes(state),
    paperExecutable: state === "PAPER_EXECUTABLE",
    reasons,
    session: { status: session.status, reason: session.reason },
    quote: {
      ageMs,
      dataState: observation?.dataState ?? null,
      price: observation?.price ?? null,
      bid: observation?.bid ?? null,
      ask: observation?.ask ?? null,
      spreadBps: spread,
      liquidityUsd: observation?.liquidityUsd ?? null,
      volume24hUsd: observation?.volume24hUsd ?? null,
    },
  };
}

/**
 * The readiness ladder answers one question (can this market be paper-traded now?) with one state. An operator
 * also needs two separate facts that the single state hides: whether usable market data exists, and whether an
 * execution path exists. A market can have years of research history and a live quote yet no execution path,
 * or the reverse. Derived from the same reasons, so the two views can never disagree with the ladder.
 */
export type ReadinessSplit = {
  liveQuote: { ready: boolean; state: "LIVE_QUOTE" | "NO_PROVIDER" | "PROVIDER_NOT_CONFIGURED" | "SESSION_CLOSED" | "NO_RECENT_QUOTE" | "REFERENCE_ONLY" | "STALE"; reasons: ScannerReason[] };
  execution: { ready: boolean; state: "PAPER_EXECUTABLE" | "RESEARCH_ONLY_BY_DESIGN" | "NOT_SUPPORTED" | "BLOCKED"; blockers: ScannerReason[] };
};

const QUOTE_STAGES: readonly ReadinessState[] = ["NO_PROVIDER", "PROVIDER_NOT_CONFIGURED", "SESSION_CLOSED", "NO_RECENT_QUOTE", "REFERENCE_ONLY", "STALE"];

export function splitReadiness(readiness: Pick<ReadinessResult, "reasons" | "paperExecutable">): ReadinessSplit {
  const quoteReasons = readiness.reasons.filter((r) => QUOTE_STAGES.includes(r.stage));
  const first = QUOTE_STAGES.find((stage) => quoteReasons.some((r) => r.stage === stage));
  const blockers = readiness.reasons.filter((r) => !QUOTE_STAGES.includes(r.stage));
  const path = blockers.some((r) => r.stage === "NOT_SUPPORTED") ? "NOT_SUPPORTED" : blockers.some((r) => r.stage === "RESEARCH_ONLY") ? "RESEARCH_ONLY_BY_DESIGN" : blockers.length ? "BLOCKED" : "PAPER_EXECUTABLE";
  // An execution path with no live quote still cannot fill: `ready` needs both, exactly as the ladder does.
  const quoteBlocks = path === "PAPER_EXECUTABLE" && !readiness.paperExecutable;
  return {
    liveQuote: { ready: first === undefined, state: (first ?? "LIVE_QUOTE") as ReadinessSplit["liveQuote"]["state"], reasons: quoteReasons },
    execution: { ready: readiness.paperExecutable, state: quoteBlocks ? "BLOCKED" : path, blockers: quoteBlocks ? quoteReasons : blockers },
  };
}

export type VolatilityRegime = "INSUFFICIENT_DATA" | "CALM" | "NORMAL" | "TURBULENT";
export type VolatilityView = { samples: number; stdevLogReturnBps: number | null; regime: VolatilityRegime };

export const VOLATILITY_MIN_RETURNS = 20;

/** Realised volatility of consecutive observations (per observation interval) and a simple regime label. */
export function realisedVolatility(points: Array<{ t: number; price: number }>): VolatilityView {
  const sorted = points.filter((p) => Number.isFinite(p.price) && p.price > 0).sort((a, b) => a.t - b.t);
  const returns: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) returns.push(Math.log(sorted[i]!.price / sorted[i - 1]!.price));
  if (returns.length < VOLATILITY_MIN_RETURNS) return { samples: returns.length, stdevLogReturnBps: null, regime: "INSUFFICIENT_DATA" };
  const full = stdev(returns);
  const recent = stdev(returns.slice(-Math.max(5, Math.floor(returns.length / 4))));
  const ratio = full > 0 ? recent / full : 1;
  const regime: VolatilityRegime = ratio < 0.67 ? "CALM" : ratio > 1.5 ? "TURBULENT" : "NORMAL";
  return { samples: returns.length, stdevLogReturnBps: full * 10_000, regime };
}

function mean(xs: number[]): number {
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1));
}

export type CostEstimate = {
  totalBps: number;
  feeBps: number;
  spreadBps: number;
  slippageBps: number;
  basis: "OBSERVED_SPREAD" | "ESTIMATED_SPREAD";
};

/** Round trip: fee on both legs, the spread once, slippage on both legs. */
export function estimateRoundTripCost(input: { feeBps: number; observedSpreadBps: number | null; spreadBpsEstimate: number; slippageBps: number }): CostEstimate {
  const spread = input.observedSpreadBps ?? input.spreadBpsEstimate;
  const fee = 2 * input.feeBps;
  const slippage = 2 * input.slippageBps;
  return {
    totalBps: fee + spread + slippage,
    feeBps: fee,
    spreadBps: spread,
    slippageBps: slippage,
    basis: input.observedSpreadBps === null ? "ESTIMATED_SPREAD" : "OBSERVED_SPREAD",
  };
}

export type ShadowEvidenceRow = {
  instrumentId: string;
  modelVersionId: string;
  family: string;
  version: string;
  state: string;
  probability: number;
  entryThreshold: number;
  /** Realised net return as a fraction (after the model's own costs). */
  realisedNet: number;
  costBpsApplied: number;
  horizonBars: number;
};

export type InstrumentEvidence = {
  status: "SUFFICIENT" | "INSUFFICIENT";
  modelVersionId: string;
  family: string;
  version: string;
  modelState: string;
  signals: number;
  resolved: number;
  grossMeanBps: number;
  grossLowerBps: number;
  grossUpperBps: number;
  modelCostBps: number;
  basis: "HYPOTHETICAL_SHADOW";
  method: string;
};

export const EVIDENCE_MIN_SIGNALS = 10;
const EXCLUDED_MODEL_STATES = new Set(["REJECTED", "RETIRED", "FAILED", "UNKNOWN"]);

/**
 * Per instrument, the gross edge of one model's signals (p ≥ its entry threshold) from resolved hypothetical
 * shadow outcomes, with a 95% interval whose effective sample is n / horizonBars (overlapping labels).
 * The model with the most signals is used, not the best looking one, so the choice is not a winner's curse.
 */
export function summariseShadowEvidence(rows: ShadowEvidenceRow[], minSignals = EVIDENCE_MIN_SIGNALS): Map<string, InstrumentEvidence> {
  const byInstrumentModel = new Map<string, Map<string, ShadowEvidenceRow[]>>();
  for (const row of rows) {
    if (EXCLUDED_MODEL_STATES.has(row.state)) continue;
    if (!Number.isFinite(row.realisedNet) || !Number.isFinite(row.probability)) continue;
    const models = byInstrumentModel.get(row.instrumentId) ?? new Map<string, ShadowEvidenceRow[]>();
    const list = models.get(row.modelVersionId) ?? [];
    list.push(row);
    models.set(row.modelVersionId, list);
    byInstrumentModel.set(row.instrumentId, models);
  }
  const out = new Map<string, InstrumentEvidence>();
  for (const [instrumentId, models] of byInstrumentModel) {
    const candidates = [...models.entries()]
      .map(([modelVersionId, list]) => ({ modelVersionId, list, signals: list.filter((r) => r.probability >= r.entryThreshold) }))
      .sort((a, b) => b.signals.length - a.signals.length || (a.modelVersionId < b.modelVersionId ? -1 : 1));
    const best = candidates[0]!;
    const head = best.list[0]!;
    const gross = best.signals.map((r) => r.realisedNet * 10_000 + r.costBpsApplied);
    const horizon = Math.max(1, ...best.list.map((r) => r.horizonBars));
    const nEff = Math.max(1, Math.floor(gross.length / horizon));
    const m = gross.length ? mean(gross) : 0;
    const half = gross.length >= 2 ? (1.96 * stdev(gross)) / Math.sqrt(nEff) : Number.POSITIVE_INFINITY;
    out.set(instrumentId, {
      status: gross.length >= minSignals && Number.isFinite(half) ? "SUFFICIENT" : "INSUFFICIENT",
      modelVersionId: best.modelVersionId,
      family: head.family,
      version: head.version,
      modelState: head.state,
      signals: gross.length,
      resolved: best.list.length,
      grossMeanBps: m,
      grossLowerBps: m - half,
      grossUpperBps: m + half,
      modelCostBps: best.list.length ? mean(best.list.map((r) => r.costBpsApplied)) : 0,
      basis: "HYPOTHETICAL_SHADOW",
      method: `mean gross return of ${gross.length} signals; 95% interval with n_eff = n / ${horizon} horizon bars`,
    });
  }
  return out;
}

export type OpportunityDecision = "SELECTED" | "ABSTAIN" | "NOT_EVALUATED";

export type OpportunityInput = {
  instrumentId: string;
  symbol: string;
  assetClass: AssetClass;
  readiness: ReadinessResult;
  evidence: InstrumentEvidence | null;
  cost: CostEstimate;
  /** Correlation of returns with current holdings in [-1, 1]; null when unknown. */
  correlationWithHoldings: number | null;
};

export type OpportunityRow = {
  rank: number | null;
  instrumentId: string;
  symbol: string;
  assetClass: AssetClass;
  state: ReadinessState;
  decision: OpportunityDecision;
  reasons: Array<{ code: string; detail: string }>;
  expectedNetBps: number | null;
  netLowerBps: number | null;
  netUpperBps: number | null;
  appliedCostBps: number | null;
  correlationWithHoldings: number | null;
  correlationPenaltyBps: number | null;
  score: number | null;
  evidence: InstrumentEvidence | null;
};

export type OpportunityLeaderboard = {
  rows: OpportunityRow[];
  selected: number;
  abstained: number;
  notEvaluated: number;
  method: string;
};

export const CORRELATION_PENALTY = 0.5;

export function rankOpportunities(inputs: OpportunityInput[], options: { correlationPenalty?: number } = {}): OpportunityLeaderboard {
  const k = options.correlationPenalty ?? CORRELATION_PENALTY;
  const rows: OpportunityRow[] = inputs.map((input) => {
    const base = {
      rank: null,
      instrumentId: input.instrumentId,
      symbol: input.symbol,
      assetClass: input.assetClass,
      state: input.readiness.state,
      correlationWithHoldings: input.correlationWithHoldings,
      evidence: input.evidence,
    };
    const empty = { expectedNetBps: null, netLowerBps: null, netUpperBps: null, appliedCostBps: null, correlationPenaltyBps: null, score: null };
    if (!input.readiness.evaluable) {
      const first = input.readiness.reasons.find((r) => r.stage === input.readiness.state);
      return { ...base, ...empty, decision: "NOT_EVALUATED", reasons: [{ code: input.readiness.state, detail: first?.detail ?? input.readiness.state }] };
    }
    const ev = input.evidence;
    if (!ev) {
      return { ...base, ...empty, decision: "ABSTAIN", reasons: [{ code: "NO_MODEL_EVIDENCE", detail: "No resolved GENESIS shadow evidence for this instrument; no forecast, so no edge is claimed." }] };
    }
    if (ev.status !== "SUFFICIENT") {
      return { ...base, ...empty, decision: "ABSTAIN", reasons: [{ code: "INSUFFICIENT_EVIDENCE", detail: `${ev.signals} resolved signals (< ${EVIDENCE_MIN_SIGNALS}).` }] };
    }
    // Conservative: the larger of the current cost estimate and the cost the evidence was measured under.
    const cost = Math.max(input.cost.totalBps, ev.modelCostBps);
    const net = ev.grossMeanBps - cost;
    const lower = ev.grossLowerBps - cost;
    const upper = ev.grossUpperBps - cost;
    const rho = input.correlationWithHoldings === null ? 0 : Math.max(0, Math.min(1, input.correlationWithHoldings));
    const penalty = net > 0 ? net * k * rho : 0;
    const numbers = { expectedNetBps: net, netLowerBps: lower, netUpperBps: upper, appliedCostBps: cost, correlationPenaltyBps: penalty, score: net - penalty };
    if (net <= 0) {
      return { ...base, ...numbers, decision: "ABSTAIN", reasons: [{ code: "COSTS_EXCEED_EDGE", detail: `Gross edge ${ev.grossMeanBps.toFixed(1)} bps does not cover ${cost.toFixed(1)} bps round-trip costs.` }] };
    }
    if (lower <= 0) {
      return { ...base, ...numbers, decision: "ABSTAIN", reasons: [{ code: "EDGE_NOT_SIGNIFICANT", detail: `Net interval [${lower.toFixed(1)}, ${upper.toFixed(1)}] bps includes zero.` }] };
    }
    if (!input.readiness.paperExecutable) {
      const blockers = input.readiness.reasons.filter((r) => r.stage === "OBSERVABLE" || r.stage === "RESEARCH_ONLY").map((r) => r.code);
      return { ...base, ...numbers, decision: "ABSTAIN", reasons: [{ code: "NOT_PAPER_EXECUTABLE", detail: `Positive net edge but cannot trade: ${blockers.join(", ") || input.readiness.state}.` }] };
    }
    const reasons = [{ code: "NET_EDGE_AFTER_COSTS", detail: `Net ${net.toFixed(1)} bps, interval [${lower.toFixed(1)}, ${upper.toFixed(1)}] bps after ${cost.toFixed(1)} bps costs.` }];
    if (penalty > 0) reasons.push({ code: "CORRELATION_PENALTY", detail: `Order lowered by ${penalty.toFixed(1)} bps for correlation ${rho.toFixed(2)} with holdings.` });
    return { ...base, ...numbers, decision: "SELECTED", reasons };
  });

  const order: Record<OpportunityDecision, number> = { SELECTED: 0, ABSTAIN: 1, NOT_EVALUATED: 2 };
  const desc = (a: number | null, b: number | null) => (b ?? Number.NEGATIVE_INFINITY) - (a ?? Number.NEGATIVE_INFINITY);
  rows.sort(
    (a, b) =>
      order[a.decision] - order[b.decision] ||
      desc(a.score, b.score) ||
      desc(a.netLowerBps, b.netLowerBps) ||
      (a.instrumentId < b.instrumentId ? -1 : a.instrumentId > b.instrumentId ? 1 : 0),
  );
  let rank = 0;
  for (const row of rows) if (row.decision === "SELECTED") row.rank = ++rank;
  return {
    rows,
    selected: rank,
    abstained: rows.filter((r) => r.decision === "ABSTAIN").length,
    notEvaluated: rows.filter((r) => r.decision === "NOT_EVALUATED").length,
    method:
      "Expected net edge = gross mean of model signals (hypothetical shadow outcomes) minus max(current round-trip cost, the evidence's cost). " +
      "Selected only when paper-executable and the 95% net interval is above zero. Ordered by net edge less a correlation penalty " +
      `(${k} × max(0, ρ) × net); volatility is not ranked on and no diversification is forced.`,
  };
}

export type MarketPnl = {
  instrumentId: string;
  realisedPnlUsd: string;
  realisedEntries: number;
  openPositions: number;
  openCostBasisUsd: string;
};

/** Bucket for ledger entries with no order (so no market): reported, never folded into a market. */
export const UNATTRIBUTED_MARKET = "UNATTRIBUTED";

/**
 * Paper P&L by registry market from the ledger: REALIZED_PNL entries joined to their order's instrument or
 * pair, plus open positions at cost. Pairs outside the registry are Solana pools (the only ingest that
 * creates them). Unrealised P&L is not computed here: a missing mark is not zero.
 */
export function attributePnlByMarket(input: {
  instruments: Instrument[];
  realised: Array<{ amountUsd: string; instrumentId: string | null; pairAddress: string | null }>;
  positions: Array<{ pairAddress: string; baseQty: string; avgCostUsd: string }>;
}): Map<string, MarketPnl> {
  const ids = new Set(input.instruments.map((i) => i.id));
  const solana = input.instruments.find((i) => i.venue === "SOLANA_DEX")?.id ?? "solana:spot:universe";
  const resolve = (instrumentId: string | null, pair: string | null) =>
    instrumentId && ids.has(instrumentId) ? instrumentId : pair && ids.has(pair) ? pair : pair ? solana : UNATTRIBUTED_MARKET;
  const out = new Map<string, { realised: ReturnType<typeof d>; entries: number; open: number; cost: ReturnType<typeof d> }>();
  const get = (id: string) => {
    let row = out.get(id);
    if (!row) {
      row = { realised: d("0"), entries: 0, open: 0, cost: d("0") };
      out.set(id, row);
    }
    return row;
  };
  for (const entry of input.realised) {
    const row = get(resolve(entry.instrumentId, entry.pairAddress));
    row.realised = row.realised.plus(d(entry.amountUsd));
    row.entries += 1;
  }
  for (const position of input.positions) {
    const q = d(position.baseQty);
    if (q.lte(0)) continue;
    const row = get(resolve(null, position.pairAddress));
    row.open += 1;
    row.cost = row.cost.plus(q.times(d(position.avgCostUsd)));
  }
  return new Map(
    [...out.entries()].map(([id, row]) => [
      id,
      { instrumentId: id, realisedPnlUsd: usd(row.realised), realisedEntries: row.entries, openPositions: row.open, openCostBasisUsd: usd(row.cost) },
    ]),
  );
}

/** Map a research instrument key (e.g. "EURUSD", "fx:EURUSD", "yahoo:SPY") to a registry id, or null. */
export function matchInstrumentKey(key: string, instruments: Instrument[]): string | null {
  const exact = instruments.find((i) => i.id === key);
  if (exact) return exact.id;
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const tail = norm(key.split(":").pop() ?? key);
  if (!tail) return null;
  const hit = instruments.find((i) => i.venue !== "SOLANA_DEX" && (norm(i.symbol) === tail || norm(i.providerSymbol) === tail));
  return hit?.id ?? null;
}
