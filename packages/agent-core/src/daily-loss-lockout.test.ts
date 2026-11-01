import { DEFAULT_STRATEGY, rollSessionEquity, startOfLondonDay, strategyConfigSchema, type CyclePair } from "@odin/shared";
import { describe, expect, it } from "vitest";
import { planCycle, type PlanInput } from "./plan.js";
import { toPlanIntents, type AttributedSignal } from "./strategy-instances.js";
import { withPassingSecurity } from "./test-security.js";
import type { PlanIntent } from "./types.js";

/**
 * ASCEND-00 regression: the paper account fell to about $9,679.11 (-3.21%) against a 3% daily
 * loss cap, CIRCUIT_BREAKER rejections followed, then an operator resumed the engine. These
 * tests replay that state through the real planner and session roll to show that no BUY path
 * (pulse, operator ticket, strategy instance) is admitted while exits still are, that the breach
 * latches for the rest of the London day (F1), and that entries are sized to the loss headroom left (F2).
 */

const pairAddress = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE";
const fx = "fx:EURUSD";
const DAY_START = "10000.00000000";
const BREACHED_EQUITY = "9679.11000000";
const BREACHED_PNL = "-320.89000000";
// 31 Oct 2026 is GMT (UK clocks went back on 25 Oct), so London midnight is 00:00Z.
const now = new Date("2026-10-31T15:00:00.000Z");
const sessionStartedAt = startOfLondonDay(now);

function solPair(overrides: Partial<CyclePair> = {}): CyclePair {
  return {
    source: "dexscreener",
    chainId: "solana",
    pairAddress,
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
    observationId: "obs_1",
    freshness: "LIVE",
    receivedAt: now.toISOString(),
    ...overrides,
  };
}

function fxPair(): CyclePair {
  return {
    ...solPair(),
    source: "fixture",
    chainId: "fx",
    pairAddress: fx,
    dexId: null,
    baseAddress: "EUR",
    baseSymbol: "EUR",
    baseName: "Euro",
    quoteAddress: "USD",
    quoteSymbol: "USD",
    priceUsd: "1.08",
    priceChangeM5Pct: "0.1",
    priceChangeH1Pct: "0.1",
    priceChangeH24Pct: null,
    txnsM5Buys: null,
    txnsM5Sells: null,
    observationId: "obs_fx",
  };
}

function instanceEntry(pair: string): PlanIntent {
  const signal: AttributedSignal = {
    intent: "ENTER_LONG",
    reasonCodes: ["ENTRY_MOMENTUM"],
    instrumentId: pair,
    pairAddress: pair,
    strategyInstanceId: "stratinst_new",
    strategyVersion: "stratinst_new@1.0.0",
    moduleRef: "pulse-momentum-v1",
    accountId: "primary",
    artifactHash: null,
    sourceHash: null,
  };
  return toPlanIntents([signal], { cycleId: "cyc_lockout", accountId: "primary" })[0]!;
}

/** Account state after the breach: all cash, equity $9,679.11, day started at $10,000. */
function breached(overrides: Partial<PlanInput> = {}): PlanInput {
  const quote = solPair();
  return withPassingSecurity({
    cycleId: "cyc_lockout",
    engineStatus: "RUNNING",
    config: DEFAULT_STRATEGY,
    cashUsd: BREACHED_EQUITY,
    startingBalanceUsd: DEFAULT_STRATEGY.startingBalanceUsd,
    dayStartEquityUsd: DAY_START,
    positions: [],
    pairs: [quote],
    marks: { [pairAddress]: { priceUsd: quote.priceUsd, freshness: "LIVE" } },
    dailyPnlUsd: BREACHED_PNL,
    flatten: false,
    operator: null,
    highWaterMarkUsd: DAY_START,
    aggregateExposureUsd: "0.00000000",
    now,
    ...overrides,
  });
}

function buys(plan: ReturnType<typeof planCycle>) {
  return plan.orders.filter((order) => order.side === "BUY");
}

function rejectedFor(plan: ReturnType<typeof planCycle>, code: string) {
  return plan.decisions.some((decision) => decision.agent === "ATLAS" && decision.decision === "REJECT" && decision.reasonCodes.includes(code));
}

describe("ASCEND-00 daily-loss lockout", () => {
  it("control: the same book with a healthy day opens a momentum entry", () => {
    const plan = planCycle(breached({ cashUsd: DAY_START, dailyPnlUsd: "0.00000000" }));
    expect(buys(plan)).toHaveLength(1);
  });

  it("derives -3.21% from persisted Europe/London start-of-day equity, unchanged by a restart", () => {
    const persisted = {
      now,
      sessionStartedAt,
      sessionStartEquityUsd: DAY_START,
      currentEquityUsd: BREACHED_EQUITY,
      highWaterMarkUsd: DAY_START,
      startingBalanceUsd: DEFAULT_STRATEGY.startingBalanceUsd,
    };
    const first = rollSessionEquity(persisted);
    // A worker restart re-reads the same PaperAccount row; the roll is a pure function of it.
    const afterRestart = rollSessionEquity({ ...persisted, now: new Date(now.getTime() + 60_000) });
    for (const roll of [first, afterRestart]) {
      expect(roll.rolled).toBe(false);
      expect(roll.sessionStartEquityUsd).toBe(DAY_START);
      expect(roll.dailyPnlUsd).toBe(BREACHED_PNL);
    }
  });

  it("blocks automatic entries while the breach stands, after an operator resume (RUNNING again)", () => {
    // engine/resume only rewrites EngineControl.status; the next cycle plans from the same account row.
    const plan = planCycle(breached({ engineStatus: "RUNNING" }));
    expect(buys(plan)).toHaveLength(0);
    expect(rejectedFor(plan, "CIRCUIT_BREAKER")).toBe(true);
  });

  it("blocks an operator BUY ticket", () => {
    const plan = planCycle(
      breached({
        pairs: [solPair({ priceChangeM5Pct: "0", txnsM5Buys: 1, txnsM5Sells: 9 })],
        operator: { side: "BUY", pairAddress, notionalUsd: "25" },
      }),
    );
    expect(buys(plan)).toHaveLength(0);
    expect(rejectedFor(plan, "CIRCUIT_BREAKER")).toBe(true);
  });

  it("blocks an entry from a strategy instance created after the breach", () => {
    // FX entries need an open session; 31 Oct 2026 is a Saturday, so use the Wednesday before.
    const weekday = new Date("2026-10-28T15:00:00.000Z");
    const quote = { ...fxPair(), receivedAt: weekday.toISOString() };
    const control = planCycle(
      breached({
        cashUsd: DAY_START,
        dailyPnlUsd: "0.00000000",
        pairs: [quote],
        marks: { [fx]: { priceUsd: quote.priceUsd, freshness: "LIVE" } },
        instanceIntents: [instanceEntry(fx)],
        now: weekday,
      }),
    );
    expect(buys(control)).toHaveLength(1);

    const plan = planCycle(
      breached({
        pairs: [quote],
        marks: { [fx]: { priceUsd: quote.priceUsd, freshness: "LIVE" } },
        instanceIntents: [instanceEntry(fx)],
        now: weekday,
      }),
    );
    expect(buys(plan)).toHaveLength(0);
    expect(rejectedFor(plan, "CIRCUIT_BREAKER")).toBe(true);
  });

  it("keeps the cap after a config reload (stored config re-parsed with defaults)", () => {
    const reloaded = strategyConfigSchema.parse({ ...DEFAULT_STRATEGY });
    expect(reloaded.maxDailyLossPct).toBe(DEFAULT_STRATEGY.maxDailyLossPct);
    expect(buys(planCycle(breached({ config: reloaded })))).toHaveLength(0);
  });

  it("blocks at exactly -3.00%; at -2.99% the gate passes but $1 of headroom sizes below the minimum order (F2)", () => {
    const atLimit = planCycle(breached({ cashUsd: "9700.00000000", dailyPnlUsd: "-300.00000000" }));
    expect(buys(atLimit)).toHaveLength(0);
    expect(rejectedFor(atLimit, "CIRCUIT_BREAKER")).toBe(true);
    const nearLimit = planCycle(breached({ cashUsd: "9701.00000000", dailyPnlUsd: "-299.00000000" }));
    expect(buys(nearLimit)).toHaveLength(0);
    expect(rejectedFor(nearLimit, "CIRCUIT_BREAKER")).toBe(false);
    expect(rejectedFor(nearLimit, "MIN_ORDER_EXCEEDS_RISK_CAP")).toBe(true);
    expect(buys(planCycle(breached({ cashUsd: "9800.00000000", dailyPnlUsd: "-200.00000000" })))).toHaveLength(1);
  });

  it("blocks entries when daily P&L is unavailable instead of treating it as zero", () => {
    const plan = planCycle(breached({ cashUsd: DAY_START, dailyPnlUsd: null }));
    expect(buys(plan)).toHaveLength(0);
    expect(rejectedFor(plan, "DAILY_PNL_UNAVAILABLE")).toBe(true);
  });

  it("still lets a stop-loss exit reduce risk while entries are locked out", () => {
    const plan = planCycle(
      breached({
        cashUsd: "9654.11000000",
        dailyPnlUsd: "-323.39000000",
        positions: [
          { pairAddress, baseSymbol: "SOL", baseQty: "0.25000000", avgCostUsd: "100.00000000", realizedPnlUsd: "0.00000000" },
        ],
        pairs: [solPair({ priceUsd: "90", priceChangeM5Pct: "0.1", priceChangeH1Pct: "0.1" })],
        marks: { [pairAddress]: { priceUsd: "90", freshness: "LIVE" } },
      }),
    );
    expect(plan.orders.map((order) => order.side)).toEqual(["SELL"]);
    expect(buys(plan)).toHaveLength(0);
  });

  it("lifts the lockout only at the next Europe/London midnight, rebasing on that day's equity", () => {
    // 00:30 BST on 31 Mar 2027 is 23:30Z on the 30th: still the old UTC day, already the new London day.
    const bstNow = new Date("2027-03-30T23:30:00.000Z");
    const roll = rollSessionEquity({
      now: bstNow,
      sessionStartedAt: new Date("2027-03-29T23:00:00.000Z"),
      sessionStartEquityUsd: DAY_START,
      currentEquityUsd: BREACHED_EQUITY,
      highWaterMarkUsd: DAY_START,
      startingBalanceUsd: DEFAULT_STRATEGY.startingBalanceUsd,
    });
    expect(roll.rolled).toBe(true);
    expect(roll.sessionStartedAt.toISOString()).toBe("2027-03-30T23:00:00.000Z");
    expect(roll.sessionStartEquityUsd).toBe(BREACHED_EQUITY);
    expect(roll.dailyPnlUsd).toBe("0.00000000");
  });

  it("F1: keeps entries blocked for the rest of the London day after equity recovers above -3%", () => {
    // Equity recovered from -3.21% to -2.90%; the day's worst (-$320.89) still latches the limit.
    const latched = planCycle(breached({ cashUsd: "9710.00000000", dailyPnlUsd: "-290.00000000", worstDailyPnlUsd: BREACHED_PNL }));
    expect(buys(latched)).toHaveLength(0);
    expect(rejectedFor(latched, "CIRCUIT_BREAKER")).toBe(true);
    // Control: the same recovery without a breach earlier in the day still trades.
    const control = planCycle(breached({ cashUsd: "9710.00000000", dailyPnlUsd: "-290.00000000", worstDailyPnlUsd: "-290.00000000" }));
    expect(buys(control)).toHaveLength(1);
  });

  it("F1: the latch survives a worker restart because the session low is persisted, and clears on the London roll", () => {
    const persisted = {
      sessionStartedAt,
      sessionStartEquityUsd: DAY_START,
      highWaterMarkUsd: DAY_START,
      sessionLowEquityUsd: BREACHED_EQUITY,
      startingBalanceUsd: DEFAULT_STRATEGY.startingBalanceUsd,
    };
    const sameDay = rollSessionEquity({ ...persisted, now: new Date("2026-10-31T18:00:00.000Z"), currentEquityUsd: "9710.00000000" });
    expect(sameDay.worstDailyPnlUsd).toBe(BREACHED_PNL);
    const nextDay = rollSessionEquity({ ...persisted, now: new Date("2026-11-01T00:07:40.000Z"), currentEquityUsd: BREACHED_EQUITY });
    expect(nextDay.rolled).toBe(true);
    expect(nextDay.worstDailyPnlUsd).toBe("0.00000000");
    expect(buys(planCycle(breached({ dayStartEquityUsd: nextDay.sessionStartEquityUsd, dailyPnlUsd: nextDay.dailyPnlUsd, worstDailyPnlUsd: nextDay.worstDailyPnlUsd })))).toHaveLength(1);
  });

  it("F2: sizes the 31 Oct 15:59 entry so its stop-out cannot exceed the $34.94 of headroom left", () => {
    // Replays HALLOWTRUMP: equity $9,734.94 (-2.65%) when the last entry was admitted at $493.51.
    const pre = planCycle(breached({ cashUsd: "9734.94000000", dailyPnlUsd: "-265.06000000", worstDailyPnlUsd: "-265.06000000" }));
    const entry = buys(pre)[0];
    expect(entry).toBeDefined();
    const notional = Number(entry!.qty) * 100;
    // Worst stop-out loss per $ under defaults: 3% stop + 1.8% entry costs + 10.3% exit costs = 15.1%.
    expect(notional * 0.151).toBeLessThanOrEqual(34.94);
    expect(notional).toBeLessThan(493.51);
  });

  it("F2: an open position's stop-out risk is taken out of the headroom before sizing a new entry", () => {
    // Same -2.65% day, but a $200 position (at cost) is already open: it can lose $6 to its stop plus
    // $20.60 exit costs, leaving $8.34 of the $34.94 for the new entry.
    const other = "OtherPair1111111111111111111111111111111111";
    const plan = planCycle(
      breached({
        cashUsd: "9534.94000000",
        dailyPnlUsd: "-265.06000000",
        positions: [{ pairAddress: other, baseSymbol: "OTH", baseQty: "2.00000000", avgCostUsd: "100.00000000", realizedPnlUsd: "0.00000000" }],
        marks: { [pairAddress]: { priceUsd: "100", freshness: "LIVE" }, [other]: { priceUsd: "100", freshness: "LIVE" } },
      }),
    );
    const entry = buys(plan)[0];
    expect(entry).toBeDefined();
    const notional = Number(entry!.qty) * 100;
    expect(notional * 0.151).toBeLessThanOrEqual(8.34 + 1e-6);
    expect(notional).toBeGreaterThanOrEqual(25);
  });

  it("F2: an operator BUY above the headroom cap is rejected rather than shrunk", () => {
    const plan = planCycle(
      breached({
        cashUsd: "9734.94000000",
        dailyPnlUsd: "-265.06000000",
        pairs: [solPair({ priceChangeM5Pct: "0", txnsM5Buys: 1, txnsM5Sells: 9 })],
        operator: { side: "BUY", pairAddress, notionalUsd: "400" },
      }),
    );
    expect(buys(plan)).toHaveLength(0);
    expect(plan.decisions.some((decision) => decision.reasonCodes.includes("SIZE_ABOVE_CAP"))).toBe(true);
  });
});
