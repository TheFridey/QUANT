import { describe, expect, it } from "vitest";
import {
  buildPositionKey,
  instrumentIdFromPositionKey,
  parsePositionKey,
  positionKeysEqual,
} from "./position-key.js";

describe("position-key (D06 / D21)", () => {
  it("decodes primary:fixture:etf:SPY with known accountId (no first-colon split)", () => {
    const accountId = "primary:fixture";
    const instrumentId = "etf:SPY";
    const key = buildPositionKey(accountId, instrumentId);
    expect(key).toBe("primary:fixture:etf:SPY");
    expect(instrumentIdFromPositionKey(key, accountId)).toBe("etf:SPY");
    expect(parsePositionKey(key, accountId)).toEqual({
      accountId: "primary:fixture",
      instrumentId: "etf:SPY",
    });
    // First-colon split would wrongly treat account as "primary" and instrument as "fixture:etf:SPY".
    expect(instrumentIdFromPositionKey(key, "primary")).toBeNull();
    expect(parsePositionKey(key, "primary")).toBeNull();
  });

  it("requires exact key equality", () => {
    expect(positionKeysEqual("primary:fixture:etf:SPY", "primary:fixture:etf:SPY")).toBe(true);
    expect(positionKeysEqual("primary:fixture:etf:SPY", "primary:etf:SPY")).toBe(false);
  });
});
