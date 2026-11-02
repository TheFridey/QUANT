import { describe, expect, it } from "vitest";
import {
  assertNoPostAsOfTimestamps,
  buildPointInTimeView,
  collectTimestamps,
  entryView,
  viewHash,
  type PitDecision,
  type PitObservation,
  type PointInTimeSource,
} from "./entry-view.js";
import { reconstructLots, type LotFillInput } from "./lot-history.js";

const t = (second: number) => new Date(Date.UTC(2026, 10, 2, 12, 0, second)).toISOString();
const ENTRY_AT = t(30);
const PAIR = "pairPIT";

function observation(id: string, second: number, price: string, extra: Partial<PitObservation> = {}): PitObservation {
  return {
    id,
    pairAddress: PAIR,
    receivedAt: t(second),
    eventTime: null,
    freshness: "FRESH",
    dataOrigin: "LIVE_FEED",
    priceUsd: price,
    liquidityUsd: "50000",
    volume24hUsd: "1000",
    priceChangeM5: "2.1",
    priceChangeH1: "4.2",
    pairCreatedAt: t(-86400),
    ...extra,
  };
}

function decision(id: string, agent: string, second: number, extra: Partial<PitDecision> = {}): PitDecision {
  return {
    id,
    cycleId: "cyc_1",
    agent,
    modelVersion: `${agent.toLowerCase()}-1`,
    pairAddress: PAIR,
    decision: "ACT",
    confidence: "0.800000",
    reasonCodes: ["ENTRY_SIGNAL"],
    inputSource: "feed",
    createdAt: t(second),
    output: { estimatedCostUsd: "100.30000000", spreadBps: "20", impactBps: "5.5", expiresAt: t(600), eligibleAt: t(31) },
    ...extra,
  };
}

function baseSource(): Omit<PointInTimeSource, "phase" | "kind"> {
  return {
    accountId: "acct",
    entryFillId: "fill_entry",
    openedAt: ENTRY_AT,
    fill: {
      id: "fill_entry",
      orderId: "ord_entry",
      pairAddress: PAIR,
      side: "BUY",
      qty: "100.00000000",
      priceUsd: "1.00250000",
      notionalUsd: "100.25000000",
      feeUsd: "0.30075000",
      feeKnown: true,
      slippageBps: "25.000000",
      liquidityUsd: "50000",
      source: "LOCAL_SIM",
      createdAt: ENTRY_AT,
      observationId: "obs_fill",
    },
    order: {
      id: "ord_entry",
      clientOrderId: "coid_entry",
      cycleId: "cyc_1",
      intent: "ENTRY",
      ownerScope: "STRATEGY",
      reasonCodes: ["ORDER_PROPOSED", "FILLED"],
      strategyInstanceId: "inst_a",
      strategyVersion: "momentum-1.2.0",
      executionMode: "PAPER",
      venue: "PAPER",
      createdAt: t(29),
      decisionObservationId: "obs_decision",
      observationId: "obs_decision",
      fillObservationId: "obs_fill",
    },
    positionQtyBefore: "0.00000000",
    positionQtyAfter: "100.00000000",
    realizedPnlUsd: null,
    observations: [observation("obs_decision", 10, "1.00"), observation("obs_fill", 28, "1.00")],
    decisions: [decision("d_pulse", "PULSE", 15), decision("d_aegis", "AEGIS", 16), decision("d_exec", "EXECUTOR", 29), decision("d_other_cycle", "PULSE", 12, { cycleId: "cyc_0" })],
    plan: { plannedAt: t(14), orders: [{ clientOrderId: "coid_entry", qty: "100.00000000", estimatedCostUsd: "100.30000000", estimatedNotionalUsd: "100.00000000" }] },
    configRevisions: [
      { configHash: "hash_old", engineUpdatedAt: t(-500), createdAt: t(-500) },
      { configHash: "hash_pinned", engineUpdatedAt: t(1), createdAt: t(1) },
    ],
    cycle: { id: "cyc_1", startedAt: t(5), configRevision: t(1), tradingEnvironment: "MARKET_DATA_PAPER", dataMode: "live" },
    strategyInstance: { id: "inst_a", name: "Momentum", version: "momentum-1.2.0", moduleRef: "builtin:momentum", artifactHash: "art", sourceHash: "src", updatedAt: t(2) },
  };
}

/** Rows recorded after the entry fill: later marks, decisions, config edits, a re-quote of the same cycle. */
function withLaterRows(source: Omit<PointInTimeSource, "phase" | "kind">): Omit<PointInTimeSource, "phase" | "kind"> {
  return {
    ...source,
    observations: [...source.observations, observation("obs_late_1", 31, "1.50"), observation("obs_late_2", 300, "0.40")],
    decisions: [
      ...source.decisions,
      decision("d_archivist", "ARCHIVIST", 45, { pairAddress: "" }),
      decision("d_exec_late", "EXECUTOR", 31, { output: { estimatedCostUsd: "999" } }),
    ],
    configRevisions: [...source.configRevisions, { configHash: "hash_after_entry", engineUpdatedAt: t(1), createdAt: t(40) }],
  };
}

describe("point-in-time entry view (ASCEND-09)", () => {
  it("contains the decision observation, cycle decisions, freshness, estimated cost, strategy and config", () => {
    const view = entryView(baseSource());
    expect(view.phase).toBe("ENTRY");
    expect(view.asOf).toBe(ENTRY_AT);
    expect(view.fill.kind).toBe("ENTRY");
    expect(view.decisionObservation?.id).toBe("obs_decision");
    expect(view.fillObservation?.id).toBe("obs_fill");
    expect(view.quoteFreshness).toEqual({
      decisionObservationAgeAtOrderMs: 19_000,
      decisionObservationAgeAtFillMs: 20_000,
      fillObservationAgeAtFillMs: 2_000,
      decisionFreshness: "FRESH",
      fillFreshness: "FRESH",
    });
    expect(view.decisions.map((row) => row.agent)).toEqual(["PULSE", "AEGIS", "EXECUTOR"]); // other cycle excluded
    expect(view.estimatedCost).toMatchObject({ source: "CYCLE_PLAN", estimatedCostUsd: "100.30000000", realisedFeeUsd: "0.30075000" });
    expect(view.estimatedCost.executorDecision).toEqual({ estimatedCostUsd: "100.30000000", spreadBps: "20", impactBps: "5.5" });
    expect(view.strategy).toMatchObject({ strategyInstanceId: "inst_a", strategyVersion: "momentum-1.2.0", instanceState: "AT_OR_BEFORE_ASOF" });
    expect(view.config).toMatchObject({ configHash: "hash_pinned", method: "CYCLE_PINNED_REVISION" });
  });

  it("is prefix invariant: appending later observations, decisions and config revisions changes nothing", () => {
    const base = entryView(baseSource());
    const later = entryView(withLaterRows(baseSource()));
    expect(later).toEqual(base);
    expect(viewHash(later)).toBe(viewHash(base));
  });

  it("is prefix invariant under later fills: the entry fill's classification uses only earlier fills", () => {
    const fill = (id: string, side: "BUY" | "SELL", qty: string, second: number): LotFillInput => ({
      id, orderId: `o_${id}`, accountId: "acct", pairAddress: PAIR, baseSymbol: "P", side, qty, priceUsd: "1", notionalUsd: qty, feeUsd: "0",
      feeKnown: true, slippageBps: "0", createdAt: t(second), source: "LOCAL_SIM", strategyInstanceId: "inst_a", intent: side === "BUY" ? "ENTRY" : "EXIT",
      ownerScope: "STRATEGY", reasonCodes: [], strategyVersion: "v", cycleId: "cyc_1",
    });
    const prefix = [fill("f1", "BUY", "5", 0), fill("f2", "SELL", "5", 10), fill("fill_entry", "BUY", "100", 30)];
    const all = [...prefix, fill("f4", "BUY", "7", 40), fill("f5", "SELL", "107", 50), fill("f6", "BUY", "1", 60)];
    const event = (fills: LotFillInput[]) => {
      const lot = reconstructLots({ fills, asOf: t(100) }).lots.find((item) => item.entryFillId === "fill_entry")!;
      return lot.events[0]!;
    };
    expect(event(all)).toEqual(event(prefix));
    const source = (fills: LotFillInput[]) => ({ ...baseSource(), positionQtyBefore: event(fills).positionQtyBefore, positionQtyAfter: event(fills).positionQtyAfter });
    expect(entryView(source(all))).toEqual(entryView(source(prefix)));
  });

  it("has no timestamp later than the entry fill time", () => {
    const view = entryView(withLaterRows(baseSource()));
    const stamps = collectTimestamps(view);
    expect(stamps.length).toBeGreaterThan(5);
    for (const stamp of stamps) expect(Date.parse(stamp.at)).toBeLessThanOrEqual(Date.parse(ENTRY_AT));
    expect(() => assertNoPostAsOfTimestamps(view)).not.toThrow();
    // The EXECUTOR output's forward-dated expiresAt is never copied into the view.
    expect(JSON.stringify(view)).not.toContain(t(600));
  });

  it("drops a referenced observation, plan, config revision or instance row recorded after the entry", () => {
    const source = baseSource();
    const view = entryView({
      ...source,
      observations: [observation("obs_decision", 31, "9.99"), observation("obs_fill", 28, "1.00", { eventTime: t(35) })],
      plan: { plannedAt: t(31), orders: source.plan!.orders },
      configRevisions: [{ configHash: "late", engineUpdatedAt: t(1), createdAt: t(31) }],
      strategyInstance: { ...source.strategyInstance!, updatedAt: t(45) },
    });
    expect(view.decisionObservation).toBeNull();
    expect(view.fillObservation).toBeNull();
    expect(view.quoteFreshness.decisionObservationAgeAtFillMs).toBeNull();
    expect(view.estimatedCost.source).toBe("NONE");
    expect(view.config).toMatchObject({ configHash: null, method: "NO_REVISION_RECORDED" });
    expect(view.strategy.instanceState).toBe("UPDATED_AFTER_ASOF_OMITTED");
    expect(view.strategy.instance).toBeNull();
    expect(() => assertNoPostAsOfTimestamps(view)).not.toThrow();
  });

  it("falls back to the latest revision at or before the entry when the cycle's pinned one is missing", () => {
    const source = baseSource();
    const view = entryView({ ...source, cycle: { ...source.cycle!, configRevision: t(-1) } });
    expect(view.config).toMatchObject({ configHash: "hash_pinned", method: "LATEST_REVISION_AT_OR_BEFORE_ASOF" });
  });

  it("the timestamp guard rejects a view carrying a post-entry timestamp", () => {
    const view = entryView(baseSource());
    const leaked = { ...view, decisions: [...view.decisions, { ...view.decisions[0]!, createdAt: t(31) }] };
    expect(() => assertNoPostAsOfTimestamps(leaked)).toThrow(/POST_ASOF_TIMESTAMP/);
  });

  it("refuses to build an entry view from a fill that is not the lot's entry fill", () => {
    expect(() => entryView({ ...baseSource(), entryFillId: "other" })).toThrow("ENTRY_VIEW_REQUIRES_ENTRY_FILL");
  });

  it("builds an EXIT view whose excursion uses only marks up to the exit fill", () => {
    const source = baseSource();
    const exitAt = t(50);
    const view = buildPointInTimeView({
      ...source,
      phase: "EXIT",
      kind: "EXIT",
      entryPriceUsd: "1.00250000",
      fill: { ...source.fill, id: "fill_exit", side: "SELL", createdAt: exitAt, observationId: null },
      order: { ...source.order, intent: "EXIT", ownerScope: "PROTECTION", reasonCodes: ["STOP_LOSS"], createdAt: t(49), decisionObservationId: null, observationId: null, fillObservationId: null },
      realizedPnlUsd: "-3.10000000",
      marks: [
        { pairAddress: PAIR, receivedAt: t(29), priceUsd: "5" }, // before open: excluded
        { pairAddress: PAIR, receivedAt: t(40), priceUsd: "0.95" },
        { pairAddress: PAIR, receivedAt: t(51), priceUsd: "0.10" }, // after exit: excluded
      ],
    });
    expect(view.order.exitReason).toEqual({ code: "STOP_LOSS", source: "REASON_CODE" });
    expect(view.excursionToDate).toMatchObject({ observations: 1, lowUsd: "0.95000000", windowEnd: exitAt });
    expect(() => assertNoPostAsOfTimestamps(view)).not.toThrow();
  });
});
