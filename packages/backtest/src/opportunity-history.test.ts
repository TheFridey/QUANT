import { describe, expect, it } from "vitest";
import {
  buildOpportunityRows,
  counterfactualOutcome,
  HYPOTHETICAL,
  OpportunityManifestBuilder,
  opportunityCsvHeader,
  opportunityRowToCsv,
  type AgentDecisionRow,
  type FunnelEventRow,
  type OpportunityRow,
  type TradeIntentRow,
} from "./opportunity-history.js";

const T = Date.UTC(2026, 9, 15, 12);
const S = 1000;
const MIN = 60_000;
const H = 3_600_000;

const cycle = { cycleId: "c1", startedAt: new Date(T), accountId: "primary", tradingEnvironment: "PAPER", dataMode: "live" };

function decision(over: Partial<AgentDecisionRow> = {}): AgentDecisionRow {
  return {
    id: "d1",
    cycleId: "c1",
    agent: "PULSE",
    modelVersion: "pulse@1",
    pairAddress: "POOL_A",
    decision: "HOLD",
    confidence: "0.400000",
    reasonCodes: ["NO_SIGNAL"],
    input: { observationId: "obs1", freshness: "LIVE" },
    output: { score: 0.4 },
    inputSource: "observation:dexscreener",
    createdAt: new Date(T + 2 * S),
    updatedAt: new Date(T + 2 * S),
    ...over,
  };
}

function funnel(stage: string, over: Partial<FunnelEventRow> = {}): FunnelEventRow {
  return { id: `f_${stage}`, accountId: "primary", cycleId: "c1", pairAddress: "POOL_A", instrumentId: null, stage, reasonCodes: [], detail: null, createdAt: new Date(T + 5 * S), ...over };
}

function intent(over: Partial<TradeIntentRow> = {}): TradeIntentRow {
  return {
    id: "i1",
    cycleId: "c1",
    accountId: "primary",
    source: "STRATEGY",
    strategyInstanceId: "inst1",
    strategyVersion: "v1",
    configHash: "cfg",
    instrumentId: "POOL_A",
    pairAddress: "POOL_A",
    action: "ENTER",
    side: "BUY",
    requestedQty: null,
    sizedQty: "10",
    sizedNotionalUsd: "100",
    observationId: "obs1",
    observationAt: new Date(T - 10 * S),
    reasonCodes: ["MOMENTUM_ENTRY"],
    status: "ADMITTED",
    statusReason: "ADMITTED",
    createdAt: new Date(T + 4 * S),
    updatedAt: new Date(T + 4 * S),
    ...over,
  };
}

/** Every timestamp outside `hypothetical` must be at or before decisionAt. */
function timestampsAfterDecision(row: OpportunityRow): string[] {
  const cutoff = Date.parse(row.decisionAt);
  const late: string[] = [];
  const walk = (value: unknown, path: string) => {
    if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${path}[${i}]`));
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if (path === "" && (k === "hypothetical" || k === "excluded")) continue;
        if (typeof v === "number" && /(at|time|timestamp)$/i.test(k) && v > 1e12 && v > cutoff) late.push(`${path}.${k}`);
        walk(v, `${path}.${k}`);
      }
      return;
    }
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Date.parse(value) > cutoff) late.push(path);
  };
  walk(row, "");
  return late;
}

describe("GENESIS opportunity history", () => {
  it("classifies eligible, rejected and non-trade opportunities with their reason codes", () => {
    const rows = buildOpportunityRows({
      cycles: [cycle],
      funnel: [
        funnel("DISCOVERED"),
        funnel("RISK_PASSED"),
        funnel("DISCOVERED", { pairAddress: "POOL_B" }),
        funnel("REJECTED", { pairAddress: "POOL_B", reasonCodes: ["MIN_LIQUIDITY"] }),
        funnel("DISCOVERED", { pairAddress: "POOL_C" }),
      ],
      decisions: [decision({ decision: "ACT", reasonCodes: ["MOMENTUM_ENTRY"] }), decision({ id: "d2", pairAddress: "POOL_C" }), decision({ id: "d3", pairAddress: "", agent: "ARCHIVIST" })],
      intents: [intent()],
    });
    expect(rows.map((r) => [r.pairAddress, r.outcome])).toEqual([
      ["POOL_A", "ELIGIBLE"],
      ["POOL_B", "REJECTED"],
      ["POOL_C", "NON_TRADE"],
    ]);
    const b = rows.find((r) => r.pairAddress === "POOL_B")!;
    expect(b.reasonCodes).toEqual(["MIN_LIQUIDITY"]);
    expect(b.stages).toEqual(["DISCOVERED", "REJECTED"]);
    const a = rows.find((r) => r.pairAddress === "POOL_A")!;
    expect(a.agents.PULSE!.features.input).toEqual({ freshness: "LIVE", observationId: "obs1" });
    expect(a.intents[0]).toMatchObject({ status: "ADMITTED", sizedNotionalUsd: "100", observationAt: new Date(T - 10 * S).toISOString() });
    expect(a).not.toHaveProperty("hypothetical");
    expect(rows.some((r) => r.pairAddress === "")).toBe(false);
  });

  it("never includes fields written or timestamped after the decision", () => {
    const rows = buildOpportunityRows({
      cycles: [cycle],
      funnel: [funnel("DISCOVERED"), funnel("FILLED", { createdAt: new Date(T + 2 * H) })],
      decisions: [
        decision({
          input: { observationId: "obs1", seenAt: new Date(T - MIN).toISOString(), futureAt: new Date(T + 3 * H).toISOString(), nested: { exitTime: T + 5 * H, beforeAt: T - S, durationMs: 9e12 } },
          output: { closedAt: Math.floor((T + 4 * H) / 1000), list: [new Date(T + 6 * H).toISOString(), "plain"] },
        }),
        // An upsert that rewrote this decision an hour later must not leak into the row.
        decision({ id: "d9", agent: "ATLAS", decision: "PASS", createdAt: new Date(T + 3 * S), updatedAt: new Date(T + H) }),
      ],
      // Status updated a day later (e.g. FILLED): the mutable fields are withheld.
      intents: [intent({ status: "FILLED", sizedQty: "9", updatedAt: new Date(T + 24 * H) })],
    });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.decisionAt).toBe(new Date(T + 5 * S).toISOString());
    expect(timestampsAfterDecision(row)).toEqual([]);
    expect(row.stages).toEqual(["DISCOVERED"]);
    expect(row.agents.ATLAS).toBeUndefined();
    expect(row.intents[0]).toMatchObject({ status: null, statusReason: null, sizedQty: null, sizedNotionalUsd: null, action: "ENTER" });
    expect(row.agents.PULSE!.features.input).toEqual({ nested: { beforeAt: T - S, durationMs: 9e12 }, observationId: "obs1", seenAt: new Date(T - MIN).toISOString() });
    expect(row.agents.PULSE!.features.output).toEqual({ list: ["plain"] });
    const reasons = row.excluded.map((e) => `${e.path}:${e.reason}`);
    expect(reasons).toEqual(
      expect.arrayContaining([
        "funnel.FILLED:LATE_WRITE",
        "agents.ATLAS:LATE_WRITE",
        "intents.i1.status:MUTABLE_AFTER_DECISION",
        "agents.PULSE.input.futureAt:FUTURE_TIMESTAMP",
        "agents.PULSE.input.nested.exitTime:FUTURE_TIMESTAMP",
        "agents.PULSE.output.closedAt:FUTURE_TIMESTAMP",
        "agents.PULSE.output.list[0]:FUTURE_TIMESTAMP",
      ]),
    );
    // The eligible-looking FILLED stage was written later, so the decision-time outcome is NON_TRADE.
    expect(row.outcome).toBe("NON_TRADE");
  });

  it("attaches counterfactual forward outcomes from later bars, labelled HYPOTHETICAL", () => {
    const bars = Array.from({ length: 30 }, (_, i) => ({ openTime: T - 5 * H + i * H, availableAt: T - 4 * H + i * H, close: String(100 + i) }));
    const series = new Map([["POOL_A", { datasetId: "ds1", interval: "1h", intervalMs: H, bars }]]);
    const rows = buildOpportunityRows({ cycles: [cycle], funnel: [funnel("DISCOVERED")], decisions: [], intents: [], options: { counterfactual: { series, horizonsMs: [H, 4 * H, 48 * H] } } });
    const hyp = rows[0]!.hypothetical!;
    expect(hyp.label).toBe(HYPOTHETICAL);
    // decisionAt = T+5s; the last bar closed by then closed at T (close 104).
    expect(hyp.referenceClose).toBe("104");
    expect(Date.parse(hyp.referenceAvailableAt!)).toBeLessThanOrEqual(Date.parse(rows[0]!.decisionAt));
    expect(hyp.horizons[0]).toMatchObject({ horizonMs: H, exitClose: "105", forwardReturn: Number((105 / 104 - 1).toFixed(8)) });
    expect(Date.parse(hyp.horizons[0]!.exitAvailableAt!)).toBeGreaterThan(Date.parse(rows[0]!.decisionAt));
    expect(hyp.horizons[2]).toMatchObject({ forwardReturn: null, reason: "BEYOND_DATA" });
    // The decision-time part of the row stays point-in-time.
    expect(timestampsAfterDecision(rows[0]!)).toEqual([]);
  });

  it("refuses a stale reference bar instead of pricing from old data", () => {
    const out = counterfactualOutcome({ datasetId: "ds", interval: "1h", intervalMs: H, bars: [{ openTime: T - 10 * H, availableAt: T - 9 * H, close: "1" }, { openTime: T + H, availableAt: T + 2 * H, close: "2" }] }, T, [H]);
    expect(out).toMatchObject({ label: HYPOTHETICAL, reason: "REFERENCE_STALE", referenceClose: null });
    expect(out.horizons[0]!.forwardReturn).toBeNull();
  });

  it("manifest hash is deterministic and independent of window split and row order", () => {
    const input = {
      cycles: [cycle, { ...cycle, cycleId: "c2", startedAt: new Date(T + H) }],
      funnel: [funnel("DISCOVERED"), funnel("DISCOVERED", { cycleId: "c2", createdAt: new Date(T + H + S) })],
      decisions: [decision()],
      intents: [],
    };
    const all = buildOpportunityRows(input);
    const one = new OpportunityManifestBuilder();
    all.forEach((r) => one.add(r));
    const split = new OpportunityManifestBuilder();
    buildOpportunityRows({ ...input, cycles: [input.cycles[1]!], funnel: [input.funnel[1]!], decisions: [] }).forEach((r) => split.add(r));
    buildOpportunityRows({ ...input, cycles: [input.cycles[0]!], funnel: [input.funnel[0]!] }).forEach((r) => split.add(r));
    const bounds = { from: "a", to: "b" };
    const m1 = one.finish({ queryBounds: bounds, counterfactualHorizonsMs: null, format: "jsonl" });
    const m2 = split.finish({ queryBounds: bounds, counterfactualHorizonsMs: null, format: "jsonl" });
    expect(m1.contentHash).toBe(m2.contentHash);
    expect(m1).toMatchObject({ rowCount: 2, timeRange: { firstDecisionAt: new Date(T + 5 * S).toISOString(), lastDecisionAt: new Date(T + H + S).toISOString() }, queryBounds: bounds });
    const changed = new OpportunityManifestBuilder();
    buildOpportunityRows({ ...input, decisions: [decision({ confidence: "0.500000" })] }).forEach((r) => changed.add(r));
    expect(changed.finish({ queryBounds: bounds, counterfactualHorizonsMs: null, format: "jsonl" }).contentHash).not.toBe(m1.contentHash);
  });

  it("writes CSV rows with escaped JSON columns", () => {
    const [row] = buildOpportunityRows({ cycles: [cycle], funnel: [funnel("DISCOVERED", { reasonCodes: ["A,B"] })], decisions: [decision()], intents: [] });
    const header = opportunityCsvHeader().split(",");
    const csv = opportunityRowToCsv(row!);
    expect(header[0]).toBe("rowId");
    expect(csv.startsWith("c1:POOL_A,c1,POOL_A,")).toBe(true);
    expect(csv).toContain('"A,B"');
  });
});
