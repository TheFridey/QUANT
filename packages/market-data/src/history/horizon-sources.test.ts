import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MemoryBackfillStore, runBackfill, type BackfillJobState } from "./backfill.js";
import { nyseSessionPhase } from "./calendar.js";
import { normaliseBars } from "./integrity.js";
import { alignmentFor, gapSemanticsFor } from "./quality.js";
import { AlpacaBarsSource, OandaCandlesSource, retryAfterMs } from "./sources.js";

const here = dirname(fileURLToPath(import.meta.url));
const candlesFixture = JSON.parse(readFileSync(resolve(here, "../../fixtures/oanda-practice/candles-eurusd-m5-mba.json"), "utf8")) as { candles: unknown[] };
const M5 = 300_000;

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("nyseSessionPhase", () => {
  it("tags pre-market, regular, post-market and closed times in New York (EST and EDT)", () => {
    // 4 Nov 2026 is EST (UTC-5): RTH 14:30-21:00Z.
    expect(nyseSessionPhase(Date.parse("2026-11-04T09:00:00Z"))).toBe("PRE");
    expect(nyseSessionPhase(Date.parse("2026-11-04T14:30:00Z"))).toBe("RTH");
    expect(nyseSessionPhase(Date.parse("2026-11-04T20:59:00Z"))).toBe("RTH");
    expect(nyseSessionPhase(Date.parse("2026-11-04T21:00:00Z"))).toBe("POST");
    expect(nyseSessionPhase(Date.parse("2026-11-05T01:30:00Z"))).toBe("CLOSED");
    // 1 Jul 2026 is EDT (UTC-4): RTH 13:30-20:00Z.
    expect(nyseSessionPhase(Date.parse("2026-07-01T13:29:00Z"))).toBe("PRE");
    expect(nyseSessionPhase(Date.parse("2026-07-01T13:30:00Z"))).toBe("RTH");
    // Weekend and Thanksgiving are closed; the day after Thanksgiving closes early at 13:00 ET.
    expect(nyseSessionPhase(Date.parse("2026-11-07T15:00:00Z"))).toBe("CLOSED");
    expect(nyseSessionPhase(Date.parse("2026-11-26T15:00:00Z"))).toBe("CLOSED");
    expect(nyseSessionPhase(Date.parse("2026-11-27T18:30:00Z"))).toBe("POST");
  });
});

describe("AlpacaBarsSource (HORIZON extensions)", () => {
  it("records the feed and New York session phase on intraday bars and names the dataset by feed", async () => {
    let requested: URL | null = null;
    const source = new AlpacaBarsSource(
      { keyId: "kid", secret: "s3cret" },
      {
        feed: "delayed_sip",
        fetchImpl: (async (url: URL) => {
          requested = url;
          return jsonResponse({ bars: { SPY: [{ t: "2026-11-04T14:30:00Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 100, n: 3, vw: 1.2 }, { t: "2026-11-04T13:00:00Z", o: 1, h: 1, l: 1, c: 1, v: 1 }] }, next_page_token: null });
        }) as unknown as typeof fetch,
      },
    );
    expect(source.id).toBe("alpaca_delayed_sip");
    const page = await source.fetchPage({ instrumentKey: "SPY", interval: "5m", startMs: 0, endMs: Date.parse("2026-11-05T00:00:00Z"), cursor: null });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(requested!.searchParams.get("feed")).toBe("delayed_sip");
    expect(page.bars[0]!.extra).toEqual({ trades: 3, vwap: 1.2, feed: "delayed_sip", nySession: "RTH" });
    expect(page.bars[1]!.extra).toMatchObject({ nySession: "PRE" });
    expect(new AlpacaBarsSource({ keyId: "k", secret: "s" }).id).toBe("alpaca_iex");
  });

  it("availableAt is the bar close for intraday ETF bars", () => {
    const r = normaliseBars([{ openTime: Date.parse("2026-11-04T14:30:00Z"), open: 1, high: 1, low: 1, close: 1, volume: 1 }], { intervalMs: M5, collectedAt: Date.parse("2026-11-04T15:00:00Z") });
    expect(r.bars[0]!.availableAt).toBe(Date.parse("2026-11-04T14:35:00Z"));
  });

  it("uses Retry-After or X-RateLimit-Reset for 429 back-off", () => {
    expect(retryAfterMs(new Headers({ "retry-after": "3" }), 0)).toBe(3000);
    expect(retryAfterMs(new Headers({ "x-ratelimit-reset": "100" }), 95_000)).toBe(5000);
    expect(retryAfterMs(new Headers(), 0)).toBe(60_000);
  });
});

describe("quality conventions for the new sources", () => {
  it("treats every Alpaca feed alike and OANDA as omitting empty intervals on a UTC grid", () => {
    expect(alignmentFor("alpaca_delayed_sip", "1d")).toBe("NEW_YORK_DAY");
    expect(gapSemanticsFor("alpaca_delayed_sip", "5m")).toBe("EMPTY_INTERVALS_OMITTED");
    expect(alignmentFor("oanda_practice", "1d")).toBe("UTC_GRID");
    expect(gapSemanticsFor("oanda_practice", "1h")).toBe("EMPTY_INTERVALS_OMITTED");
  });
});

describe("OandaCandlesSource", () => {
  const start = Date.parse("2026-11-04T14:40:00Z");
  const end = Date.parse("2026-11-05T00:00:00Z");

  it("refuses without a token and on a non-practice host", async () => {
    expect(await new OandaCandlesSource({ token: undefined }).fetchPage({ instrumentKey: "EUR_USD", interval: "5m", startMs: start, endMs: end, cursor: null })).toMatchObject({ ok: false, code: "MISSING_CREDENTIALS" });
    expect(await new OandaCandlesSource({ token: "t", apiUrl: "https://api-fxtrade.oanda.com" }).fetchPage({ instrumentKey: "EUR_USD", interval: "5m", startMs: start, endMs: end, cursor: null })).toMatchObject({ ok: false, code: "INVALID_CONFIGURATION" });
  });

  it("stores mid OHLC, keeps bid/ask in extra, drops the in-progress candle and never fakes volume", async () => {
    let requested: URL | null = null;
    const source = new OandaCandlesSource(
      { token: "secret-token" },
      {
        fetchImpl: (async (url: URL) => {
          requested = url;
          return jsonResponse(candlesFixture);
        }) as unknown as typeof fetch,
      },
    );
    const page = await source.fetchPage({ instrumentKey: "EUR_USD", interval: "5m", startMs: start, endMs: end, cursor: null });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(requested!.searchParams.get("price")).toBe("MBA");
    expect(page.requestDescription).not.toContain("secret-token");
    expect(page.bars).toHaveLength(3);
    expect(page.bars[0]).toMatchObject({ openTime: start, open: "1.08157", close: "1.08187", volume: null });
    expect(page.bars[0]!.extra).toMatchObject({ bid_c: "1.08180", ask_c: "1.08194", spread_c: "0.00014", tickVolume: 132, priceComponents: "MBA" });
    // Short page plus an in-progress candle: the walk is done.
    expect(page.nextCursor).toBeNull();
  });

  it("backfills into the warehouse with availableAt at candle close", async () => {
    const source = new OandaCandlesSource({ token: "t" }, { fetchImpl: (async () => jsonResponse(candlesFixture)) as unknown as typeof fetch });
    const store = new MemoryBackfillStore();
    const job: BackfillJobState = {
      id: "job-1",
      datasetId: "ds-1",
      sourceId: "oanda_practice",
      instrumentKey: "EUR_USD",
      interval: "5m",
      windowStartMs: start,
      windowEndMs: end,
      cursor: null,
      status: "PENDING",
      attempts: 0,
      rowsImported: 0,
      rowsRejected: 0,
      revisionsDetected: 0,
      lastError: null,
    };
    const result = await runBackfill({ job, source, store, options: { maxRequests: 3, now: () => Date.parse("2026-11-04T15:01:00Z"), sleep: async () => undefined } });
    expect(result.stoppedBy).toBe("COMPLETED");
    const bars = [...store.bars.get("ds-1")!.values()];
    expect(bars.map((b) => b.availableAt)).toEqual([start + M5, start + 2 * M5, start + 3 * M5]);
  });

  it("pages forward from the last candle when a page is full", async () => {
    const full = { candles: Array.from({ length: 5000 }, (_, i) => ({ complete: true, volume: 1, time: new Date(start + i * M5).toISOString(), mid: { o: "1", h: "1", l: "1", c: "1" } })) };
    const source = new OandaCandlesSource({ token: "t" }, { fetchImpl: (async () => jsonResponse(full)) as unknown as typeof fetch });
    const page = await source.fetchPage({ instrumentKey: "EUR_USD", interval: "5m", startMs: start, endMs: start + 10_000 * M5, cursor: null });
    expect(page.ok && page.nextCursor).toBe(String(start + 5000 * M5));
  });
});
