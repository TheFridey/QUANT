import { SEED_INSTRUMENTS, type Instrument } from "@odin/shared";
import { describe, expect, it } from "vitest";
import {
  attributePnlByMarket,
  describePipeline,
  estimateRoundTripCost,
  evaluateReadiness,
  matchInstrumentKey,
  rankOpportunities,
  realisedVolatility,
  summariseShadowEvidence,
  type InstrumentEvidence,
  type ScannerObservation,
  type OpportunityInput,
  type PipelineFacts,
  type ReadinessResult,
  type ShadowEvidenceRow,
  splitReadiness,
} from "./opportunity-scanner.js";

// Wednesday 4 Nov 2026 10:00 ET (FX and US cash session open); Saturday 7 Nov 2026 10:00 ET (FX weekend).
const WEDNESDAY = new Date("2026-11-04T15:00:00Z");
const SATURDAY = new Date("2026-11-07T15:00:00Z");
const LIVE_MAX_AGE = 45_000;

const inst = (id: string): Instrument => SEED_INSTRUMENTS.find((i) => i.id === id)!;
const strategies = [{ id: "si1", name: "pulse", status: "ACTIVE", moduleRef: "builtin:pulse" }];
const readiness = { frankfurter_fx: "READY", alpaca_paper: "READY", oanda_practice: "MISSING_CREDENTIALS" } as const;
const paperConfig = { tradingEnvironment: "MARKET_DATA_PAPER", marketDataPaperFxIngest: true };
const productionConfig = { tradingEnvironment: "MARKET_DATA_PAPER", marketDataPaperFxIngest: false };

const obs = (now: Date, over: Partial<ScannerObservation> = {}): ScannerObservation => ({
  receivedAt: new Date(now.getTime() - 5_000),
  price: 1.08,
  bid: 1.0799,
  ask: 1.0801,
  dataState: "LIVE",
  dataOrigin: "LIVE_FEED",
  liquidityUsd: 1_000_000,
  volume24hUsd: 5_000_000,
  ...over,
});

const ready: PipelineFacts = { providerId: "test", providerReadiness: "READY", ingest: { active: true, reason: null }, paperEntryBlockers: [] };

function ladder(id: string, over: { now?: Date; observation?: ScannerObservation | null; pipeline?: PipelineFacts; enabled?: boolean; config?: typeof paperConfig } = {}) {
  const instrument = inst(id);
  const now = over.now ?? WEDNESDAY;
  return evaluateReadiness({
    instrument,
    enabled: over.enabled ?? true,
    pipeline: over.pipeline ?? describePipeline(instrument, { gatewayReadiness: readiness, config: over.config ?? paperConfig }),
    observation: over.observation === undefined ? obs(now) : over.observation,
    strategies,
    now,
    liveMaxAgeMs: LIVE_MAX_AGE,
  });
}

describe("readiness ladder", () => {
  it("never marks a registry-only instrument (no observation) as executable or observable", () => {
    for (const instrument of SEED_INSTRUMENTS) {
      const result = evaluateReadiness({ instrument, enabled: true, pipeline: ready, observation: null, strategies, now: WEDNESDAY, liveMaxAgeMs: LIVE_MAX_AGE });
      expect(result.evaluable).toBe(false);
      expect(result.paperExecutable).toBe(false);
      expect(["NO_RECENT_QUOTE", "SESSION_CLOSED"]).toContain(result.state);
    }
  });

  it("gold has no provider; production FX is not configured (ingest off)", () => {
    expect(ladder("commodity:XAUUSD").state).toBe("NO_PROVIDER");
    expect(ladder("commodity:WTI").state).toBe("NO_PROVIDER");
    const fx = ladder("fx:EURUSD", { config: productionConfig, observation: null });
    expect(fx.state).toBe("PROVIDER_NOT_CONFIGURED");
    expect(fx.reasons.map((r) => r.detail).join(" ")).toContain("marketDataPaperFxIngest=false");
    // USDJPY has no ingest path at all and needs currency conversion.
    const jpy = ladder("fx:USDJPY");
    expect(jpy.state).toBe("PROVIDER_NOT_CONFIGURED");
    expect(jpy.reasons.map((r) => r.code)).toContain("NO_QUOTE_CCY_CONVERSION");
  });

  it("ETFs without credentials are PROVIDER_NOT_CONFIGURED", () => {
    const instrument = inst("etf:SPY");
    const pipeline = describePipeline(instrument, { gatewayReadiness: { alpaca_paper: "MISSING_CREDENTIALS" }, config: paperConfig });
    const result = ladder("etf:SPY", { pipeline });
    expect(result.state).toBe("PROVIDER_NOT_CONFIGURED");
    expect(result.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(["PROVIDER_MISSING_CREDENTIALS", "NOT_INGESTED"]));
  });

  it("a stale LIVE quote is STALE", () => {
    const result = ladder("solana:spot:universe", { observation: obs(WEDNESDAY, { receivedAt: new Date(WEDNESDAY.getTime() - 120_000) }) });
    expect(result.state).toBe("STALE");
    expect(result.quote.ageMs).toBe(120_000);
  });

  it("weekend FX is SESSION_CLOSED even with a quote", () => {
    const result = ladder("fx:EURUSD", { now: SATURDAY, pipeline: ready });
    expect(result.state).toBe("SESSION_CLOSED");
    expect(result.session).toEqual({ status: "CLOSED", reason: "FX_WEEKEND" });
  });

  it("a reference-rate (DELAYED, no bid/ask) FX quote is REFERENCE_ONLY, not executable", () => {
    const result = ladder("fx:EURUSD", { observation: obs(WEDNESDAY, { dataState: "DELAYED", dataOrigin: "DELAYED_FEED", bid: null, ask: null }) });
    expect(result.state).toBe("REFERENCE_ONLY");
    expect(result.paperExecutable).toBe(false);
    // A LIVE level without a two-sided quote is still a reference rate for non-crypto.
    expect(ladder("fx:EURUSD", { pipeline: ready, observation: obs(WEDNESDAY, { bid: null, ask: null }) }).state).toBe("REFERENCE_ONLY");
  });

  it("non-crypto with a fresh live quote stays OBSERVABLE behind the pipeline blockers", () => {
    const result = ladder("fx:EURUSD");
    expect(result.state).toBe("OBSERVABLE");
    expect(result.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(["FRESHNESS_GATE", "FILL_PRECISION"]));
    expect(result.quote.spreadBps).toBeCloseTo(1.85, 1);
  });

  it("indices with a fresh quote are RESEARCH_ONLY", () => {
    expect(ladder("index:SPX", { pipeline: ready }).state).toBe("RESEARCH_ONLY");
  });

  it("Solana with a fresh LIVE quote, enabled and assigned, is PAPER_EXECUTABLE; disabled is not", () => {
    expect(ladder("solana:spot:universe").state).toBe("PAPER_EXECUTABLE");
    const disabled = ladder("solana:spot:universe", { enabled: false });
    expect(disabled.state).toBe("OBSERVABLE");
    expect(disabled.reasons.map((r) => r.code)).toContain("MARKET_DISABLED");
  });
});

const evidence = (over: Partial<InstrumentEvidence> = {}): InstrumentEvidence => ({
  status: "SUFFICIENT",
  modelVersionId: "mv1",
  family: "fam",
  version: "1",
  modelState: "SHADOW",
  signals: 50,
  resolved: 120,
  grossMeanBps: 200,
  grossLowerBps: 150,
  grossUpperBps: 250,
  modelCostBps: 60,
  basis: "HYPOTHETICAL_SHADOW",
  method: "test",
  ...over,
});

const cost = estimateRoundTripCost({ feeBps: 30, observedSpreadBps: null, spreadBpsEstimate: 5, slippageBps: 5 }); // 75 bps

const executable = (id: string): ReadinessResult => ({
  instrumentId: id,
  state: "PAPER_EXECUTABLE",
  evaluable: true,
  paperExecutable: true,
  reasons: [],
  session: { status: "OPEN", reason: "CRYPTO_24x7" },
  quote: { ageMs: 1, dataState: "LIVE", price: 1, bid: null, ask: null, spreadBps: null, liquidityUsd: null, volume24hUsd: null },
});

const input = (id: string, over: Partial<OpportunityInput> = {}): OpportunityInput => ({
  instrumentId: id,
  symbol: id,
  assetClass: "SPOT_CRYPTO_PAIR",
  readiness: executable(id),
  evidence: evidence(),
  cost,
  correlationWithHoldings: null,
  ...over,
});

describe("opportunity ranking", () => {
  it("abstains without model evidence and with insufficient evidence", () => {
    const board = rankOpportunities([input("a", { evidence: null }), input("b", { evidence: evidence({ status: "INSUFFICIENT", signals: 3 }) })]);
    expect(board.selected).toBe(0);
    expect(board.rows.map((r) => [r.instrumentId, r.decision, r.reasons[0]!.code])).toEqual([
      ["a", "ABSTAIN", "NO_MODEL_EVIDENCE"],
      ["b", "ABSTAIN", "INSUFFICIENT_EVIDENCE"],
    ]);
    expect(board.rows.every((r) => r.rank === null && r.expectedNetBps === null)).toBe(true);
  });

  it("abstains when costs exceed the edge, and when the interval includes zero", () => {
    const board = rankOpportunities([
      input("costly", { evidence: evidence({ grossMeanBps: 70, grossLowerBps: 40, grossUpperBps: 100 }) }),
      input("noisy", { evidence: evidence({ grossMeanBps: 120, grossLowerBps: 20, grossUpperBps: 220 }) }),
    ]);
    const byId = Object.fromEntries(board.rows.map((r) => [r.instrumentId, r]));
    expect(byId.costly!.decision).toBe("ABSTAIN");
    expect(byId.costly!.reasons[0]!.code).toBe("COSTS_EXCEED_EDGE");
    expect(byId.costly!.expectedNetBps).toBe(-5);
    expect(byId.noisy!.reasons[0]!.code).toBe("EDGE_NOT_SIGNIFICANT");
  });

  it("uses the larger of current and evidence costs", () => {
    const board = rankOpportunities([input("a", { evidence: evidence({ modelCostBps: 100 }) })]);
    expect(board.rows[0]!.appliedCostBps).toBe(100);
    expect(board.rows[0]!.expectedNetBps).toBe(100);
  });

  it("does not select a positive edge that cannot trade, and does not evaluate non-evaluable rows", () => {
    const observable: ReadinessResult = { ...executable("fx"), state: "OBSERVABLE", paperExecutable: false, reasons: [{ code: "FRESHNESS_GATE", stage: "OBSERVABLE", detail: "x" }] };
    const gold: ReadinessResult = { ...executable("gold"), state: "NO_PROVIDER", evaluable: false, paperExecutable: false, reasons: [{ code: "NO_PROVIDER", stage: "NO_PROVIDER", detail: "no route" }] };
    const board = rankOpportunities([input("fx", { readiness: observable }), input("gold", { readiness: gold })]);
    expect(board.rows.find((r) => r.instrumentId === "fx")!.reasons[0]!.code).toBe("NOT_PAPER_EXECUTABLE");
    const goldRow = board.rows.find((r) => r.instrumentId === "gold")!;
    expect(goldRow.decision).toBe("NOT_EVALUATED");
    expect(goldRow.reasons[0]).toEqual({ code: "NO_PROVIDER", detail: "no route" });
    expect(board.selected).toBe(0);
  });

  it("penalises correlation with holdings in the order only", () => {
    const board = rankOpportunities([input("held", { correlationWithHoldings: 1 }), input("fresh", { correlationWithHoldings: 0 })]);
    expect(board.rows.map((r) => [r.instrumentId, r.rank, r.decision])).toEqual([
      ["fresh", 1, "SELECTED"],
      ["held", 2, "SELECTED"],
    ]);
    expect(board.rows[1]!.correlationPenaltyBps).toBeCloseTo(62.5);
  });

  it("breaks ties deterministically by instrument id regardless of input order", () => {
    const a = rankOpportunities([input("zeta"), input("alpha"), input("mid")]);
    const b = rankOpportunities([input("mid"), input("zeta"), input("alpha")]);
    expect(a.rows.map((r) => r.instrumentId)).toEqual(["alpha", "mid", "zeta"]);
    expect(b.rows.map((r) => [r.instrumentId, r.rank])).toEqual(a.rows.map((r) => [r.instrumentId, r.rank]));
  });

  it("does not rank on volatility (no volatility input) and does not force diversification", () => {
    const board = rankOpportunities([input("a", { evidence: null }), input("b", { evidence: null, assetClass: "FX_SPOT" })]);
    expect(board.selected).toBe(0);
    expect(board.method).toContain("no diversification is forced");
  });
});

describe("evidence, costs, volatility, P&L", () => {
  const row = (over: Partial<ShadowEvidenceRow>): ShadowEvidenceRow => ({
    instrumentId: "fx:EURUSD",
    modelVersionId: "m1",
    family: "f",
    version: "1",
    state: "SHADOW",
    probability: 0.7,
    entryThreshold: 0.55,
    realisedNet: 0.001,
    costBpsApplied: 10,
    horizonBars: 1,
    ...over,
  });

  it("summarises signals only, adds back the evidence cost and excludes rejected models", () => {
    const rows = [
      ...Array.from({ length: 12 }, (_, i) => row({ realisedNet: i % 2 ? 0.002 : 0 })),
      row({ probability: 0.4, realisedNet: -0.05 }),
      ...Array.from({ length: 40 }, () => row({ modelVersionId: "m0", state: "REJECTED" })),
    ];
    const ev = summariseShadowEvidence(rows).get("fx:EURUSD")!;
    expect(ev.modelVersionId).toBe("m1");
    expect(ev.signals).toBe(12);
    expect(ev.resolved).toBe(13);
    expect(ev.grossMeanBps).toBeCloseTo(20);
    expect(ev.grossLowerBps).toBeLessThan(20);
    expect(ev.status).toBe("SUFFICIENT");
    expect(summariseShadowEvidence(rows.slice(0, 5)).get("fx:EURUSD")!.status).toBe("INSUFFICIENT");
  });

  it("estimates round-trip cost from an observed spread when available", () => {
    expect(estimateRoundTripCost({ feeBps: 30, observedSpreadBps: 2, spreadBpsEstimate: 5, slippageBps: 5 })).toEqual({ totalBps: 72, feeBps: 60, spreadBps: 2, slippageBps: 10, basis: "OBSERVED_SPREAD" });
  });

  it("reports volatility only with enough returns", () => {
    expect(realisedVolatility([{ t: 1, price: 1 }, { t: 2, price: 1.01 }]).regime).toBe("INSUFFICIENT_DATA");
    const points = Array.from({ length: 60 }, (_, i) => ({ t: i, price: 100 * (1 + 0.001 * Math.sin(i)) }));
    const vol = realisedVolatility(points);
    expect(vol.samples).toBe(59);
    expect(vol.stdevLogReturnBps).toBeGreaterThan(0);
  });

  it("attributes realised P&L and open cost by market; unknown pairs are Solana pools", () => {
    const pnl = attributePnlByMarket({
      instruments: SEED_INSTRUMENTS,
      realised: [
        { amountUsd: "10.5", instrumentId: null, pairAddress: "PoolAddr1" },
        { amountUsd: "-2", instrumentId: "fx:EURUSD", pairAddress: "fx:EURUSD" },
        { amountUsd: "1", instrumentId: null, pairAddress: "PoolAddr2" },
        { amountUsd: "4", instrumentId: null, pairAddress: null },
      ],
      positions: [
        { pairAddress: "PoolAddr1", baseQty: "2", avgCostUsd: "3" },
        { pairAddress: "PoolAddr3", baseQty: "0", avgCostUsd: "3" },
      ],
    });
    expect(pnl.get("solana:spot:universe")).toMatchObject({ realisedPnlUsd: "11.50000000", realisedEntries: 2, openPositions: 1, openCostBasisUsd: "6.00000000" });
    expect(pnl.get("fx:EURUSD")).toMatchObject({ realisedPnlUsd: "-2.00000000", openPositions: 0 });
    expect(pnl.get("UNATTRIBUTED")).toMatchObject({ realisedPnlUsd: "4.00000000", realisedEntries: 1 });
  });

  it("maps research instrument keys to registry ids", () => {
    expect(matchInstrumentKey("fx:EURUSD", SEED_INSTRUMENTS)).toBe("fx:EURUSD");
    expect(matchInstrumentKey("yahoo:SPY", SEED_INSTRUMENTS)).toBe("etf:SPY");
    expect(matchInstrumentKey("EUR/USD", SEED_INSTRUMENTS)).toBe("fx:EURUSD");
    expect(matchInstrumentKey("TEST:GENESIS", SEED_INSTRUMENTS)).toBeNull();
  });
});

describe("market-data readiness and execution readiness are separate facts", () => {
  const reason = (stage: string, code: string) => ({ stage, code, detail: code }) as never;
  it("a live two-sided quote with no execution path is data-ready and execution-blocked", () => {
    const split = splitReadiness({ paperExecutable: false, reasons: [reason("OBSERVABLE", "FRESHNESS_GATE"), reason("OBSERVABLE", "NO_STRATEGY_INSTANCE")] });
    expect(split.liveQuote).toMatchObject({ ready: true, state: "LIVE_QUOTE" });
    expect(split.execution).toMatchObject({ ready: false, state: "BLOCKED" });
    expect(split.execution.blockers.map((b) => b.code)).toEqual(["FRESHNESS_GATE", "NO_STRATEGY_INSTANCE"]);
  });
  it("no provider is a data problem; the execution blockers are still listed on their own", () => {
    const split = splitReadiness({ paperExecutable: false, reasons: [reason("NO_PROVIDER", "NO_PROVIDER"), reason("NO_RECENT_QUOTE", "NO_QUOTE"), reason("OBSERVABLE", "FILL_PRECISION")] });
    expect(split.liveQuote).toMatchObject({ ready: false, state: "NO_PROVIDER" });
    expect(split.liveQuote.reasons).toHaveLength(2);
    expect(split.execution.blockers.map((b) => b.code)).toEqual(["FILL_PRECISION"]);
  });
  it("an execution path without a live quote is not ready: both are needed to fill", () => {
    const split = splitReadiness({ paperExecutable: false, reasons: [reason("STALE", "QUOTE_STALE")] });
    expect(split.liveQuote.state).toBe("STALE");
    expect(split.execution).toMatchObject({ ready: false, state: "BLOCKED" });
    expect(split.execution.blockers.map((b) => b.code)).toEqual(["QUOTE_STALE"]);
  });
  it("research-only instruments and a clear path are named as such", () => {
    expect(splitReadiness({ paperExecutable: false, reasons: [reason("RESEARCH_ONLY", "RESEARCH_ONLY")] }).execution.state).toBe("RESEARCH_ONLY_BY_DESIGN");
    expect(splitReadiness({ paperExecutable: true, reasons: [] })).toMatchObject({ liveQuote: { ready: true }, execution: { ready: true, state: "PAPER_EXECUTABLE", blockers: [] } });
  });
});
