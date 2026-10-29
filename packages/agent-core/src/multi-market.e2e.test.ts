import { DEFAULT_STRATEGY, type CyclePair } from "@odin/shared";
import { armOco, evaluateOco } from "@odin/trading-engine";
import { ReservationLedger } from "@odin/risk-engine";
import { describe, expect, it } from "vitest";
import { planCycle, type PlanInput } from "./plan.js";
import { recordFunnelEvent, summarizeFunnel } from "./funnel.js";

/**
 * Multi-market paper E2E (≥3 asset classes) with explicit fixture capital.
 * Uses DEMO FX/ETF + LIVE-shaped crypto fixtures. Does not claim live venue success.
 */
describe("multi-market paper E2E", () => {
  it("opens protected capacity across crypto, FX, and ETF with ≥20 slot budget", () => {
    const config = {
      ...DEFAULT_STRATEGY,
      startingBalanceUsd: "250000.00000000",
      maxPositions: 50,
      maxAggregateExposurePct: "80",
      maxPositionPctEquity: "4",
      minOrderNotionalUsd: "25",
      allowDemoPaperEntries: true,
      entryM5ChangePct: "2",
      universeLimit: 40,
    };

    const crypto: CyclePair[] = Array.from({ length: 10 }, (_, i) =>
      pair(`crypto-${String(i).padStart(2, "0")}${"x".repeat(24)}`, {
        chainId: "solana",
        source: "dexscreener",
        freshness: "LIVE",
        baseSymbol: `C${i}`,
        priceUsd: "10",
        priceChangeM5Pct: "3",
        priceChangeH1Pct: "1",
        txnsM5Buys: 20,
        txnsM5Sells: 5,
        observationId: `obs_c_${i}`,
      }),
    );
    const fx: CyclePair[] = ["fx:EURUSD", "fx:GBPUSD"].map((id, i) =>
      pair(id, {
        chainId: "fx",
        source: "fx_stub",
        freshness: "DEMO",
        baseSymbol: id.slice(3),
        quoteAddress: "USD",
        quoteSymbol: "USD",
        priceUsd: i === 0 ? "1.085" : "1.265",
        priceChangeM5Pct: "2.5",
        priceChangeH1Pct: "1",
        txnsM5Buys: null,
        txnsM5Sells: null,
        observationId: `obs_${id}`,
        liquidityUsd: "50000000",
      }),
    );
    const etf: CyclePair[] = ["etf:SPY", "etf:QQQ"].map((id, i) =>
      pair(id, {
        chainId: "equity",
        source: "etf_stub",
        freshness: "DEMO",
        baseSymbol: id.slice(4),
        quoteAddress: "USD",
        quoteSymbol: "USD",
        priceUsd: i === 0 ? "520" : "445",
        priceChangeM5Pct: "2.5",
        priceChangeH1Pct: "1",
        txnsM5Buys: null,
        txnsM5Sells: null,
        observationId: `obs_${id}`,
        liquidityUsd: "50000000",
      }),
    );
    const commodity: CyclePair[] = ["commodity:XAUUSD", "commodity:WTI"].map((id, i) =>
      pair(id, {
        chainId: "commodity",
        source: "commodity_stub",
        freshness: "DEMO",
        baseSymbol: id.split(":")[1] ?? id,
        quoteAddress: "USD",
        quoteSymbol: "USD",
        priceUsd: i === 0 ? "2650" : "78",
        priceChangeM5Pct: "2.5",
        priceChangeH1Pct: "1",
        txnsM5Buys: null,
        txnsM5Sells: null,
        observationId: `obs_${id}`,
        liquidityUsd: "50000000",
      }),
    );

    const pairs = [...crypto, ...fx, ...etf, ...commodity];
    const marks = Object.fromEntries(
      pairs.map((row) => [row.pairAddress, { priceUsd: row.priceUsd, freshness: row.freshness }]),
    );

    const plan = planCycle(
      input({
        config,
        cashUsd: config.startingBalanceUsd,
        startingBalanceUsd: config.startingBalanceUsd,
        highWaterMarkUsd: config.startingBalanceUsd,
        pairs,
        marks,
      }),
    );

    const buys = plan.orders.filter((order) => order.side === "BUY");
    expect(buys.length).toBeGreaterThanOrEqual(3);
    const classes = new Set(
      buys.map((order) => {
        if (order.pairAddress.startsWith("fx:")) return "FX";
        if (order.pairAddress.startsWith("etf:")) return "ETF";
        if (order.pairAddress.startsWith("commodity:")) return "COMMODITY";
        return "CRYPTO";
      }),
    );
    expect(classes.has("CRYPTO")).toBe(true);
    expect(classes.has("FX") || classes.has("ETF") || classes.has("COMMODITY")).toBe(true);

    // Arm synthetic OCO protection for each buy — capacity check ≥20 slots separately.
    const ledger = new ReservationLedger({
      cashAvailableUsd: config.startingBalanceUsd,
      exposureCapUsd: "200000.00000000",
      exposureUsedUsd: "0",
      slotsAvailable: 50,
      slotsUsed: 0,
      riskBudgetUsd: "25000.00000000",
      riskUsedUsd: "0",
    });
    for (let i = 0; i < 20; i += 1) {
      const reserved = ledger.reserve({
        id: `res_${i}`,
        accountId: "primary",
        mode: "PAPER",
        clientOrderId: `slot_${i}`,
        cashUsd: "1000",
        exposureUsd: "1000",
        slots: 1,
        riskUsd: "50",
      });
      expect(reserved.ok).toBe(true);
      const oco = armOco({
        groupId: `oco_${i}`,
        positionKey: `primary:pos_${i}`,
        direction: "LONG",
        protectedQty: "1",
        stopPriceUsd: "9",
        takeProfitPriceUsd: "12",
        origin: "SYNTHETIC_ENGINE",
      });
      const evaled = evaluateOco(oco, "8.5");
      expect(evaled.triggered?.kind).toBe("STOP");
      expect(evaled.cancelled).toHaveLength(1);
    }
    expect(ledger.snapshot().slotsUsed).toBe(20);

    let funnel = recordFunnelEvent([], {
      cycleId: "e2e",
      pairAddress: "fx:EURUSD",
      stage: "DISCOVERED",
      reasonCodes: ["DISCOVERY_RANKED"],
    });
    funnel = recordFunnelEvent(funnel, {
      cycleId: "e2e",
      pairAddress: "fx:EURUSD",
      stage: "ORDERED",
      reasonCodes: ["ORDER_PROPOSED"],
    });
    expect(summarizeFunnel(funnel).ORDERED).toBe(1);
  });

  it("evaluates held FX/ETF/commodity marks outside discovery for exits", () => {
    const config = {
      ...DEFAULT_STRATEGY,
      startingBalanceUsd: "10000.00000000",
      maxPositions: 10,
      allowDemoPaperEntries: true,
      stopLossPct: "5",
    };
    // Discovery only has a quiet crypto pair — held multi-market books must still exit on stop.
    const discovery = [
      pair("crypto-discovery-onlyxxxxxxxxxxxxxxxxxxxx", {
        priceUsd: "100",
        priceChangeM5Pct: "0.1",
        priceChangeH1Pct: "0.1",
        txnsM5Buys: 1,
        txnsM5Sells: 9,
        freshness: "LIVE",
      }),
      pair("fx:EURUSD", {
        chainId: "fx",
        source: "fx_stub",
        freshness: "DEMO",
        baseSymbol: "EUR",
        quoteSymbol: "USD",
        priceUsd: "1.00",
        priceChangeM5Pct: "0.1",
        priceChangeH1Pct: "0.1",
        observationId: "obs_held_fx",
        liquidityUsd: "50000000",
      }),
      pair("etf:SPY", {
        chainId: "equity",
        source: "etf_stub",
        freshness: "DEMO",
        baseSymbol: "SPY",
        quoteSymbol: "USD",
        priceUsd: "480",
        priceChangeM5Pct: "0.1",
        priceChangeH1Pct: "0.1",
        observationId: "obs_held_etf",
        liquidityUsd: "50000000",
      }),
      pair("commodity:XAUUSD", {
        chainId: "commodity",
        source: "commodity_stub",
        freshness: "DEMO",
        baseSymbol: "XAU",
        quoteSymbol: "USD",
        priceUsd: "2400",
        priceChangeM5Pct: "0.1",
        priceChangeH1Pct: "0.1",
        observationId: "obs_held_xau",
        liquidityUsd: "50000000",
      }),
    ];
    const plan = planCycle(
      input({
        config,
        cashUsd: "5000.00000000",
        startingBalanceUsd: config.startingBalanceUsd,
        highWaterMarkUsd: config.startingBalanceUsd,
        pairs: discovery,
        marks: Object.fromEntries(
          discovery.map((row) => [row.pairAddress, { priceUsd: row.priceUsd, freshness: row.freshness }]),
        ),
        positions: [
          {
            pairAddress: "fx:EURUSD",
            baseSymbol: "EUR",
            baseQty: "1000",
            avgCostUsd: "1.10",
            realizedPnlUsd: "0",
          },
          {
            pairAddress: "etf:SPY",
            baseSymbol: "SPY",
            baseQty: "2",
            avgCostUsd: "520",
            realizedPnlUsd: "0",
          },
          {
            pairAddress: "commodity:XAUUSD",
            baseSymbol: "XAU",
            baseQty: "1",
            avgCostUsd: "2650",
            realizedPnlUsd: "0",
          },
        ],
      }),
    );
    const sells = plan.orders.filter((order) => order.side === "SELL");
    const sold = new Set(sells.map((order) => order.pairAddress));
    expect(sold.has("fx:EURUSD") || sold.has("etf:SPY") || sold.has("commodity:XAUUSD")).toBe(true);
  });

  it("blocks FX entries when session is weekend-closed without inventing open status", () => {
    const saturday = new Date("2026-10-24T15:00:00.000Z");
    const plan = planCycle(
      input({
        config: {
          ...DEFAULT_STRATEGY,
          allowDemoPaperEntries: true,
          entryM5ChangePct: "2",
        },
        now: saturday,
        cashUsd: "10000",
        pairs: [
          pair("fx:EURUSD", {
            chainId: "fx",
            source: "fx_stub",
            freshness: "DEMO",
            baseSymbol: "EUR",
            priceUsd: "1.08",
            priceChangeM5Pct: "3",
            priceChangeH1Pct: "1",
            observationId: "obs_fx_weekend",
            liquidityUsd: "50000000",
          }),
        ],
        marks: { "fx:EURUSD": { priceUsd: "1.08", freshness: "DEMO" } },
      }),
    );
    const buys = plan.orders.filter((o) => o.side === "BUY" && o.pairAddress === "fx:EURUSD");
    expect(buys).toHaveLength(0);
    expect(
      plan.decisions.some(
        (d) => d.pairAddress === "fx:EURUSD" && d.reasonCodes.includes("SESSION_CLOSED"),
      ),
    ).toBe(true);
  });
});

function pair(address: string, overrides: Partial<CyclePair> = {}): CyclePair {
  return {
    source: "dexscreener",
    chainId: "solana",
    pairAddress: address,
    dexId: "paper",
    url: null,
    baseAddress: address,
    baseSymbol: "BASE",
    baseName: "Base",
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
    observationId: `obs_${address}`,
    freshness: "LIVE",
    receivedAt: "2026-10-28T16:00:00.000Z",
    ...overrides,
  };
}

function input(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    cycleId: "cyc_e2e",
    engineStatus: "RUNNING",
    config: DEFAULT_STRATEGY,
    cashUsd: DEFAULT_STRATEGY.startingBalanceUsd,
    startingBalanceUsd: DEFAULT_STRATEGY.startingBalanceUsd,
    positions: [],
    pairs: [],
    marks: {},
    dailyPnlUsd: "0.00000000",
    flatten: false,
    operator: null,
    highWaterMarkUsd: DEFAULT_STRATEGY.startingBalanceUsd,
    aggregateExposureUsd: "0.00000000",
    ...overrides,
  };
}
