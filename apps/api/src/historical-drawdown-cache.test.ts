import { normaliseHistoricalDrawdown, type HistoricalDrawdown } from "@odin/analytics";
import { describe, expect, it, vi } from "vitest";
import { HistoricalDrawdownCache, HISTORICAL_DRAWDOWN_CACHE_TTL_MS } from "./historical-drawdown.js";

function result(sampleCount: number): HistoricalDrawdown {
  return normaliseHistoricalDrawdown({ sampleCount } as never);
}

describe("HistoricalDrawdownCache", () => {
  it("serves repeat calls within the TTL from cache and reloads after it expires", async () => {
    let now = 1_000;
    const load = vi.fn(async () => result(load.mock.calls.length));
    const cache = new HistoricalDrawdownCache(load, 30_000, () => now);

    expect((await cache.get("primary")).sampleCount).toBe(1);
    now += 29_999;
    expect((await cache.get("primary")).sampleCount).toBe(1);
    expect(load).toHaveBeenCalledTimes(1);

    now += 1; // exactly TTL after the first load
    expect((await cache.get("primary")).sampleCount).toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keys entries by account", async () => {
    const load = vi.fn(async (accountId: string) => result(accountId === "a" ? 10 : 20));
    const cache = new HistoricalDrawdownCache(load, 30_000, () => 0);

    expect((await cache.get("a")).sampleCount).toBe(10);
    expect((await cache.get("b")).sampleCount).toBe(20);
    expect((await cache.get("a")).sampleCount).toBe(10);
    expect(load.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
  });

  it("shares one in-flight query between concurrent callers", async () => {
    const load = vi.fn(async () => result(5));
    const cache = new HistoricalDrawdownCache(load, 30_000, () => 0);

    await Promise.all([cache.get("primary"), cache.get("primary"), cache.get("primary")]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed query", async () => {
    const load = vi
      .fn<(accountId: string) => Promise<HistoricalDrawdown>>()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce(result(3));
    const cache = new HistoricalDrawdownCache(load, 30_000, () => 0);

    await expect(cache.get("primary")).rejects.toThrow("db down");
    expect((await cache.get("primary")).sampleCount).toBe(3);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("defaults to a 30 second TTL", () => {
    expect(HISTORICAL_DRAWDOWN_CACHE_TTL_MS).toBe(30_000);
  });
});
