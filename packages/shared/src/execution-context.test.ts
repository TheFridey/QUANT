import { describe, expect, it } from "vitest";
import { assertExecutionAccount, resolveExecutionContext } from "./execution-context.js";
import { DEFAULT_STRATEGY } from "./strategy.js";

describe("execution context (R03)", () => {
  it("resolves MARKET_DATA_PAPER to primary without fixture bleed", () => {
    const ctx = resolveExecutionContext({
      config: { ...DEFAULT_STRATEGY, tradingEnvironment: "MARKET_DATA_PAPER" },
      dataMode: "live",
    });
    expect(ctx.accountId).toBe("primary");
    expect(ctx.metricsAccountId).toBe("primary");
    expect(ctx.tradingEnvironment).toBe("MARKET_DATA_PAPER");
  });

  it("isolates FIXTURE and REPLAY into separate accounts", () => {
    const fixture = resolveExecutionContext({
      config: { ...DEFAULT_STRATEGY, tradingEnvironment: "FIXTURE" },
      dataMode: "live",
    });
    const replay = resolveExecutionContext({
      config: { ...DEFAULT_STRATEGY, tradingEnvironment: "REPLAY" },
      dataMode: "replay",
    });
    expect(fixture.accountId).toBe("primary:fixture");
    expect(replay.accountId).toBe("primary:replay");
    expect(fixture.accountId).not.toBe(replay.accountId);
    expect(assertExecutionAccount(fixture, "primary").ok).toBe(false);
    expect(assertExecutionAccount(fixture, "primary:fixture").ok).toBe(true);
  });
});
