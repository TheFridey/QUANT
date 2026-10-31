import { DEFAULT_STRATEGY, type CyclePair } from "@odin/shared";
import { describe, expect, it } from "vitest";
import { planCycle, type PlanInput } from "./plan.js";
import { withPassingSecurity } from "./test-security.js";

const pairA = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE";
const pairB = "7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm";

function pair(address: string, overrides: Partial<CyclePair> = {}): CyclePair {
  return {
    source: "dexscreener",
    chainId: "solana",
    pairAddress: address,
    dexId: "orca",
    url: null,
    baseAddress: "So11111111111111111111111111111111111111112",
    baseSymbol: "SOL",
    baseName: "Wrapped SOL",
    quoteAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    quoteSymbol: "USDC",
    priceUsd: "100",
    liquidityUsd: "1000000",
    volume24hUsd: "5000000",
    volume5mUsd: "10000",
    priceChangeM5Pct: "3.5",
    priceChangeH1Pct: "1.2",
    priceChangeH24Pct: "4",
    txnsM5Buys: 80,
    txnsM5Sells: 20,
    observationId: `obs_${address.slice(0, 8)}`,
    freshness: "LIVE",
    receivedAt: "2026-10-28T16:00:00.000Z",
    ...overrides,
  };
}

function base(overrides: Partial<PlanInput> = {}): PlanInput {
  const quote = pair(pairA);
  return withPassingSecurity({
    cycleId: "cyc_gate_a",
    engineStatus: "RUNNING",
    config: DEFAULT_STRATEGY,
    cashUsd: DEFAULT_STRATEGY.startingBalanceUsd,
    startingBalanceUsd: DEFAULT_STRATEGY.startingBalanceUsd,
    positions: [],
    pairs: [quote],
    marks: { [pairA]: { priceUsd: quote.priceUsd, freshness: "LIVE" } },
    dailyPnlUsd: "0.00000000",
    flatten: false,
    operator: null,
    highWaterMarkUsd: DEFAULT_STRATEGY.startingBalanceUsd,
    aggregateExposureUsd: "0.00000000",
    now: new Date("2026-10-28T16:00:00.000Z"),
    ...overrides,
  });
}

describe("Gate A regressions", () => {
  it("rejects when min order exceeds the risk-sized cap without rounding up", () => {
    const plan = planCycle(
      base({
        config: {
          ...DEFAULT_STRATEGY,
          startingBalanceUsd: "100.00000000",
          maxPositionPctEquity: "5",
          minOrderNotionalUsd: "5",
          // Bypass schema headroom guard by constructing PlanInput directly.
        },
        cashUsd: "100.00000000",
        startingBalanceUsd: "100.00000000",
        highWaterMarkUsd: "100.00000000",
      }),
    );
    // Cap ≈ $5; fee/slippage or exact boundary may still propose or reject — must not inflate above cap.
    for (const order of plan.orders) {
      expect(Number(order.qty) * 100).toBeLessThanOrEqual(5.01);
    }
    if (plan.orders.length === 0) {
      expect(
        plan.decisions.some(
          (d) =>
            d.reasonCodes.includes("MIN_ORDER_EXCEEDS_RISK_CAP") ||
            d.reasonCodes.includes("BELOW_MIN_NOTIONAL") ||
            d.reasonCodes.includes("SIZE_ZERO"),
        ),
      ).toBe(true);
    }
  });

  it("evaluates exits for a held token that is not in the discovery candidate list alone", () => {
    // Pair B is held; discovery snapshot only has pair A with no edge. Held B must still get stop exit.
    const plan = planCycle(
      base({
        cashUsd: "9500.00000000",
        positions: [
          {
            pairAddress: pairB,
            baseSymbol: "BONK",
            baseQty: "10.00000000",
            avgCostUsd: "100.00000000",
            realizedPnlUsd: "0.00000000",
          },
        ],
        pairs: [
          pair(pairA, { priceChangeM5Pct: "0.1", txnsM5Buys: 1, txnsM5Sells: 9 }),
          pair(pairB, {
            baseSymbol: "BONK",
            priceUsd: "90",
            priceChangeM5Pct: "0.1",
            priceChangeH1Pct: "0.1",
            observationId: "obs_held",
          }),
        ],
        marks: {
          [pairA]: { priceUsd: "100", freshness: "LIVE" },
          [pairB]: { priceUsd: "90", freshness: "LIVE" },
        },
      }),
    );
    expect(plan.orders.some((order) => order.pairAddress === pairB && order.side === "SELL")).toBe(true);
  });

  it("preserves eligibleAt into proposed orders for pending latency", () => {
    const now = new Date("2026-10-28T16:00:00.000Z");
    const plan = planCycle(
      base({
        config: { ...DEFAULT_STRATEGY, paperLatencyMs: 5_000, orderExpiryMs: 60_000 },
        now,
      }),
    );
    expect(plan.orders.length).toBeGreaterThan(0);
    const order = plan.orders[0]!;
    expect(order.eligibleAt).toBe(new Date(now.getTime() + 5_000).toISOString());
    expect(order.reasonCodes).toContain("ORDER_PENDING");
  });

  it("releases in-cycle capacity after a completed sell so a later buy can size", () => {
    const config = {
      ...DEFAULT_STRATEGY,
      // In-cycle capacity release applies to immediate fills; the 1 s default defers them.
      paperLatencyMs: 0,
      maxPositions: 1,
      maxAggregateExposurePct: "5",
      maxPositionPctEquity: "5",
    };
    const plan = planCycle(
      base({
        config,
        cashUsd: "9500.00000000",
        aggregateExposureUsd: "500.00000000",
        positions: [
          {
            pairAddress: pairA,
            baseSymbol: "SOL",
            baseQty: "5.00000000",
            avgCostUsd: "100.00000000",
            realizedPnlUsd: "0.00000000",
          },
        ],
        pairs: [
          pair(pairA, { priceUsd: "90", priceChangeM5Pct: "0.1", priceChangeH1Pct: "0.1" }),
          pair(pairB, {
            priceUsd: "50",
            priceChangeM5Pct: "3.5",
            priceChangeH1Pct: "1",
            observationId: "obs_b",
          }),
        ],
        marks: {
          [pairA]: { priceUsd: "90", freshness: "LIVE" },
          [pairB]: { priceUsd: "50", freshness: "LIVE" },
        },
      }),
    );
    const sides = plan.orders.map((order) => `${order.pairAddress}:${order.side}`);
    expect(sides.some((s) => s.startsWith(`${pairA}:SELL`))).toBe(true);
    // With capacity released after the sell, a buy on B can be proposed in the same cycle.
    expect(sides.some((s) => s.startsWith(`${pairB}:BUY`))).toBe(true);
  });

  it("fires trailing and time exits when peak/opened metadata is present", () => {
    const trailing = planCycle(
      base({
        config: { ...DEFAULT_STRATEGY, trailingStopPct: "2" },
        cashUsd: "9500.00000000",
        positions: [
          {
            pairAddress: pairA,
            baseSymbol: "SOL",
            baseQty: "1.00000000",
            avgCostUsd: "100.00000000",
            realizedPnlUsd: "0.00000000",
            peakMarkUsd: "110.00000000",
          },
        ],
        // Peak 110 → 104 is a 5.45% trail; unrealized +4% stays below default 5% take-profit.
        pairs: [pair(pairA, { priceUsd: "104", priceChangeM5Pct: "0.1", priceChangeH1Pct: "0.1" })],
        marks: { [pairA]: { priceUsd: "104", freshness: "LIVE" } },
      }),
    );
    expect(trailing.orders.some((o) => o.side === "SELL")).toBe(true);
    expect(trailing.decisions.some((d) => d.agent === "PULSE" && d.reasonCodes.includes("TRAILING_STOP"))).toBe(true);

    const timed = planCycle(
      base({
        config: { ...DEFAULT_STRATEGY, maxHoldingMs: 60_000 },
        cashUsd: "9500.00000000",
        positions: [
          {
            pairAddress: pairA,
            baseSymbol: "SOL",
            baseQty: "1.00000000",
            avgCostUsd: "100.00000000",
            realizedPnlUsd: "0.00000000",
            openedAt: "2026-10-28T15:00:00.000Z",
          },
        ],
        pairs: [pair(pairA, { priceUsd: "101", priceChangeM5Pct: "0.1", priceChangeH1Pct: "0.1", receivedAt: "2026-10-28T16:00:00.000Z" })],
        marks: { [pairA]: { priceUsd: "101", freshness: "LIVE" } },
      }),
    );
    expect(timed.decisions.some((d) => d.reasonCodes.includes("TIME_EXIT") || d.reasonCodes.includes("MAX_HOLDING"))).toBe(true);
  });
});
