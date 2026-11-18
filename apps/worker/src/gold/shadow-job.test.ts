import { describe, expect, it } from "vitest";
import { GoldShadowTicker, goldShadowEnabled, goldShadowPolicies } from "./shadow-job.js";

const NOW = new Date("2026-11-17T15:00:10.000Z");

function fakeStore() {
  const calls: string[] = [];
  return {
    calls,
    store: {
      startRun: async () => (calls.push("startRun"), { ok: true as const, runId: "run1" }),
      renewLease: async () => (calls.push("renew"), true),
      persist: async () => (calls.push("persist"), { status: "STORED" as const, quoteId: "q1" }),
      countPoll: async (_r: string, failure: boolean) => void calls.push(failure ? "poll:fail" : "poll"),
      recordRejection: async (_r: string, reason: string) => void calls.push(`reject:${reason}`),
      stopRun: async () => void calls.push("stop"),
    },
  };
}

const accepted = (raw: string | null) => ({
  status: "ACCEPTED" as const,
  quote: { providerTimeRaw: raw, receivedAt: NOW.toISOString(), bid: "2650.12", ask: "2650.43", providerTradeable: true, session: { status: "OPEN", reason: "x" }, quality: { admissible: true, reasons: [] } },
  simulated: { unavailable: "x" },
});

const ticker = (feedResult: unknown, store = fakeStore()) =>
  ({ t: new GoldShadowTicker({ poll: async () => feedResult as never }, store.store as never, { owner: "w", leaseMs: 60_000, policies: goldShadowPolicies({}), configHash: "c", now: () => NOW }), store });

describe("HELIOS gold shadow ingestion (default off, non-executable)", () => {
  it("is disabled unless AURUM_GOLD_SHADOW_ENABLED is exactly true", () => {
    expect(goldShadowEnabled({})).toBe(false);
    expect(goldShadowEnabled({ AURUM_GOLD_SHADOW_ENABLED: "1" })).toBe(false);
    expect(goldShadowEnabled({ AURUM_GOLD_SHADOW_ENABLED: "TRUE" })).toBe(false);
    expect(goldShadowEnabled({ AURUM_GOLD_SHADOW_ENABLED: "true" })).toBe(true);
  });

  it("defaults to 15 s buckets (5,760 a day) and bounds overrides to 5..60 s", () => {
    expect(goldShadowPolicies({})).toMatchObject({ bucketMs: 15_000, maxQuotesPerDay: 5_760 });
    expect(goldShadowPolicies({ AURUM_GOLD_SHADOW_BUCKET_MS: "5000" })).toMatchObject({ bucketMs: 5_000, maxQuotesPerDay: 17_280 });
    for (const bad of ["1000", "61000", "abc", "5000.5"]) expect(goldShadowPolicies({ AURUM_GOLD_SHADOW_BUCKET_MS: bad }).bucketMs).toBe(15_000);
    // A different sampling policy has a different hash, so its quotes never collide with another policy's buckets.
    expect(goldShadowPolicies({ AURUM_GOLD_SHADOW_BUCKET_MS: "5000" }).samplingPolicyHash).not.toBe(goldShadowPolicies({}).samplingPolicyHash);
  });

  it("persists an accepted quote with its verbatim provider time", async () => {
    const { t, store } = ticker(accepted("2026-11-17T15:00:01.123456789Z"));
    expect(await t.tick()).toEqual({ status: "POLLED", poll: "ACCEPTED", persisted: "STORED" });
    expect(store.calls).toEqual(["startRun", "poll", "persist"]);
  });

  it("refuses to store a quote without a verbatim provider time", async () => {
    const { t, store } = ticker(accepted(null));
    await t.tick();
    expect(store.calls).toContain("reject:NO_VERBATIM_PROVIDER_TIME");
    expect(store.calls).not.toContain("persist");
  });

  it("records provider failures, feed rejections and out-of-order quotes as bounded evidence, never as quotes", async () => {
    for (const [result, expected] of [
      [{ status: "PROVIDER_FAILURE", code: "TIMEOUT", error: "x", circuit: "CLOSED" }, ["poll:fail", "reject:PROVIDER_FAILURE:TIMEOUT"]],
      [{ status: "REJECTED", reason: "ONE_SIDED", snapshot: {} }, ["poll", "reject:FEED_REJECTED:ONE_SIDED"]],
      [{ status: "OUT_OF_ORDER", eventTime: "a", lastEventTime: "b" }, ["poll", "reject:OUT_OF_ORDER"]],
      [{ status: "CIRCUIT_OPEN", retryAt: null, reason: "x" }, ["poll"]],
      [{ status: "DUPLICATE", eventTime: "a" }, ["poll"]],
    ] as const) {
      const { t, store } = ticker(result);
      await t.tick();
      expect(store.calls.slice(1)).toEqual(expected);
    }
  });

  it("pauses until the next UTC day when the daily budget is exhausted, and drops a lost lease", async () => {
    const s = fakeStore();
    s.store.persist = async () => ({ status: "BUDGET_EXHAUSTED" }) as never;
    const { t } = ticker(accepted("2026-11-17T15:00:01Z"), s);
    expect((await t.tick()).status).toBe("POLLED");
    expect(await t.tick()).toEqual({ status: "BUDGET_PAUSED", until: "2026-11-18T00:00:00.000Z" });
    const l = fakeStore();
    l.store.startRun = async () => ({ ok: false, reason: "LEASE_HELD", runId: "other" }) as never;
    expect(await ticker(accepted("2026-11-17T15:00:01Z"), l).t.tick()).toEqual({ status: "NO_LEASE", reason: "LEASE_HELD" });
  });
});
