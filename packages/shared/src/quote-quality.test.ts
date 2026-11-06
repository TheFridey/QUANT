import { describe, expect, it } from "vitest";
import { describeQuoteQuality, qualityIsRealTimeTwoSided } from "./quote-quality.js";

const NOW = new Date("2026-11-04T15:00:00.000Z");

describe("describeQuoteQuality", () => {
  it("describes an IEX quote as single-venue real-time with age and spread", () => {
    const q = describeQuoteQuality({ source: "alpaca_paper", feed: "ALPACA_IEX", now: NOW, eventTime: "2026-11-04T14:59:58.500Z", bid: 512.1, ask: "512.13" });
    expect(q).toMatchObject({ coverage: "SINGLE_VENUE", timeliness: "REAL_TIME", twoSided: true, quoteAgeMs: 1500, spread: "0.03" });
    expect(q.spreadBps).toBe("0.5858");
    expect(qualityIsRealTimeTwoSided(q)).toBe(true);
  });

  it("describes Frankfurter/ECB as a daily reference rate, never live", () => {
    const q = describeQuoteQuality({ source: "frankfurter_fx", feed: "ECB_REFERENCE", now: NOW, eventTime: "2026-11-03T16:00:00.000Z" });
    expect(q).toMatchObject({ coverage: "REFERENCE_RATE", timeliness: "REFERENCE", twoSided: false, spread: null });
    expect(q.notes.join(" ")).toMatch(/daily ECB reference rate/);
    expect(qualityIsRealTimeTwoSided(q)).toBe(false);
  });

  it("separates SIP, delayed SIP and the unspecified account default", () => {
    expect(describeQuoteQuality({ source: "a", feed: "ALPACA_SIP", now: NOW })).toMatchObject({ coverage: "CONSOLIDATED", timeliness: "REAL_TIME" });
    expect(describeQuoteQuality({ source: "a", feed: "ALPACA_DELAYED_SIP", now: NOW })).toMatchObject({ coverage: "CONSOLIDATED", timeliness: "DELAYED" });
    expect(describeQuoteQuality({ source: "a", feed: "ALPACA_ACCOUNT_DEFAULT", now: NOW })).toMatchObject({ coverage: "UNKNOWN", timeliness: "UNKNOWN" });
  });

  it("is not two-sided for a crossed, missing or non-positive side and clamps future event times", () => {
    expect(describeQuoteQuality({ source: "o", feed: "OANDA_PRACTICE", now: NOW, bid: "1.1", ask: "1.0" }).twoSided).toBe(false);
    expect(describeQuoteQuality({ source: "o", feed: "OANDA_PRACTICE", now: NOW, bid: "0", ask: "1.0" }).twoSided).toBe(false);
    expect(describeQuoteQuality({ source: "o", feed: "OANDA_PRACTICE", now: NOW, eventTime: "2026-11-04T15:00:01Z" }).quoteAgeMs).toBeNull();
    expect(describeQuoteQuality({ source: "o", feed: "OANDA_PRACTICE", now: NOW, eventTime: "garbage" })).toMatchObject({ eventTime: null, quoteAgeMs: null });
  });

  it("marks recorded fixtures as RECORDED and carries the provider tradeable flag", () => {
    const q = describeQuoteQuality({ source: "oanda_practice", feed: "OFFLINE_FIXTURE", now: NOW, providerTradeable: false });
    expect(q).toMatchObject({ timeliness: "RECORDED", providerTradeable: false });
    expect(qualityIsRealTimeTwoSided(q)).toBe(false);
  });
});
