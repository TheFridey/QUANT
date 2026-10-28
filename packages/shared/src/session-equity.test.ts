import { describe, expect, it } from "vitest";
import { rollSessionEquity } from "./session-equity.js";

describe("session equity / HWM midnight roll", () => {
  it("initializes session start and ratchets HWM", () => {
    const rolled = rollSessionEquity({
      now: new Date("2026-10-28T12:00:00.000Z"),
      sessionStartedAt: null,
      sessionStartEquityUsd: null,
      currentEquityUsd: "10100.00000000",
      highWaterMarkUsd: "10000.00000000",
      startingBalanceUsd: "10000.00000000",
    });
    expect(rolled.rolled).toBe(true);
    expect(rolled.sessionStartEquityUsd).toBe("10100.00000000");
    expect(rolled.highWaterMarkUsd).toBe("10100.00000000");
  });

  it("rolls at UTC midnight without lowering HWM", () => {
    const rolled = rollSessionEquity({
      now: new Date("2026-10-29T01:00:00.000Z"),
      sessionStartedAt: new Date("2026-10-28T00:00:00.000Z"),
      sessionStartEquityUsd: "10000.00000000",
      currentEquityUsd: "9800.00000000",
      highWaterMarkUsd: "10500.00000000",
      startingBalanceUsd: "10000.00000000",
    });
    expect(rolled.rolled).toBe(true);
    expect(rolled.sessionStartEquityUsd).toBe("9800.00000000");
    expect(rolled.highWaterMarkUsd).toBe("10500.00000000");
  });
});
