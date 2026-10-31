import { describe, expect, it } from "vitest";
import {
  isUtcMidnightRollover,
  ratchetHighWaterMark,
  rollSessionEquity,
  startOfLondonDay,
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

  it("rolls the trading day at Europe/London midnight across both clock changes (audit L3)", () => {
    expect(startOfLondonDay(new Date("2026-07-01T12:00:00.000Z")).toISOString()).toBe("2026-06-30T23:00:00.000Z");
    expect(startOfLondonDay(new Date("2026-12-01T00:30:00.000Z")).toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(startOfLondonDay(new Date("2026-03-29T23:30:00.000Z")).toISOString()).toBe("2026-03-29T23:00:00.000Z");
    expect(startOfLondonDay(new Date("2026-10-25T23:30:00.000Z")).toISOString()).toBe("2026-10-24T23:00:00.000Z");
    // BST: 23:30 UTC is already the next London day, so the session rolls.
    const rolled = rollSessionEquity({
      now: new Date("2026-07-01T23:30:00.000Z"),
      sessionStartedAt: new Date("2026-06-30T23:00:00.000Z"),
      sessionStartEquityUsd: "10000",
      currentEquityUsd: "10100",
      highWaterMarkUsd: "10100",
      startingBalanceUsd: "10000",
    });
    expect(rolled.rolled).toBe(true);
    expect(rolled.sessionStartEquityUsd).toBe("10100.00000000");
    expect(rolled.sessionStartedAt.toISOString()).toBe("2026-07-01T23:00:00.000Z");
  });

  it("does not roll a new day onto starting balance while equity is unknown (review F6)", () => {
    const pending = rollSessionEquity({
      now: new Date("2026-12-02T09:00:00.000Z"),
      sessionStartedAt: new Date("2026-12-01T00:00:00.000Z"),
      sessionStartEquityUsd: "12000",
      currentEquityUsd: null,
      highWaterMarkUsd: "12000",
      startingBalanceUsd: "10000",
    });
    expect(pending.rolled).toBe(false);
    expect(pending.dailyPnlUsd).toBeNull();
    expect(pending.sessionStartEquityUsd).toBe("12000");
    const later = rollSessionEquity({
      now: new Date("2026-12-02T09:05:00.000Z"),
      sessionStartedAt: pending.sessionStartedAt,
      sessionStartEquityUsd: pending.sessionStartEquityUsd,
      currentEquityUsd: "11900",
      highWaterMarkUsd: pending.highWaterMarkUsd,
      startingBalanceUsd: "10000",
    });
    expect(later.rolled).toBe(true);
    expect(later.sessionStartEquityUsd).toBe("11900.00000000");
    expect(later.sessionStartedAt.toISOString()).toBe("2026-12-02T00:00:00.000Z");
  });
});
