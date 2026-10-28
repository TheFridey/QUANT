import { describe, expect, it } from "vitest";
import {
  accountIdForEnvironment,
  assertEnvironmentIsolation,
  DEFAULT_TRADING_ENVIRONMENT,
} from "./environments.js";

describe("trading environment isolation", () => {
  it("defaults to MARKET_DATA_PAPER", () => {
    expect(DEFAULT_TRADING_ENVIRONMENT).toBe("MARKET_DATA_PAPER");
    expect(accountIdForEnvironment("MARKET_DATA_PAPER")).toBe("primary");
    expect(accountIdForEnvironment("FIXTURE")).toBe("primary:fixture");
  });

  it("blocks fixture quotes into market-data paper accounts", () => {
    const blocked = assertEnvironmentIsolation("FIXTURE_SEQUENCE", "MARKET_DATA_PAPER");
    expect(blocked.ok).toBe(false);
    const ok = assertEnvironmentIsolation("FIXTURE_SEQUENCE", "FIXTURE");
    expect(ok.ok).toBe(true);
    const live = assertEnvironmentIsolation("LIVE_FEED", "MARKET_DATA_PAPER");
    expect(live.ok).toBe(true);
  });
});
