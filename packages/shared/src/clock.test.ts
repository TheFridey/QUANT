import { describe, expect, it } from "vitest";
import { eventTimeMs, fixedClock, steppedClock, systemClock } from "./clock.js";

describe("deterministic clock", () => {
  it("fixed clock returns constant instant", () => {
    const clock = fixedClock("2026-10-28T12:00:00.000Z");
    expect(clock.now().toISOString()).toBe("2026-10-28T12:00:00.000Z");
    expect(clock.nowMs()).toBe(Date.parse("2026-10-28T12:00:00.000Z"));
  });

  it("stepped clock advances only on advance()", () => {
    const clock = steppedClock("2026-10-28T12:00:00.000Z");
    expect(clock.nowMs()).toBe(Date.parse("2026-10-28T12:00:00.000Z"));
    clock.advance(5_000);
    expect(clock.now().toISOString()).toBe("2026-10-28T12:00:05.000Z");
    clock.set("2026-10-28T13:00:00.000Z");
    expect(clock.nowMs()).toBe(Date.parse("2026-10-28T13:00:00.000Z"));
  });

  it("systemClock is roughly wall time", () => {
    const before = Date.now();
    const mid = systemClock().nowMs();
    const after = Date.now();
    expect(mid).toBeGreaterThanOrEqual(before);
    expect(mid).toBeLessThanOrEqual(after);
  });

  it("eventTimeMs parses ISO", () => {
    expect(eventTimeMs("2026-10-28T12:00:00.000Z")).toBe(Date.parse("2026-10-28T12:00:00.000Z"));
    expect(eventTimeMs("not-a-date")).toBeNull();
  });
});
