import { describe, expect, it } from "vitest";
import { classifyFreshness, worstDataState } from "./freshness.js";

const now = new Date("2026-10-26T16:00:00.000Z");

describe("freshness", () => {
  it("classifies live, delayed, and stale from receipt age", () => {
    expect(
      classifyFreshness({
        mode: "live",
        receivedAt: new Date(now.getTime() - 10_000),
        now,
        liveMaxAgeMs: 45_000,
        delayedMaxAgeMs: 180_000,
      }),
    ).toBe("LIVE");
    expect(
      classifyFreshness({
        mode: "live",
        receivedAt: new Date(now.getTime() - 60_000),
        now,
        liveMaxAgeMs: 45_000,
        delayedMaxAgeMs: 180_000,
      }),
    ).toBe("DELAYED");
    expect(
      classifyFreshness({
        mode: "live",
        receivedAt: new Date(now.getTime() - 200_000),
        now,
        liveMaxAgeMs: 45_000,
        delayedMaxAgeMs: 180_000,
      }),
    ).toBe("STALE");
  });

  it("does not call a future timestamp or a forced mode live", () => {
    expect(
      classifyFreshness({
        mode: "live",
        receivedAt: new Date(now.getTime() + 5_000),
        now,
        liveMaxAgeMs: 45_000,
        delayedMaxAgeMs: 180_000,
      }),
    ).toBe("STALE");
    expect(
      classifyFreshness({
        mode: "demo",
        receivedAt: now,
        now,
        liveMaxAgeMs: 45_000,
        delayedMaxAgeMs: 180_000,
      }),
    ).toBe("DEMO");
    expect(
      classifyFreshness({
        mode: "replay",
        receivedAt: now,
        now,
        liveMaxAgeMs: 45_000,
        delayedMaxAgeMs: 180_000,
      }),
    ).toBe("REPLAY");
  });

  it("picks the worst state and does not treat an empty set as live", () => {
    expect(worstDataState(["LIVE", "DELAYED", "STALE"])).toBe("STALE");
    expect(worstDataState([])).toBeNull();
  });
});
