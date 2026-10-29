import { describe, expect, it } from "vitest";
import {
  accountIdForEnvironment,
  assertEnvironmentIsolation,
  DEFAULT_TRADING_ENVIRONMENT,
  metricsAccountIdFor,
  metricsAccountMatches,
} from "./environments.js";

describe("trading environment isolation", () => {
  it("defaults to MARKET_DATA_PAPER", () => {
    expect(DEFAULT_TRADING_ENVIRONMENT).toBe("MARKET_DATA_PAPER");
    expect(accountIdForEnvironment("MARKET_DATA_PAPER")).toBe("primary");
    expect(accountIdForEnvironment("FIXTURE")).toBe("primary:fixture");
    expect(accountIdForEnvironment("REPLAY")).toBe("primary:replay");
  });

  it("blocks fixture quotes into market-data paper accounts", () => {
    const blocked = assertEnvironmentIsolation("FIXTURE_SEQUENCE", "MARKET_DATA_PAPER");
    expect(blocked.ok).toBe(false);
    const ok = assertEnvironmentIsolation("FIXTURE_SEQUENCE", "FIXTURE");
    expect(ok.ok).toBe(true);
    const live = assertEnvironmentIsolation("LIVE_FEED", "MARKET_DATA_PAPER");
    expect(live.ok).toBe(true);
  });

  it("isolates REPLAY metrics/funnel/report account from paper primary", () => {
    expect(metricsAccountIdFor("REPLAY")).toBe("primary:replay");
    expect(metricsAccountIdFor("MARKET_DATA_PAPER")).toBe("primary");
    expect(metricsAccountMatches("primary", "MARKET_DATA_PAPER")).toBe(true);
    expect(metricsAccountMatches("primary", "REPLAY")).toBe(false);
    expect(metricsAccountMatches("primary:replay", "REPLAY")).toBe(true);
    expect(metricsAccountMatches("primary:replay", "MARKET_DATA_PAPER")).toBe(false);
    const blockedReplay = assertEnvironmentIsolation("REPLAY_STORE", "MARKET_DATA_PAPER");
    expect(blockedReplay.ok).toBe(false);
  });
});
