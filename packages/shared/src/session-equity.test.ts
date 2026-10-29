import { describe, expect, it } from "vitest";
import {
  isUtcMidnightRollover,
  ratchetHighWaterMark,
  rollSessionEquity,
  startOfUtcDay,
} from "./session-equity.js";

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
    expect(rolled.dailyPnlUsd).toBe("0.00000000");
  });

  it("rolls at UTC midnight without lowering HWM and resets daily PnL", () => {
    const rolled = rollSessionEquity({
      now: new Date("2026-10-29T01:00:00.000Z"),
      sessionStartedAt: new Date("2026-10-28T00:00:00.000Z"),
      sessionStartEquityUsd: "10000.00000000",
      currentEquityUsd: "9800.00000000",
      highWaterMarkUsd: "10500.00000000",
      startingBalanceUsd: "10000.00000000",
    });
    expect(rolled.rolled).toBe(true);
    expect(rolled.sessionStartedAt.toISOString()).toBe("2026-10-29T00:00:00.000Z");
    expect(rolled.sessionStartEquityUsd).toBe("9800.00000000");
    expect(rolled.highWaterMarkUsd).toBe("10500.00000000");
    expect(rolled.dailyPnlUsd).toBe("0.00000000");
  });

  it("computes same-day daily PnL vs session start and does not roll before midnight", () => {
    const same = rollSessionEquity({
      now: new Date("2026-10-28T23:59:00.000Z"),
      sessionStartedAt: new Date("2026-10-28T00:00:00.000Z"),
      sessionStartEquityUsd: "10000.00000000",
      currentEquityUsd: "10250.00000000",
      highWaterMarkUsd: "10100.00000000",
      startingBalanceUsd: "10000.00000000",
    });
    expect(same.rolled).toBe(false);
    expect(same.dailyPnlUsd).toBe("250.00000000");
    expect(same.highWaterMarkUsd).toBe("10250.00000000");
  });

  it("detects UTC midnight boundary and ratchets HWM without lowering", () => {
    expect(startOfUtcDay(new Date("2026-10-28T15:30:00.000Z")).toISOString()).toBe(
      "2026-10-28T00:00:00.000Z",
    );
    expect(
      isUtcMidnightRollover(new Date("2026-10-28T23:00:00.000Z"), new Date("2026-10-29T00:00:01.000Z")),
    ).toBe(true);
    expect(ratchetHighWaterMark("100", "99")).toBe("100.00000000");
    expect(ratchetHighWaterMark("100", "101")).toBe("101.00000000");
  });
});
