import { describe, expect, it } from "vitest";
import { DEFAULT_GOLD_SHADOW_CONFIG, GoldShadowFeed, failureKindFor, validateGoldShadowConfig, type GoldShadowConfig, type PricingFetcher } from "./gold-shadow-feed.js";
import { parseOandaPricing, type OandaPriceSnapshot, type OandaResult } from "./providers/oanda-practice.js";

const OPEN = new Date("2026-11-17T15:00:00.000Z"); // Tuesday 10:00 New York: metals session open
const SATURDAY = new Date("2026-11-21T15:00:00.000Z");
const ON: GoldShadowConfig = { ...DEFAULT_GOLD_SHADOW_CONFIG, enabled: true };

function oanda(now: Date, over: { time?: string | null; bid?: string; ask?: string; tradeable?: boolean } = {}): OandaResult<OandaPriceSnapshot[]> {
  const row: Record<string, unknown> = {
    instrument: "XAU_USD",
    time: over.time === undefined ? new Date(now.getTime() - 300).toISOString().replace("Z", "000000Z") : over.time,
    bids: [{ price: over.bid ?? "2650.120", liquidity: 1000 }],
    asks: [{ price: over.ask ?? "2650.430", liquidity: 1000 }],
    closeoutBid: "2650.000",
    closeoutAsk: "2650.550",
    tradeable: over.tradeable ?? true,
  };
  if (over.time === null) delete row.time;
  return { ok: true, data: parseOandaPricing({ prices: [row] }, now)!, fetchedAt: now.toISOString() };
}

function harness(config: GoldShadowConfig = ON, start = OPEN) {
  let now = start;
  const calls: string[][] = [];
  let next: (n: Date) => Promise<OandaResult<OandaPriceSnapshot[]>> = async (n) => oanda(n);
  const pricing: PricingFetcher = async (instruments) => {
    calls.push([...instruments]);
    return next(now);
  };
  const feed = new GoldShadowFeed(config, { pricing, now: () => now });
  return {
    feed,
    calls,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
    respond: (fn: (n: Date) => Promise<OandaResult<OandaPriceSnapshot[]>>) => (next = fn),
  };
}

describe("AURUM gold shadow feed (default off, never executable)", () => {
  it("is off by default and makes no request", async () => {
    const h = harness(DEFAULT_GOLD_SHADOW_CONFIG);
    expect(DEFAULT_GOLD_SHADOW_CONFIG.enabled).toBe(false);
    expect(await h.feed.poll()).toEqual({ status: "DISABLED" });
    expect(h.calls).toEqual([]);
  });

  it("keeps the actual bid and ask, event and receive times, and honest provenance", async () => {
    const h = harness();
    const r = await h.feed.poll();
    expect(h.calls).toEqual([["XAU_USD"]]);
    if (r.status !== "ACCEPTED") throw new Error(r.status);
    expect(r.quote).toMatchObject({
      kind: "REFERENCE_MARKET_QUOTE",
      executable: false,
      instrumentId: "commodity:XAUUSD",
      bid: "2650.120",
      ask: "2650.430",
      eventTime: "2026-11-17T14:59:59.700Z",
      receivedAt: OPEN.toISOString(),
      providerTradeable: true,
      provenance: { provider: "oanda_practice", environment: "PRACTICE", coverage: "DEALER_INDICATIVE", timeliness: "REAL_TIME" },
      session: { status: "OPEN" },
      quality: { admissible: true, reasons: [] },
    });
    expect(r.quote.spreadBps).toBeCloseTo(1.1697, 3);
    // The simulated spread-bet quote is derived, labelled and also not executable; it never narrows the reference.
    if ("unavailable" in r.simulated) throw new Error(r.simulated.unavailable);
    expect(r.simulated).toMatchObject({ kind: "SIMULATED_SPREAD_BET_QUOTE", executable: false, derivedFromQuoteId: r.quote.quoteId });
    expect(Number(r.simulated.bid)).toBeLessThanOrEqual(2650.12);
    expect(Number(r.simulated.ask)).toBeGreaterThanOrEqual(2650.43);
  });

  it("flags a spread above the mandatory cap, a stale quote, an untradeable instrument and a closed session", async () => {
    const wide = harness();
    wide.respond(async (n) => oanda(n, { bid: "2640.00", ask: "2660.00" }));
    const w = await wide.feed.poll();
    expect(w.status === "ACCEPTED" && w.quote.quality.reasons).toEqual(["SPREAD_ABOVE_CAP"]);

    const stale = harness();
    stale.respond(async (n) => oanda(n, { time: new Date(n.getTime() - 60_000).toISOString() }));
    const s = await stale.feed.poll();
    expect(s.status === "ACCEPTED" && s.quote.quality.reasons).toEqual(["QUOTE_STALE"]);

    const halted = harness();
    halted.respond(async (n) => oanda(n, { tradeable: false }));
    const t = await halted.feed.poll();
    expect(t.status === "ACCEPTED" && t.quote.quality.reasons).toEqual(["PROVIDER_NOT_TRADEABLE"]);

    const weekend = harness(ON, SATURDAY);
    const k = await weekend.feed.poll();
    expect(k.status === "ACCEPTED" && k.quote.quality.reasons).toContain("SESSION_NOT_OPEN");
    expect(weekend.feed.status().counters.qualityFailures).toBe(1);
  });

  it("refuses an invalid configuration, including a missing spread cap", async () => {
    expect(validateGoldShadowConfig({ ...ON, maxSpreadBps: 0 })).toEqual({ ok: false, reason: "INVALID_SPREAD_CAP" });
    expect(validateGoldShadowConfig({ ...ON, maxSpreadBps: undefined as never })).toEqual({ ok: false, reason: "INVALID_SPREAD_CAP" });
    expect(validateGoldShadowConfig({ ...ON, maxQuoteAgeMs: Number.POSITIVE_INFINITY }).ok).toBe(false);
    expect(validateGoldShadowConfig({ ...ON, minPollIntervalMs: 10 }).ok).toBe(false);
    expect(validateGoldShadowConfig({ ...ON, enabled: "yes" as never }).ok).toBe(false);
    const h = harness({ ...ON, maxSpreadBps: Number.NaN });
    expect(await h.feed.poll()).toEqual({ status: "INVALID_CONFIG", reason: "INVALID_SPREAD_CAP" });
    expect(h.calls).toEqual([]);
  });

  it("drops duplicates and out-of-order quotes; the newest quote always wins", async () => {
    const h = harness();
    const fixed = "2026-11-17T14:59:59.700000000Z";
    h.respond(async (n) => oanda(n, { time: fixed }));
    expect((await h.feed.poll()).status).toBe("ACCEPTED");
    h.advance(5_000);
    expect(await h.feed.poll()).toMatchObject({ status: "DUPLICATE" });
    h.advance(5_000);
    h.respond(async (n) => oanda(n, { time: "2026-11-17T14:59:58.000000000Z" }));
    expect(await h.feed.poll()).toMatchObject({ status: "OUT_OF_ORDER", lastEventTime: "2026-11-17T14:59:59.700Z" });
    h.advance(5_000);
    // Same event time, different price: a revision cannot replace the stored quote.
    h.respond(async (n) => oanda(n, { time: fixed, bid: "2651.00", ask: "2651.30" }));
    expect(await h.feed.poll()).toMatchObject({ status: "OUT_OF_ORDER" });
    expect(h.feed.quotes()).toHaveLength(1);
    expect(h.feed.status().counters).toMatchObject({ accepted: 1, duplicates: 1, outOfOrder: 2 });
  });

  it("rejects quotes with no event time or one side missing", async () => {
    const h = harness();
    h.respond(async (n) => oanda(n, { time: null }));
    expect(await h.feed.poll()).toMatchObject({ status: "REJECTED", reason: "MISSING_EVENT_TIME" });
    h.advance(5_000);
    h.respond(async (n) => {
      const r = oanda(n);
      if (r.ok) r.data[0] = { ...r.data[0]!, ask: null };
      return r;
    });
    expect(await h.feed.poll()).toMatchObject({ status: "REJECTED", reason: "ONE_SIDED" });
    expect(h.feed.quotes()).toHaveLength(0);
  });

  it("is bounded: one request in flight, a minimum interval, and a capped buffer", async () => {
    const h = harness({ ...ON, bufferSize: 3 });
    let release!: () => void;
    h.respond((n) => new Promise((res) => (release = () => res(oanda(n)))));
    const first = h.feed.poll();
    expect(await h.feed.poll()).toMatchObject({ status: "THROTTLED" });
    release();
    expect((await first).status).toBe("ACCEPTED");
    expect(await h.feed.poll()).toMatchObject({ status: "THROTTLED" });
    expect(h.calls).toHaveLength(1);
    h.respond(async (n) => oanda(n, { time: new Date(n.getTime() - 100).toISOString() }));
    for (let i = 0; i < 5; i++) {
      h.advance(5_000);
      expect((await h.feed.poll()).status).toBe("ACCEPTED");
    }
    expect(h.feed.quotes()).toHaveLength(3);
  });

  it("opens the circuit on provider failures, backs off without requests, and recovers through one probe", async () => {
    const h = harness();
    h.respond(async () => ({ ok: false, code: "HTTP_ERROR", error: "503" }));
    for (let i = 0; i < 3; i++) {
      expect(await h.feed.poll()).toMatchObject({ status: "PROVIDER_FAILURE", code: "HTTP_ERROR" });
      h.advance(5_000);
    }
    expect(h.feed.status().circuit.state).toBe("OPEN");
    const calls = h.calls.length;
    expect(await h.feed.poll()).toMatchObject({ status: "CIRCUIT_OPEN" });
    expect(h.calls.length).toBe(calls);
    h.advance(DEFAULT_GOLD_SHADOW_CONFIG.circuit.maxBackoffMs);
    h.respond(async (n) => oanda(n));
    expect((await h.feed.poll()).status).toBe("ACCEPTED");
    expect(h.feed.status().circuit.state).toBe("CLOSED");
  });

  it("an auth failure opens at once; a throwing fetcher never escapes", async () => {
    const h = harness();
    h.respond(async () => ({ ok: false, code: "AUTH_FAILED", error: "401" }));
    await h.feed.poll();
    expect(h.feed.status().circuit.state).toBe("OPEN");
    const t = harness();
    t.respond(async () => {
      throw new Error("socket hang up");
    });
    expect(await t.feed.poll()).toMatchObject({ status: "PROVIDER_FAILURE", code: "THREW" });
    t.advance(5_000);
    t.respond(async (n) => oanda(n));
    expect((await t.feed.poll()).status).toBe("ACCEPTED");
    expect(failureKindFor("MISSING_CREDENTIALS")).toBe("INVALID_CONFIGURATION");
    expect(failureKindFor("NO_QUOTE")).toBe("BAD_PAYLOAD");
  });

  it("status reports quote age at the time asked, not at receipt", async () => {
    const h = harness();
    await h.feed.poll();
    h.advance(10_000);
    const s = h.feed.status();
    expect(s.quoteAgeMs).toBe(10_300);
    expect(s.receiveAgeMs).toBe(10_000);
    expect(s.latest?.executable).toBe(false);
  });
});
