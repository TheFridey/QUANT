import { describe, expect, it } from "vitest";
import { MemoryBackfillStore, runBackfill, type BackfillJobState } from "./backfill.js";
import { barsVisibleAt, coverageStats, datasetVersionHash, normaliseBars } from "./integrity.js";
import { AlpacaBarsSource, GeckoTerminalPoolSource, type HistoricalBarSource, type SourcePage } from "./sources.js";

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 1, 0, 0, 0);
const POOL = "7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm";

function raw(i: number, close = 1 + i / 100) {
  return { openTime: T0 + i * H, open: close, high: close * 1.01, low: close * 0.99, close, volume: 1000 };
}

describe("normaliseBars (point-in-time integrity)", () => {
  it("drops the in-progress bar and stamps availableAt at the close", () => {
    const r = normaliseBars([raw(0), raw(1)], { intervalMs: H, collectedAt: T0 + H + 10 });
    expect(r.bars).toHaveLength(1);
    expect(r.bars[0]!.availableAt).toBe(T0 + H);
    expect(r.rejected).toEqual([{ openTime: T0 + H, reason: "IN_PROGRESS" }]);
  });

  it("rejects inconsistent, non-positive and misaligned bars", () => {
    const r = normaliseBars(
      [
        { openTime: T0, open: 1, high: 0.9, low: 0.8, close: 1, volume: 1 },
        { openTime: T0 + H, open: 0, high: 1, low: 0, close: 1, volume: 1 },
        { openTime: T0 + 2 * H + 1, open: 1, high: 1, low: 1, close: 1, volume: 1 },
        { openTime: T0 + 3 * H, open: "NaN", high: 1, low: 1, close: 1, volume: 1 },
      ],
      { intervalMs: H, collectedAt: T0 + 100 * H },
    );
    expect(r.bars).toHaveLength(0);
    expect(r.rejected.map((x) => x.reason)).toEqual(["OHLC_INCONSISTENT", "NON_POSITIVE", "MISALIGNED", "NON_FINITE"]);
  });

  it("reports gaps without filling them, and keeps null volume null", () => {
    const r = normaliseBars([raw(0), { ...raw(3), volume: null }], { intervalMs: H, collectedAt: T0 + 100 * H });
    expect(r.bars).toHaveLength(2);
    expect(r.bars[1]!.volume).toBeNull();
    expect(r.gaps).toEqual([{ fromOpenTime: T0 + H, toOpenTime: T0 + 2 * H, missingBars: 2 }]);
  });

  it("drops identical duplicates but refuses conflicting ones", () => {
    const r = normaliseBars([raw(0), raw(0), raw(1), raw(1, 9)], { intervalMs: H, collectedAt: T0 + 100 * H });
    expect(r.duplicatesDropped).toBe(1);
    expect(r.bars.map((b) => b.openTime)).toEqual([T0]);
    expect(r.rejected).toEqual([{ openTime: T0 + H, reason: "DUPLICATE_CONFLICT" }]);
  });

  it("only exposes closed bars to a decision (no look-ahead)", () => {
    const { bars } = normaliseBars([raw(0), raw(1), raw(2)], { intervalMs: H, collectedAt: T0 + 100 * H });
    expect(barsVisibleAt(bars, T0 + 2 * H - 1).map((b) => b.openTime)).toEqual([T0]);
    expect(barsVisibleAt(bars, T0 + 2 * H).map((b) => b.openTime)).toEqual([T0, T0 + H]);
  });

  it("dataset version is order-independent and changes with any value", () => {
    const a = normaliseBars([raw(0), raw(1)], { intervalMs: H, collectedAt: T0 + 100 * H }).bars;
    const b = normaliseBars([raw(1), raw(0)], { intervalMs: H, collectedAt: T0 + 100 * H }).bars;
    const c = normaliseBars([raw(0), raw(1, 5)], { intervalMs: H, collectedAt: T0 + 100 * H }).bars;
    expect(datasetVersionHash(a)).toBe(datasetVersionHash(b));
    expect(datasetVersionHash(a)).not.toBe(datasetVersionHash(c));
  });

  it("accepts New York-midnight daily bars when the source declares that alignment, and only then", () => {
    // Alpaca daily bars open at 00:00 America/New_York: 04:00Z in summer (EDT), 05:00Z in winter (EST).
    const summer = { openTime: Date.UTC(2026, 6, 1, 4), open: 1, high: 1, low: 1, close: 1, volume: 1 };
    const winter = { openTime: Date.UTC(2026, 0, 5, 5), open: 1, high: 1, low: 1, close: 1, volume: 1 };
    const wrong = { openTime: Date.UTC(2026, 0, 6, 4), open: 1, high: 1, low: 1, close: 1, volume: 1 };
    const opts = { intervalMs: 86_400_000, collectedAt: Date.UTC(2027, 0, 1) };
    expect(normaliseBars([summer, winter], opts).rejected.map((r) => r.reason)).toEqual(["MISALIGNED", "MISALIGNED"]);
    const ny = normaliseBars([summer, winter, wrong], { ...opts, alignment: "NEW_YORK_DAY" });
    expect(ny.bars.map((b) => b.openTime)).toEqual([winter.openTime, summer.openTime]);
    expect(ny.rejected).toEqual([{ openTime: wrong.openTime, reason: "MISALIGNED" }]);
    // A bar is still only visible a full day after its open.
    expect(ny.bars[0]!.availableAt).toBe(winter.openTime + 86_400_000);
  });

  it("computes coverage", () => {
    const { bars } = normaliseBars([raw(0), raw(1), raw(4)], { intervalMs: H, collectedAt: T0 + 100 * H });
    expect(coverageStats(bars, H)).toMatchObject({ bars: 3, expectedBars: 5, gaps: 1, missingBars: 2 });
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("GeckoTerminalPoolSource (documented response shape)", () => {
  it("parses ohlcv_list, never asks for empty intervals, and pages backwards", async () => {
    const seen: string[] = [];
    const list = Array.from({ length: 1000 }, (_, i) => [(T0 + (1999 - i) * H) / 1000, 1, 1.1, 0.9, 1.05, 500]);
    const source = new GeckoTerminalPoolSource({
      fetchImpl: (async (url: URL) => {
        seen.push(url.toString());
        return jsonResponse({ data: { attributes: { ohlcv_list: list } } });
      }) as unknown as typeof fetch,
    });
    const page = await source.fetchPage({ instrumentKey: POOL, interval: "1h", startMs: T0, endMs: T0 + 2000 * H, cursor: null });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.bars).toHaveLength(1000);
    expect(page.nextCursor).toBe(String((T0 + 1000 * H) / 1000));
    expect(seen[0]).toContain("include_empty_intervals=false");
    expect(seen[0]).toContain(`/networks/solana/pools/${POOL}/ohlcv/hour`);
  });

  it("refuses a non-allowlisted base URL and a malformed pool", async () => {
    const bad = new GeckoTerminalPoolSource({ baseUrl: "https://evil.example/api/v2" });
    expect((await bad.fetchPage({ instrumentKey: POOL, interval: "1h", startMs: 0, endMs: 1, cursor: null })).ok).toBe(false);
    const ok = new GeckoTerminalPoolSource();
    const r = await ok.fetchPage({ instrumentKey: "not a pool", interval: "1h", startMs: 0, endMs: 1, cursor: null });
    expect(r.ok).toBe(false);
  });

  it("surfaces 429 as RATE_LIMITED with Retry-After", async () => {
    const source = new GeckoTerminalPoolSource({ fetchImpl: (async () => new Response("", { status: 429, headers: { "retry-after": "7" } })) as unknown as typeof fetch });
    const r = await source.fetchPage({ instrumentKey: POOL, interval: "1h", startMs: 0, endMs: 1, cursor: null });
    expect(r).toMatchObject({ ok: false, code: "RATE_LIMITED", retryAfterMs: 7000 });
  });
});

describe("AlpacaBarsSource", () => {
  it("is BLOCKED_EXTERNAL without credentials", async () => {
    const r = await new AlpacaBarsSource({ keyId: undefined, secret: undefined }).fetchPage({ instrumentKey: "SPY", interval: "1d", startMs: 0, endMs: 1, cursor: null });
    expect(r).toMatchObject({ ok: false, code: "MISSING_CREDENTIALS" });
  });

  it("requests raw (unadjusted) IEX bars and keeps secrets out of the request description", async () => {
    let headers: Record<string, string> = {};
    const source = new AlpacaBarsSource(
      { keyId: "kid", secret: "s3cret" },
      {
        fetchImpl: (async (_url: URL, init: RequestInit) => {
          headers = init.headers as Record<string, string>;
          return jsonResponse({ bars: { SPY: [{ t: "2026-10-01T04:00:00Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 100, n: 3, vw: 1.2 }] }, next_page_token: "abc" });
        }) as unknown as typeof fetch,
      },
    );
    const r = await source.fetchPage({ instrumentKey: "SPY", interval: "1d", startMs: T0, endMs: T0 + 10 * H, cursor: null });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.requestDescription).toContain("adjustment=raw");
    expect(r.requestDescription).toContain("feed=iex");
    expect(r.requestDescription).not.toContain("s3cret");
    expect(headers["APCA-API-SECRET-KEY"]).toBe("s3cret");
    expect(r.nextCursor).toBe("abc");
    expect(r.bars[0]!.extra).toEqual({ trades: 3, vwap: 1.2 });
  });
});

class ScriptedSource implements HistoricalBarSource {
  readonly id = "scripted";
  readonly licence = { provider: "test", terms: "test", attribution: null, redistribution: "NO" as const };
  readonly maxRequestsPerMinute = 600;
  calls = 0;
  constructor(private readonly pages: SourcePage[]) {}
  async fetchPage(): Promise<SourcePage> {
    const page = this.pages[Math.min(this.calls, this.pages.length - 1)]!;
    this.calls += 1;
    return page;
  }
}

function job(partial: Partial<BackfillJobState> = {}): BackfillJobState {
  return {
    id: "job1", datasetId: "ds1", sourceId: "scripted", instrumentKey: POOL, interval: "1h", windowStartMs: T0, windowEndMs: T0 + 10 * H,
    cursor: null, status: "PENDING", attempts: 0, rowsImported: 0, rowsRejected: 0, revisionsDetected: 0, lastError: null, ...partial,
  };
}

const page = (bars: ReturnType<typeof raw>[], nextCursor: string | null): SourcePage => ({ ok: true, bars, nextCursor, requestDescription: "test", payload: { bars } });
const noSleep = async () => {};
const fixedNow = () => T0 + 1000 * H;

describe("runBackfill", () => {
  it("checkpoints after each page and resumes from the cursor after an interruption", async () => {
    const store = new MemoryBackfillStore();
    const first = await runBackfill({ job: job(), source: new ScriptedSource([page([raw(5), raw(6)], "c1")]), store, options: { maxRequests: 1, now: fixedNow, sleep: noSleep } });
    expect(first.stoppedBy).toBe("REQUEST_BUDGET");
    expect(first.job).toMatchObject({ status: "PAUSED", cursor: "c1", rowsImported: 2 });
    const second = await runBackfill({ job: first.job, source: new ScriptedSource([page([raw(3), raw(4)], null)]), store, options: { maxRequests: 5, now: fixedNow, sleep: noSleep } });
    expect(second.job).toMatchObject({ status: "COMPLETED", rowsImported: 4 });
    expect(store.raw).toHaveLength(2);
  });

  it("is idempotent on re-import and records provider revisions instead of overwriting", async () => {
    const store = new MemoryBackfillStore();
    await runBackfill({ job: job(), source: new ScriptedSource([page([raw(1), raw(2)], null)]), store, options: { maxRequests: 2, now: fixedNow, sleep: noSleep } });
    const again = await runBackfill({ job: job({ id: "job2" }), source: new ScriptedSource([page([raw(1), raw(2, 9)], null)]), store, options: { maxRequests: 2, now: fixedNow, sleep: noSleep } });
    expect(again.job.rowsImported).toBe(0);
    expect(again.job.revisionsDetected).toBe(1);
    expect(store.bars.get("ds1")!.get(T0 + 2 * H)!.close).toBe("1.02");
  });

  it("retries transient errors with backoff and fails permanently on missing credentials", async () => {
    const sleeps: number[] = [];
    const store = new MemoryBackfillStore();
    const transient = await runBackfill({
      job: job(),
      source: new ScriptedSource([{ ok: false, code: "RATE_LIMITED", error: "429", retryAfterMs: 1234 }, page([raw(1)], null)]),
      store,
      options: { maxRequests: 5, now: fixedNow, sleep: async (ms) => void sleeps.push(ms) },
    });
    expect(transient.job.status).toBe("COMPLETED");
    expect(sleeps).toContain(1234);
    const blocked = await runBackfill({ job: job({ id: "job3" }), source: new ScriptedSource([{ ok: false, code: "MISSING_CREDENTIALS", error: "BLOCKED_EXTERNAL" }]), store, options: { maxRequests: 5, now: fixedNow, sleep: noSleep } });
    expect(blocked).toMatchObject({ stoppedBy: "FAILED", requests: 1 });
  });

  it("pauses cleanly when asked to stop and never runs a completed job", async () => {
    const store = new MemoryBackfillStore();
    const stopped = await runBackfill({ job: job(), source: new ScriptedSource([page([raw(1)], "c")]), store, options: { maxRequests: 5, now: fixedNow, sleep: noSleep, shouldStop: () => true } });
    expect(stopped).toMatchObject({ stoppedBy: "STOPPED", requests: 0 });
    const source = new ScriptedSource([page([raw(1)], null)]);
    await runBackfill({ job: job({ status: "COMPLETED" }), source, store, options: { maxRequests: 5 } });
    expect(source.calls).toBe(0);
  });
});
