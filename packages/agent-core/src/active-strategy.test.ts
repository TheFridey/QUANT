import { DEFAULT_STRATEGY, type CyclePair } from "@odin/shared";
import { describe, expect, it } from "vitest";
import {
  parseActiveStrategyIdentity,
  strategyVersionStamp,
} from "./active-strategy.js";
import { planCycle, type PlanInput } from "./plan.js";

const hashA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const hashB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function solPair(overrides: Partial<CyclePair> = {}): CyclePair {
  return {
    source: "dexscreener",
    chainId: "solana",
    pairAddress: "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE",
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
    observationId: "obs_promoted",
    freshness: "LIVE",
    receivedAt: "2026-10-28T16:00:00.000Z",
    ...overrides,
  };
}

function planInput(activeStrategyId: string | null): PlanInput {
  const pair = solPair();
  return {
    cycleId: "cyc_promoted",
    engineStatus: "RUNNING",
    config: DEFAULT_STRATEGY,
    cashUsd: DEFAULT_STRATEGY.startingBalanceUsd,
    startingBalanceUsd: DEFAULT_STRATEGY.startingBalanceUsd,
    positions: [],
    pairs: [pair],
    marks: { [pair.pairAddress]: { priceUsd: pair.priceUsd, freshness: "LIVE" } },
    dailyPnlUsd: "0.00000000",
    flatten: false,
    operator: null,
    highWaterMarkUsd: DEFAULT_STRATEGY.startingBalanceUsd,
    aggregateExposureUsd: "0.00000000",
    activeStrategyId,
    now: new Date("2026-10-28T16:00:00.000Z"),
  };
}

describe("active strategy identity + runtime decisions", () => {
  it("parses EngineControl.activeStrategy and stamps exact version/hash", () => {
    const identity = parseActiveStrategyIdentity({
      strategyId: "pulse-momentum-v1",
      strategyVersion: "1.0.0",
      sourceHash: hashA,
      artifactHash: hashB,
      audits: [],
    });
    expect(identity?.strategyId).toBe("pulse-momentum-v1");
    expect(strategyVersionStamp(identity)).toBe(
      `pulse-momentum-v1@1.0.0+src:${hashA}+art:${hashB}`,
    );
    expect(strategyVersionStamp(null, "2")).toBe("pulse:2");
  });

  it("two approved strategies yield different decisions on identical market input", () => {
    const momentum = planCycle(planInput("pulse-momentum-v1"));
    const fade = planCycle(planInput("mean-revert-fade-v1"));

    const momentumPulse = momentum.decisions.find((d) => d.agent === "PULSE");
    const fadePulse = fade.decisions.find((d) => d.agent === "PULSE");
    expect(momentumPulse?.decision).toBe("ACT");
    expect(momentumPulse?.output).toMatchObject({ side: "BUY", intent: "ENTRY" });
    expect(fadePulse?.decision).toBe("HOLD");
    expect(fade.orders.filter((o) => o.side === "BUY")).toHaveLength(0);
    expect(momentum.orders.some((o) => o.side === "BUY")).toBe(true);
  });
});
