import { d, usd } from "@odin/shared";
import { describe, expect, it } from "vitest";
import { collectTimestamps, entryView, viewHash, type PitDecision, type PitObservation, type PointInTimeSource } from "./entry-view.js";
import {
  aggregateFeedback,
  buildTrainingData,
  closedLotsNewestFirst,
  MAX_PRE_DECISION_PRICE_AGE_SECONDS,
  counterfactualOutcome,
  decisionRecordFromSnapshot,
  FEEDBACK_RULES,
  feedbackRowFromHypothetical,
  feedbackRowFromLot,
  lotFeedback,
  type FeedbackRow,
  type LotFeedback,
  type RejectedOpportunity,
  type StoredEntrySnapshot,
} from "./feedback.js";
import { reconstructLots, type Lot, type LotFillInput, type MarkObservation } from "./lot-history.js";

const ACCOUNT = "acct_fb";
const PAIR = "pairFB";
const T0 = Date.UTC(2026, 10, 2, 12, 0, 0);
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const ASOF = at(24 * 60);

let seq = 0;
function fill(side: "BUY" | "SELL", qty: string, price: string, minute: number, extra: Partial<LotFillInput> = {}): LotFillInput {
  seq += 1;
  const notional = usd(d(qty).mul(d(price)));
  return {
    id: `fill_fb_${String(seq).padStart(4, "0")}`,
    orderId: `ord_fb_${seq}`,
    accountId: ACCOUNT,
    pairAddress: PAIR,
    baseSymbol: "FB",
    side,
    qty,
    priceUsd: price,
    notionalUsd: notional,
    feeUsd: usd(d(notional).mul("0.003")),
    feeKnown: true,
    slippageBps: "25.000000",
    createdAt: at(minute),
    source: "LOCAL_SIM",
    strategyInstanceId: "inst_a",
    intent: side === "BUY" ? "ENTRY" : "EXIT",
    ownerScope: "STRATEGY",
    reasonCodes: side === "BUY" ? ["ENTRY_SIGNAL"] : ["EXIT_MOMENTUM"],
    strategyVersion: "v1",
    cycleId: `cyc_fb_${seq}`,
    ...extra,
  };
}

/** One closed lot: BUY 100 @ 1.00 at minute 0, SELL at `exitPrice` at `exitMinute`. */
function lotOf(fills: LotFillInput[]): Lot {
  const history = reconstructLots({ fills, asOf: ASOF });
  expect(history.lots).toHaveLength(1);
  return history.lots[0]!;
}

function roundTrip(exitPrice: string, opts: { exitMinute?: number; exitReasons?: string[]; add?: { price: string; minute: number } } = {}): Lot {
  const fills = [fill("BUY", "100", "1.00", 0)];
  if (opts.add) fills.push(fill("BUY", "100", opts.add.price, opts.add.minute));
  const qty = opts.add ? "200" : "100";
  fills.push(fill("SELL", qty, exitPrice, opts.exitMinute ?? 30, { reasonCodes: opts.exitReasons ?? ["EXIT_MOMENTUM"] }));
  return lotOf(fills);
}

function observation(id: string, minute: number, extra: Partial<PitObservation> = {}): PitObservation {
  return {
    id,
    pairAddress: PAIR,
    receivedAt: at(minute),
    eventTime: null,
    freshness: "FRESH",
    dataOrigin: "LIVE_FEED",
    priceUsd: "1.00",
    liquidityUsd: "1000000",
    volume24hUsd: "500000",
    priceChangeM5: "2.0",
    priceChangeH1: "1.0",
    pairCreatedAt: at(-10_000),
    ...extra,
  };
}

function decision(id: string, agent: string, minute: number, cycleId: string, extra: Partial<PitDecision> = {}): PitDecision {
  return {
    id,
    cycleId,
    agent,
    modelVersion: `${agent.toLowerCase()}-1`,
    pairAddress: PAIR,
    decision: "ACT",
    confidence: "0.700000",
    reasonCodes: ["ENTRY_SIGNAL"],
    inputSource: "feed",
    createdAt: at(minute),
    updatedAt: at(minute),
    output: { estimatedCostUsd: "100.30000000", spreadBps: "20", expiresAt: at(10) },
    ...extra,
  };
}

type SnapOpts = { observation?: Partial<PitObservation>; executorOutput?: unknown; laterRows?: boolean };

/** Entry source for a lot's entry fill, as the ASCEND-09 writer would assemble it. */
function entrySource(lot: Lot, opts: SnapOpts = {}): Omit<PointInTimeSource, "phase" | "kind"> {
  const entry = lot.events[0]!;
  const cycleId = entry.cycleId!;
  const observations = [observation("obs_dec", -0.5, opts.observation), observation("obs_fill", -0.01, opts.observation)];
  const decisions = [
    decision("d_pulse", "PULSE", -0.4, cycleId),
    decision("d_exec", "EXECUTOR", -0.2, cycleId, opts.executorOutput !== undefined ? { output: opts.executorOutput } : {}),
  ];
  if (opts.laterRows) {
    observations.push(observation("obs_late", 5, { priceUsd: "9.99", priceChangeH1: "-50" }));
    decisions.push(decision("d_late", "EXECUTOR", 1, cycleId, { output: { feeUsd: "99", notionalUsd: "100" } }));
  }
  return {
    accountId: ACCOUNT,
    entryFillId: lot.entryFillId,
    openedAt: lot.openedAt,
    fill: {
      id: entry.fillId,
      orderId: entry.orderId,
      pairAddress: PAIR,
      side: "BUY",
      qty: entry.qty,
      priceUsd: entry.priceUsd,
      notionalUsd: entry.notionalUsd,
      feeUsd: entry.feeUsd,
      feeKnown: true,
      slippageBps: entry.slippageBps,
      liquidityUsd: "1000000",
      source: "LOCAL_SIM",
      createdAt: entry.at,
      observationId: "obs_fill",
    },
    order: {
      id: entry.orderId,
      clientOrderId: `coid_${entry.orderId}`,
      cycleId,
      intent: "ENTRY",
      ownerScope: "STRATEGY",
      reasonCodes: ["ORDER_PROPOSED"],
      strategyInstanceId: "inst_a",
      strategyVersion: "v1",
      executionMode: "PAPER",
      venue: "PAPER",
      createdAt: at(-0.1),
      decisionObservationId: "obs_dec",
      observationId: "obs_dec",
      fillObservationId: "obs_fill",
    },
    positionQtyBefore: "0.00000000",
    positionQtyAfter: entry.positionQtyAfter,
    realizedPnlUsd: null,
    observations,
    decisions,
    plan: { plannedAt: at(-0.3), orders: [{ clientOrderId: `coid_${entry.orderId}`, qty: entry.qty, estimatedCostUsd: "100.30000000", estimatedNotionalUsd: "100.00000000" }] },
    configRevisions: [{ configHash: "cfg_1", engineUpdatedAt: at(-60), createdAt: at(-60) }],
    cycle: { id: cycleId, startedAt: at(-1), configRevision: at(-60), tradingEnvironment: "MARKET_DATA_PAPER", dataMode: "live" },
    strategyInstance: { id: "inst_a", name: "Momentum", version: "v1", moduleRef: "builtin:momentum", artifactHash: null, sourceHash: null, updatedAt: at(-100) },
  };
}

function snapshotFor(lot: Lot, opts: SnapOpts = {}): StoredEntrySnapshot {
  const view = entryView(entrySource(lot, opts));
  return { id: `snap_${lot.entryFillId}`, accountId: ACCOUNT, fillId: lot.entryFillId, entryFillId: lot.entryFillId, phase: "ENTRY", asOf: view.asOf, viewHash: viewHash(view), view };
}

const mark = (minute: number, price: string): MarkObservation => ({ pairAddress: PAIR, receivedAt: at(minute), priceUsd: price });

function feedback(lot: Lot, opts: { snap?: SnapOpts | null; marks?: MarkObservation[] } = {}): LotFeedback {
  const snapshot = opts.snap === null ? null : snapshotFor(lot, opts.snap ?? {});
  return lotFeedback({ lot, entrySnapshot: snapshot, marks: opts.marks ?? [], asOf: ASOF });
}

describe("decision record (point in time)", () => {
  it("is built from the stored ENTRY snapshot with buckets and expected cost rates", () => {
    const lot = roundTrip("1.05");
    const { state, record } = decisionRecordFromSnapshot(snapshotFor(lot, { observation: { priceChangeH1: "-3", priceChangeM5: "0.4", liquidityUsd: "40000" } }), lot);
    expect(state).toBe("RECORDED");
    expect(record!.asOf).toBe(lot.openedAt);
    expect(record!.pairAddress).toBe(PAIR);
    expect(record!.buckets).toEqual({ regime: "TREND_DOWN", volatility: "LOW", liquidity: "LOW" });
    // Plan cost 100.30 − notional 100.00 = 0.30 → 30 bps; no EXECUTOR fee field in this fixture.
    expect(record!.expected).toEqual({ feeBps: "30.0000", feeBasis: "PLAN_COST_MINUS_NOTIONAL", slippageBps: null, grossEdgeState: "NOT_RECORDED" });
    expect(record!.modelVersions).toEqual(["executor-1", "pulse-1"]);
    expect(record!.configHash).toBe("cfg_1");
  });

  it("HINDSIGHT: no timestamp in decisionRecord is after the entry decision time", () => {
    const lot = roundTrip("0.90", { exitReasons: ["STOP_LOSS"] });
    const marks = [mark(1, "1.20"), mark(20, "0.80"), mark(31, "1.50"), mark(600, "2.00")];
    const row = feedback(lot, { snap: { laterRows: true }, marks });
    const record = row.decisionRecord!;
    const limit = Date.parse(record.asOf);
    expect(limit).toBe(Date.parse(lot.openedAt));
    const stamps = collectTimestamps(record);
    expect(stamps.length).toBeGreaterThan(3);
    for (const stamp of stamps) expect(Date.parse(stamp.at), stamp.path).toBeLessThanOrEqual(limit);
    // Later rows passed to the writer never reach the record.
    expect(record.market.priceUsd).toBe("1.00");
    expect(record.expected.feeBasis).toBe("PLAN_COST_MINUS_NOTIONAL");
    // The retrospective, by contrast, does hold post-entry and post-exit data.
    expect(collectTimestamps(row.retrospective).some((stamp) => Date.parse(stamp.at) > limit)).toBe(true);
    expect(row.retrospective!.postExit.basis).toBe("POST_EXIT_HINDSIGHT");
  });

  it("HINDSIGHT: the decision record is identical whatever outcome or later marks follow", () => {
    seq = 0; // same fill ids for both lots: only the outcome differs
    const winner = feedback(roundTrip("1.10"), { marks: [mark(5, "1.2")] });
    seq = 0;
    const loser = feedback(roundTrip("0.80", { exitReasons: ["STOP_LOSS"] }), { marks: [mark(5, "0.7"), mark(40, "3")] });
    seq = 0;
    const open = lotFeedback({ lot: lotOf([fill("BUY", "100", "1.00", 0)]), entrySnapshot: null, marks: [], asOf: ASOF });
    expect(winner.decisionRecord).toEqual(loser.decisionRecord);
    expect(open.retrospective).toBeNull();
    expect(open.retrospectiveState).toBe("LOT_OPEN");
  });

  it("refuses a snapshot that is missing, re-hashes differently, describes another fill, or carries a late timestamp", () => {
    const lot = roundTrip("1.01");
    expect(decisionRecordFromSnapshot(null, lot)).toEqual({ state: "NOT_RECORDED_YET", record: null });
    const good = snapshotFor(lot);
    expect(decisionRecordFromSnapshot({ ...good, viewHash: "0".repeat(64) }, lot).state).toBe("HASH_MISMATCH");
    expect(decisionRecordFromSnapshot({ ...good, fillId: "other" }, lot).state).toBe("IDENTITY_MISMATCH");
    const leaked = structuredClone(good.view) as { decisions: Array<{ createdAt: string }> };
    leaked.decisions[0]!.createdAt = at(45);
    const resealed = { ...good, view: leaked, viewHash: viewHash(leaked as never) };
    expect(decisionRecordFromSnapshot(resealed, lot)).toEqual({ state: "TEMPORAL_BOUNDARY_VIOLATED", record: null });
  });
});

describe("classification rules", () => {
  it("NO_ERROR for a profitable lot", () => {
    const row = feedback(roundTrip("1.10"), { marks: [mark(10, "1.12")] });
    expect(row.retrospective!.classification.primary).toBe("NO_ERROR");
    expect(d(row.retrospective!.realised.netPnlUsd).gt(0)).toBe(true);
  });

  it("TURNOVER when the price move was smaller than costs and costs matched expectations", () => {
    const row = feedback(roundTrip("1.002"), { marks: [mark(10, "1.01")] });
    const retro = row.retrospective!;
    expect(d(retro.realised.netPnlUsd).lt(0)).toBe(true);
    expect(retro.expectedVsRealised.costComparison).toBe("FEES_ONLY");
    expect(retro.expectedVsRealised.costExcessUsd).toBe("0.00000000");
    expect(retro.classification.primary).toBe("TURNOVER");
  });

  it("EXECUTION_COST_ERROR when realised costs are materially above expected and the excess explains the loss", () => {
    const row = feedback(roundTrip("1.002"), { snap: { executorOutput: { feeUsd: "0.05", notionalUsd: "100", slippageBps: "2" } }, marks: [mark(10, "1.01")] });
    const retro = row.retrospective!;
    expect(row.decisionRecord!.expected).toMatchObject({ feeBps: "5.0000", feeBasis: "EXECUTOR_FEE", slippageBps: "2" });
    expect(retro.expectedVsRealised.costComparison).toBe("FEES_AND_SLIPPAGE");
    expect(d(retro.expectedVsRealised.costExcessUsd!).gt(d(retro.expectedVsRealised.expectedCostUsd!))).toBe(true);
    expect(retro.classification.primary).toBe("EXECUTION_COST_ERROR");
    expect(retro.classification.matched.map((m) => m.class)).toContain("TURNOVER");
    expect(retro.expectedVsRealised.expectedNetState).toBe("NO_FORECAST_RECORDED");
  });

  it("EXIT_TIMING (in-trade) when a large MFE was given back to a loss", () => {
    const row = feedback(roundTrip("0.95"), { marks: [mark(5, "1.05"), mark(20, "0.96")] });
    const match = row.retrospective!.classification.matched.find((m) => m.class === "EXIT_TIMING")!;
    expect(row.retrospective!.classification.primary).toBe("EXIT_TIMING");
    expect(match).toMatchObject({ rule: "GAVE_BACK_MFE", dataBasis: "IN_TRADE" });
  });

  it("EXIT_TIMING (post-exit) only from the retrospective window: stop hit, then price recovered within the horizon", () => {
    const lot = roundTrip("0.95", { exitReasons: ["STOP_LOSS"] });
    const inTrade = [mark(5, "1.001"), mark(20, "0.96")];
    const withRecovery = feedback(lot, { marks: [...inTrade, mark(60, "1.02")] });
    const match = withRecovery.retrospective!.classification.matched.find((m) => m.class === "EXIT_TIMING")!;
    expect(match).toMatchObject({ rule: "STOP_THEN_RECOVERED_WITHIN_HORIZON", dataBasis: "POST_EXIT" });
    expect(withRecovery.retrospective!.postExit).toMatchObject({ recoveredToEntry: true, firstRecoveryAt: at(60), horizonComplete: true });
    expect(withRecovery.retrospective!.inTrade.observations).toBe(2); // the post-exit mark is not in-trade
    // Recovery beyond the horizon does not count; without it the never-in-favour rule decides.
    const late = feedback(lot, { marks: [...inTrade, mark(30 + FEEDBACK_RULES.postExitHorizonSeconds / 60 + 1, "1.02")] });
    expect(late.retrospective!.postExit.observations).toBe(0);
    expect(late.retrospective!.classification.primary).toBe("SIGNAL_ERROR");
  });

  it("SIZING_ERROR when entry notional is large against entry liquidity", () => {
    const row = feedback(roundTrip("0.95"), { snap: { observation: { liquidityUsd: "5000" } }, marks: [mark(5, "1.01"), mark(20, "0.96")] });
    expect(row.retrospective!.classification.primary).toBe("SIZING_ERROR");
    expect(row.retrospective!.classification.matched[0]).toMatchObject({ rule: "ENTRY_NOTIONAL_LARGE_VS_LIQUIDITY", evidence: { liquiditySharePct: "2.0000" } });
  });

  it("SIZING_ERROR when the lot averaged down", () => {
    const row = feedback(roundTrip("0.85", { add: { price: "0.95", minute: 10 } }), { marks: [mark(5, "1.01"), mark(20, "0.90")] });
    expect(row.retrospective!.classification.primary).toBe("SIZING_ERROR");
    expect(row.retrospective!.classification.matched.find((m) => m.class === "SIZING_ERROR")!.rule).toBe("ADDED_BELOW_ENTRY_PRICE");
  });

  it("REGIME_MISMATCH for a long entered into a down-trend", () => {
    const row = feedback(roundTrip("0.95"), { snap: { observation: { priceChangeH1: "-4" } }, marks: [mark(5, "1.01"), mark(20, "0.96")] });
    expect(row.retrospective!.classification.primary).toBe("REGIME_MISMATCH");
  });

  it("SIGNAL_ERROR when price never moved in favour", () => {
    const row = feedback(roundTrip("0.95"), { marks: [mark(5, "0.99"), mark(20, "0.96")] });
    expect(row.retrospective!.classification.primary).toBe("SIGNAL_ERROR");
  });

  it("UNATTRIBUTED when no rule matches, listing what could not be evaluated", () => {
    const row = feedback(roundTrip("0.95"), { snap: null, marks: [mark(5, "1.01"), mark(20, "0.96")] });
    expect(row.decisionRecordState).toBe("NOT_RECORDED_YET");
    expect(row.retrospective!.classification.primary).toBe("UNATTRIBUTED");
    expect(row.retrospective!.classification.notEvaluable.join("|")).toContain("REGIME_MISMATCH");
    expect(row.retrospective!.expectedVsRealised.costComparison).toBe("NOT_COMPARABLE");
  });
});

describe("aggregation", () => {
  it("breaks closed lots down by every dimension with counts, net P&L and small-sample flags", () => {
    const rows = [
      feedback(roundTrip("1.10", { exitReasons: ["TAKE_PROFIT"] }), { marks: [mark(5, "1.1")] }),
      feedback(roundTrip("0.95", { exitReasons: ["STOP_LOSS"] }), { marks: [mark(5, "0.99"), mark(20, "0.96")] }),
      feedback(roundTrip("0.95", { exitMinute: 300 }), { snap: { observation: { priceChangeH1: "-4" } }, marks: [mark(5, "1.01")] }),
      lotFeedback({ lot: lotOf([fill("BUY", "100", "1.00", 0)]), entrySnapshot: null, marks: [], asOf: ASOF }),
    ];
    const agg = aggregateFeedback(rows);
    expect(agg.lots).toEqual({ closed: 3, open: 1, withDecisionRecord: 3, withoutDecisionRecord: 1 });
    const net = rows.slice(0, 3).reduce((sum, row) => sum.plus(d(row.retrospective!.realised.netPnlUsd)), d("0"));
    expect(agg.totals.netPnlUsd).toBe(usd(net));
    expect(agg.totals).toMatchObject({ wins: 1, losses: 2, breakeven: 0, smallSample: true });
    expect(agg.classifications).toMatchObject({ NO_ERROR: 1, SIGNAL_ERROR: 1, REGIME_MISMATCH: 1 });
    expect(Object.keys(agg.dimensions).sort()).toEqual(
      ["exitReason", "holdingDuration", "instrument", "liquidity", "modelVersion", "regime", "strategyInstance", "strategyVersion", "volatility"].sort(),
    );
    expect(agg.dimensions.instrument).toEqual([expect.objectContaining({ key: PAIR, count: 3, smallSample: true, netPnlUsd: usd(net) })]);
    expect(agg.dimensions.exitReason.map((b) => b.key).sort()).toEqual(["EXIT_MOMENTUM", "STOP_LOSS", "TAKE_PROFIT"]);
    expect(agg.dimensions.holdingDuration.map((b) => [b.key, b.count]).sort()).toEqual([["4H_24H", 1], ["5M_1H", 2]]);
    expect(agg.dimensions.regime.find((b) => b.key === "TREND_DOWN")).toMatchObject({ count: 1, classifications: { REGIME_MISMATCH: 1 } });
    for (const buckets of Object.values(agg.dimensions)) {
      expect(buckets.reduce((sum, b) => sum + b.count, 0)).toBe(3);
      expect(usd(buckets.reduce((sum, b) => sum.plus(d(b.netPnlUsd)), d("0")))).toBe(usd(net));
    }
  });

  it("counts zero net P&L as breakeven (performance.ts definition), classified NO_ERROR but not a win", () => {
    const flat = lotOf([fill("BUY", "100", "1.00", 0, { feeUsd: "0.00000000", slippageBps: "0" }), fill("SELL", "100", "1.00", 30, { feeUsd: "0.00000000", slippageBps: "0" })]);
    const row = feedback(flat, { marks: [] });
    expect(row.retrospective!.realised.netPnlUsd).toBe("0.00000000");
    expect(row.retrospective!.classification.primary).toBe("NO_ERROR");
    const agg = aggregateFeedback([row, feedback(roundTrip("1.10"), { marks: [] })]);
    expect(agg.totals).toMatchObject({ wins: 1, losses: 0, breakeven: 1 });
    expect(agg.dimensions.instrument[0]).toMatchObject({ count: 2, wins: 1, losses: 0, breakeven: 1 });
  });

  it("pages closed lots by closedAt, not by openedAt", () => {
    // Lot A opens first but closes last; lot B opens later and closes first; lot C is still open.
    const a = lotOf([fill("BUY", "1", "1", 0), fill("SELL", "1", "1", 300)]);
    const b = { ...lotOf([fill("BUY", "1", "1", 10), fill("SELL", "1", "1", 20)]), lotKey: "lot_b" };
    const c = lotOf([fill("BUY", "1", "1", 400)]);
    expect(closedLotsNewestFirst([a, b, c]).map((lot) => lot.lotKey)).toEqual([a.lotKey, "lot_b"]);
  });

  it("clears the small-sample flag at the minimum sample and refuses hypothetical rows", () => {
    const rows = Array.from({ length: FEEDBACK_RULES.minSample }, () => feedback(roundTrip("1.05"), { marks: [] }));
    expect(aggregateFeedback(rows).dimensions.strategyInstance[0]).toMatchObject({ key: "inst_a", count: FEEDBACK_RULES.minSample, smallSample: false });
    const spoofed = { ...rows[0]!, source: "HYPOTHETICAL" } as unknown as LotFeedback;
    expect(() => aggregateFeedback([spoofed])).toThrow("HYPOTHETICAL_ROW_IN_OBSERVED_AGGREGATE");
  });
});

describe("hypothetical non-trades", () => {
  const opportunity: RejectedOpportunity = { id: "fun_1", accountId: ACCOUNT, cycleId: "cyc_r", pairAddress: PAIR, stage: "REJECTED", reasonCodes: ["RISK_LIMIT"], createdAt: at(0) };
  const feature = (minute: number, price: string, extra: Partial<PitObservation> = {}) => observation(`f_${minute}`, minute, { priceUsd: price, ...extra });
  const policy = { horizonSeconds: 3600, stopLossPct: "3", takeProfitPct: "5", notionalUsd: "100", roundTripCostBps: "60", maxPreDecisionAgeSeconds: MAX_PRE_DECISION_PRICE_AGE_SECONDS };

  it("is NOT_EVALUATED (STALE_PRE_DECISION_PRICE) when the last pre-decision price is too old", () => {
    const stale = counterfactualOutcome({ opportunity, features: [feature(-16, "1.00")], bars: [mark(5, "1.10")], asOf: ASOF, policy });
    expect(stale).toMatchObject({ status: "NOT_EVALUATED", notEvaluatedReason: "STALE_PRE_DECISION_PRICE" });
    expect(stale.decisionRecord.features!.ageAtDecisionSeconds).toBe(960);
    expect(stale.retrospective).toMatchObject({ exit: null, netPnlUsd: null });
    expect(feedbackRowFromHypothetical(stale)).toBeNull();
    // Age uses the provider eventTime when known: received 1 min before, produced 20 min before → stale.
    const oldEvent = counterfactualOutcome({ opportunity, features: [feature(-1, "1.00", { eventTime: at(-20) })], bars: [mark(5, "1.10")], asOf: ASOF, policy });
    expect(oldEvent.notEvaluatedReason).toBe("STALE_PRE_DECISION_PRICE");
    const fresh = counterfactualOutcome({ opportunity, features: [feature(-14, "1.00")], bars: [mark(5, "1.10")], asOf: ASOF, policy });
    expect(fresh).toMatchObject({ status: "EVALUATED", notEvaluatedReason: null });
    expect(fresh.retrospective.caveats[0]).toContain("last pre-decision mark");
  });

  it("labels the outcome HYPOTHETICAL and exits at the take-profit", () => {
    const out = counterfactualOutcome({ opportunity, features: [feature(-1, "1.00"), feature(-5, "0.50")], bars: [mark(-0.5, "2"), mark(10, "1.02"), mark(20, "1.06"), mark(30, "0.5")], asOf: ASOF, policy });
    expect(out).toMatchObject({ source: "HYPOTHETICAL", labelOrigin: "MARKET_BARS", derivedFromOwnPrediction: false, status: "EVALUATED" });
    expect(out.decisionRecord.features!.observationId).toBe("f_-1");
    expect(out.retrospective.exit).toEqual({ at: at(20), priceUsd: "1.06000000", reason: "TAKE_PROFIT" });
    expect(out.retrospective.netPnlUsd).toBe("5.40000000"); // 100 × 6 % − 100 × 60 bps
    for (const stamp of collectTimestamps(out.decisionRecord)) expect(Date.parse(stamp.at)).toBeLessThanOrEqual(Date.parse(opportunity.createdAt));
  });

  it("exits at the stop, or at the horizon end, and says when the horizon is incomplete", () => {
    const stop = counterfactualOutcome({ opportunity, features: [feature(-1, "1.00")], bars: [mark(5, "0.96"), mark(6, "1.20")], asOf: ASOF, policy });
    expect(stop.retrospective.exit!.reason).toBe("STOP_LOSS");
    const time = counterfactualOutcome({ opportunity, features: [feature(-1, "1.00")], bars: [mark(5, "1.01"), mark(59, "1.02"), mark(61, "1.50")], asOf: ASOF, policy });
    expect(time.retrospective.exit).toMatchObject({ reason: "TIME_EXIT", priceUsd: "1.02000000" });
    const provisional = counterfactualOutcome({ opportunity, features: [feature(-1, "1.00")], bars: [mark(5, "1.01"), mark(59, "1.02")], asOf: at(30), policy });
    expect(provisional.retrospective).toMatchObject({ horizonComplete: false, barsUsed: 1, exit: { reason: "PROVISIONAL_LAST_BAR" } });
  });

  it("never uses features received after the decision and refuses non-rejections", () => {
    const late = counterfactualOutcome({ opportunity, features: [feature(1, "1.00"), feature(-1, "1.00", { eventTime: at(2) })], bars: [mark(5, "1.1")], asOf: ASOF, policy });
    expect(late.status).toBe("NO_PRE_DECISION_PRICE");
    expect(late.decisionRecord.features).toBeNull();
    expect(counterfactualOutcome({ opportunity: { ...opportunity, stage: "FILLED" }, features: [feature(-1, "1")], bars: [mark(5, "1.1")], asOf: ASOF, policy }).status).toBe("NOT_A_REJECTION");
    expect(counterfactualOutcome({ opportunity, features: [feature(-1, "1")], bars: [], asOf: ASOF, policy }).status).toBe("NO_BARS_AFTER_DECISION");
  });
});

describe("self-reinforcement guard", () => {
  const observedRow = () => feedbackRowFromLot(feedback(roundTrip("1.05"), { marks: [] }))!;
  const hypotheticalRow = () =>
    feedbackRowFromHypothetical(
      counterfactualOutcome({
        opportunity: { id: "fun_2", accountId: ACCOUNT, cycleId: "c", pairAddress: PAIR, stage: "FILTERED", reasonCodes: [], createdAt: at(0) },
        features: [observation("f", -1)],
        bars: [mark(5, "1.1")],
        asOf: ASOF,
      }),
    )!;

  it("keeps observed and hypothetical rows apart and drops hypotheticals unless asked", () => {
    const rows = [observedRow(), hypotheticalRow()];
    expect(rows.map((row) => [row.source, row.labelOrigin, row.derivedFromOwnPrediction])).toEqual([
      ["OBSERVED_FILL", "REALISED_LEDGER", false],
      ["HYPOTHETICAL", "MARKET_BARS", false],
    ]);
    const defaults = buildTrainingData(rows);
    expect(defaults.observed.map((row) => row.source)).toEqual(["OBSERVED_FILL"]);
    expect(defaults).toMatchObject({ hypothetical: [], droppedHypothetical: 1 });
    const both = buildTrainingData(rows, { includeHypothetical: true });
    expect(both.hypothetical.map((row) => row.source)).toEqual(["HYPOTHETICAL"]);
    expect(both.observed.every((row) => row.source === "OBSERVED_FILL")).toBe(true);
  });

  it("refuses rows whose label derives from QUANT's own predictions, by flag or by origin", () => {
    const flagged: FeedbackRow = { ...observedRow(), id: "self_1", derivedFromOwnPrediction: true };
    const byOrigin: FeedbackRow = { ...observedRow(), id: "self_2", labelOrigin: "QUANT_PREDICTION" };
    expect(() => buildTrainingData([observedRow(), flagged])).toThrow("SELF_REINFORCEMENT_REFUSED self_1");
    expect(() => buildTrainingData([byOrigin])).toThrow("SELF_REINFORCEMENT_REFUSED self_2");
    const mislabelled: FeedbackRow = { ...hypotheticalRow(), id: "mix_1", labelOrigin: "REALISED_LEDGER" };
    expect(() => buildTrainingData([mislabelled], { includeHypothetical: true })).toThrow("FEEDBACK_SOURCE_INCONSISTENT mix_1");
  });
});
