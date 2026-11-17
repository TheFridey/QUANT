import { describe, expect, it } from "vitest";
import { assessQuoteAdmission, QUOTE_ADMISSION_REASONS, type QuoteAdmissionInput } from "./quote-admission.js";
import { describeQuoteQuality, QUOTE_FEEDS, type QuoteFeed } from "./quote-quality.js";
import type { SessionStatus } from "./sessions.js";

const NOW = new Date("2026-11-17T10:27:10.000Z");

function input(overrides: Partial<QuoteAdmissionInput> & { feed?: QuoteFeed; eventTime?: string | null; tradeable?: boolean | null } = {}): QuoteAdmissionInput {
  const bid = "bid" in overrides ? (overrides.bid ?? null) : "1.09911";
  const ask = "ask" in overrides ? (overrides.ask ?? null) : "1.09919";
  const quality =
    overrides.quality ??
    describeQuoteQuality({
      source: "oanda_practice",
      feed: overrides.feed ?? "OANDA_PRACTICE",
      now: NOW,
      eventTime: overrides.eventTime === undefined ? "2026-11-17T10:27:08.252Z" : overrides.eventTime,
      bid,
      ask,
      providerTradeable: overrides.tradeable === undefined ? true : overrides.tradeable,
    });
  return {
    quality,
    dataState: overrides.dataState ?? "DEMO",
    bid,
    ask,
    receivedAt: overrides.receivedAt ?? new Date("2026-11-17T10:27:08.900Z"),
    now: overrides.now ?? NOW,
    maxAgeMs: overrides.maxAgeMs ?? 45_000,
    session: overrides.session ?? "OPEN",
    instrumentEnabled: overrides.instrumentEnabled ?? true,
    maxSpreadBps: overrides.maxSpreadBps,
    clockSkewToleranceMs: overrides.clockSkewToleranceMs,
  };
}

describe("assessQuoteAdmission (PCR-2 C1/C5, unwired)", () => {
  it("admits a fresh, two-sided, tradeable OANDA practice quote in an open session for an enabled instrument", () => {
    const result = assessQuoteAdmission(input());
    expect(result).toMatchObject({ admissible: true, reasons: [] });
    expect(result.eventAgeMs).toBe(1748);
  });

  it("is off by default: an instrument that is not enabled is never admissible", () => {
    expect(assessQuoteAdmission(input({ instrumentEnabled: false })).reasons).toEqual(["INSTRUMENT_NOT_ENABLED"]);
  });

  it("never admits an ECB/Frankfurter reference rate, even fresh, two-sided and enabled", () => {
    const result = assessQuoteAdmission(input({ feed: "ECB_REFERENCE" }));
    expect(result.admissible).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining(["REFERENCE_RATE", "NOT_REAL_TIME", "COVERAGE_NOT_EXECUTABLE"]));
  });

  it("no feed other than the three executable coverages is ever admissible (exhaustive over feeds)", () => {
    const admissibleFeeds = QUOTE_FEEDS.filter((feed) => assessQuoteAdmission(input({ feed })).admissible);
    // DEXSCREENER is AGGREGATED_DEX: crypto keeps its own existing path and never qualifies through this one.
    expect(admissibleFeeds.sort()).toEqual(["ALPACA_IEX", "ALPACA_SIP", "OANDA_PRACTICE"]);
  });

  it("rejects delayed SIP, recorded fixtures and unknown feeds", () => {
    expect(assessQuoteAdmission(input({ feed: "ALPACA_DELAYED_SIP" })).reasons).toContain("NOT_REAL_TIME");
    expect(assessQuoteAdmission(input({ feed: "OFFLINE_FIXTURE" })).reasons).toEqual(
      expect.arrayContaining(["NOT_REAL_TIME", "COVERAGE_NOT_EXECUTABLE"]),
    );
    expect(assessQuoteAdmission(input({ feed: "ALPACA_ACCOUNT_DEFAULT" })).admissible).toBe(false);
  });

  it("rejects one-sided, zero and non-numeric quotes", () => {
    expect(assessQuoteAdmission(input({ ask: null })).reasons).toContain("ONE_SIDED_QUOTE");
    expect(assessQuoteAdmission(input({ bid: "0", ask: "1.1" })).reasons).toContain("ONE_SIDED_QUOTE");
    expect(assessQuoteAdmission(input({ bid: "abc", ask: "1.1" })).reasons).toContain("ONE_SIDED_QUOTE");
  });

  it("rejects crossed and locked books", () => {
    const quality = describeQuoteQuality({ source: "x", feed: "OANDA_PRACTICE", now: NOW, eventTime: NOW.toISOString(), bid: "1.1", ask: "1.1" });
    expect(assessQuoteAdmission(input({ quality, bid: "1.1", ask: "1.1" })).reasons).toContain("CROSSED_OR_LOCKED_QUOTE");
    // A descriptor that claims two-sided cannot override crossed raw prices.
    const claimed = { ...describeQuoteQuality({ source: "x", feed: "OANDA_PRACTICE", now: NOW, eventTime: NOW.toISOString(), bid: "1.0", ask: "1.1" }) };
    expect(assessQuoteAdmission(input({ quality: claimed, bid: "1.2", ask: "1.1" })).reasons).toContain("CROSSED_OR_LOCKED_QUOTE");
  });

  it("measures event age at decision time, with the boundary at exactly maxAgeMs admitted and +1 ms rejected", () => {
    const eventTime = new Date(NOW.getTime() - 45_000).toISOString();
    const receivedAt = new Date(NOW.getTime() - 45_000);
    expect(assessQuoteAdmission(input({ eventTime, receivedAt })).admissible).toBe(true);
    const later = new Date(NOW.getTime() + 1);
    expect(assessQuoteAdmission(input({ eventTime, receivedAt, now: later })).reasons).toEqual(["QUOTE_STALE", "RECEIVE_STALE"]);
  });

  it("rejects a quote that was fresh when received but has since aged (overnight IEX book)", () => {
    const quality = describeQuoteQuality({
      source: "alpaca_paper",
      feed: "ALPACA_IEX",
      now: NOW,
      eventTime: "2026-11-16T21:00:00.032Z",
      bid: "719.7",
      ask: "764.77",
    });
    const result = assessQuoteAdmission(input({ quality, bid: "719.7", ask: "764.77", receivedAt: NOW, session: "CLOSED", maxSpreadBps: 25 }));
    expect(result.reasons).toEqual(["QUOTE_STALE", "SESSION_NOT_OPEN", "SPREAD_ABOVE_CAP"]);
  });

  it("rejects missing and future event times, and future receive times, beyond the clock tolerance", () => {
    expect(assessQuoteAdmission(input({ eventTime: null })).reasons).toContain("MISSING_EVENT_TIME");
    const ahead = new Date(NOW.getTime() + 500).toISOString();
    expect(assessQuoteAdmission(input({ eventTime: ahead })).reasons).toContain("FUTURE_EVENT_TIME");
    expect(assessQuoteAdmission(input({ eventTime: ahead, clockSkewToleranceMs: 500 })).admissible).toBe(true);
    // Tolerance is capped at 1 s.
    const farAhead = new Date(NOW.getTime() + 5_000).toISOString();
    expect(assessQuoteAdmission(input({ eventTime: farAhead, clockSkewToleranceMs: 60_000 })).reasons).toContain("FUTURE_EVENT_TIME");
    expect(assessQuoteAdmission(input({ receivedAt: new Date(NOW.getTime() + 2_000) })).reasons).toContain("FUTURE_RECEIVE_TIME");
    expect(assessQuoteAdmission(input({ receivedAt: new Date(Number.NaN) })).reasons).toContain("RECEIVE_STALE");
  });

  it("honours the provider tradeable flag only when it is explicitly false", () => {
    expect(assessQuoteAdmission(input({ tradeable: false })).reasons).toEqual(["PROVIDER_NOT_TRADEABLE"]);
    expect(assessQuoteAdmission(input({ tradeable: null })).admissible).toBe(true);
  });

  it.each<SessionStatus>(["CLOSED", "UNKNOWN"])("rejects a %s session", (session) => {
    expect(assessQuoteAdmission(input({ session })).reasons).toEqual(["SESSION_NOT_OPEN"]);
  });

  it("applies an optional spread cap from the raw bid/ask, failing closed when the cap is invalid", () => {
    expect(assessQuoteAdmission(input({ maxSpreadBps: 1 })).admissible).toBe(true); // 0.7279 bps
    expect(assessQuoteAdmission(input({ maxSpreadBps: 0.5 })).reasons).toEqual(["SPREAD_ABOVE_CAP"]);
    // A descriptor claiming a tight spread cannot hide a wide raw book.
    const claimed = { ...input().quality, spreadBps: "0.1" };
    expect(assessQuoteAdmission(input({ quality: claimed, bid: "1.0", ask: "1.1", maxSpreadBps: 5 })).reasons).toEqual(["SPREAD_ABOVE_CAP"]);
    const oneSided = { ...input().quality, twoSided: false };
    expect(assessQuoteAdmission(input({ quality: oneSided, ask: null, maxSpreadBps: 5 })).reasons).toEqual(["ONE_SIDED_QUOTE", "SPREAD_UNKNOWN"]);
    expect(assessQuoteAdmission(input({ maxSpreadBps: Number.NaN })).reasons).toEqual(["INVALID_LIMIT"]);
    expect(assessQuoteAdmission(input({ maxSpreadBps: 0 })).reasons).toEqual(["INVALID_LIMIT"]);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("treats maxAgeMs=%s as invalid and refuses", (maxAgeMs) => {
    expect(assessQuoteAdmission(input({ maxAgeMs })).reasons).toContain("INVALID_LIMIT");
  });

  it.each(["DELAYED", "STALE", "REPLAY", "", "live"])("refuses stored dataState %j whatever the descriptor claims", (dataState) => {
    expect(assessQuoteAdmission(input({ dataState })).reasons).toContain("DATA_STATE_NOT_ADMISSIBLE");
  });

  it("a non-finite skew tolerance or clock refuses instead of disabling the time checks (safety review M2)", () => {
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    expect(assessQuoteAdmission(input({ eventTime: future, clockSkewToleranceMs: Number.NaN })).reasons).toEqual(
      expect.arrayContaining(["INVALID_LIMIT", "FUTURE_EVENT_TIME"]),
    );
    expect(assessQuoteAdmission(input({ clockSkewToleranceMs: -5 })).reasons).toContain("INVALID_LIMIT");
    const badNow = assessQuoteAdmission(input({ now: new Date(Number.NaN) }));
    expect(badNow.admissible).toBe(false);
    expect(badNow.reasons).toContain("INVALID_LIMIT");
  });

  it("property: across a grid of inputs, nothing with REFERENCE_RATE coverage or a closed session is ever admissible", () => {
    const feeds = QUOTE_FEEDS;
    const sessions: SessionStatus[] = ["OPEN", "CLOSED", "UNKNOWN"];
    const ages = [0, 1_000, 44_999, 45_000, 45_001, 3_600_000];
    let admitted = 0;
    for (const feed of feeds)
      for (const session of sessions)
        for (const age of ages)
          for (const enabled of [true, false])
            for (const tradeable of [true, false, null]) {
              const eventTime = new Date(NOW.getTime() - age).toISOString();
              const result = assessQuoteAdmission(
                input({ feed, session, eventTime, receivedAt: new Date(NOW.getTime() - age), instrumentEnabled: enabled, tradeable }),
              );
              if (result.admissible) {
                admitted += 1;
                expect(result.reasons).toEqual([]);
                expect(result.eventAgeMs).toBeLessThanOrEqual(45_000);
                expect(session).toBe("OPEN");
                expect(enabled).toBe(true);
                expect(tradeable).not.toBe(false);
                expect(["ALPACA_IEX", "ALPACA_SIP", "OANDA_PRACTICE"]).toContain(feed);
              } else {
                expect(result.reasons.length).toBeGreaterThan(0);
              }
              if (feed === "ECB_REFERENCE") expect(result.admissible).toBe(false);
            }
    expect(admitted).toBeGreaterThan(0);
  });

  it("reports reasons in the declared stable order without duplicates", () => {
    const result = assessQuoteAdmission(input({ feed: "ECB_REFERENCE", ask: null, eventTime: null, session: "CLOSED", instrumentEnabled: false }));
    const order = result.reasons.map((r) => QUOTE_ADMISSION_REASONS.indexOf(r));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(new Set(result.reasons).size).toBe(result.reasons.length);
  });
});
