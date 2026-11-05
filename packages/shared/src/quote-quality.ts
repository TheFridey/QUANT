import { Decimal } from "./money.js";

/**
 * HORIZON quote-quality descriptor. Purely descriptive and additive: it sits alongside a quote's
 * `dataState` (the freshness label that risk admission reads) and never replaces or feeds it. Its job is
 * to say honestly what a quote is: which feed, whether it is consolidated or one venue, whether it is
 * real-time, delayed or a reference rate, and how old it was when we looked at it.
 */

export const QUOTE_FEEDS = [
  "ALPACA_IEX",
  "ALPACA_SIP",
  "ALPACA_DELAYED_SIP",
  "ALPACA_ACCOUNT_DEFAULT",
  "OANDA_PRACTICE",
  "ECB_REFERENCE",
  "DEXSCREENER",
  "OFFLINE_FIXTURE",
  "UNKNOWN",
] as const;
export type QuoteFeed = (typeof QUOTE_FEEDS)[number];

/** Breadth of the market behind a quote. */
export const QUOTE_COVERAGES = [
  /** All US venues (SIP). */
  "CONSOLIDATED",
  /** One exchange only (e.g. IEX): prices and sizes are a subset of the market. */
  "SINGLE_VENUE",
  /** A dealer's own indicative bid/ask (OANDA): not an exchange order book. */
  "DEALER_INDICATIVE",
  /** A published fixing or reference rate (ECB via Frankfurter): no bid/ask, not tradeable. */
  "REFERENCE_RATE",
  /** DEX pool-derived prices aggregated by a third party. */
  "AGGREGATED_DEX",
  "UNKNOWN",
] as const;
export type QuoteCoverage = (typeof QUOTE_COVERAGES)[number];

export const QUOTE_TIMELINESS = ["REAL_TIME", "DELAYED", "REFERENCE", "RECORDED", "UNKNOWN"] as const;
export type QuoteTimeliness = (typeof QUOTE_TIMELINESS)[number];

export type QuoteQuality = {
  /** Provider id that produced the quote (e.g. `alpaca_paper`). */
  source: string;
  feed: QuoteFeed;
  coverage: QuoteCoverage;
  timeliness: QuoteTimeliness;
  /** True only when both a bid and an ask were observed. */
  twoSided: boolean;
  /** Provider event time (ISO) or null when the provider gave none. */
  eventTime: string | null;
  /** now − eventTime in ms at observation; null when there is no event time. Negative ages are clamped to null. */
  quoteAgeMs: number | null;
  /** Provider's own tradeable flag (OANDA `tradeable`); null when the provider does not report one. */
  providerTradeable: boolean | null;
  /** ask − bid as decimal text, when two-sided. */
  spread: string | null;
  /** Spread over mid in basis points (4 dp), when two-sided and mid > 0. */
  spreadBps: string | null;
  /** Free-text caveats for display (never parsed by risk code). */
  notes: string[];
};

const FEED_PROFILE: Record<QuoteFeed, { coverage: QuoteCoverage; timeliness: QuoteTimeliness; note: string | null }> = {
  ALPACA_IEX: { coverage: "SINGLE_VENUE", timeliness: "REAL_TIME", note: "IEX only: about 2-3% of US volume; sizes are IEX sizes, not the NBBO" },
  ALPACA_SIP: { coverage: "CONSOLIDATED", timeliness: "REAL_TIME", note: "SIP consolidated feed (requires a paid Alpaca data plan)" },
  ALPACA_DELAYED_SIP: { coverage: "CONSOLIDATED", timeliness: "DELAYED", note: "SIP consolidated feed delayed 15 minutes" },
  ALPACA_ACCOUNT_DEFAULT: { coverage: "UNKNOWN", timeliness: "UNKNOWN", note: "feed not requested explicitly; Alpaca chose the account default" },
  OANDA_PRACTICE: { coverage: "DEALER_INDICATIVE", timeliness: "REAL_TIME", note: "OANDA fxTrade Practice dealer prices; practice account, not a live venue" },
  ECB_REFERENCE: { coverage: "REFERENCE_RATE", timeliness: "REFERENCE", note: "daily ECB reference rate (published once per TARGET business day); never a live quote" },
  DEXSCREENER: { coverage: "AGGREGATED_DEX", timeliness: "REAL_TIME", note: null },
  OFFLINE_FIXTURE: { coverage: "UNKNOWN", timeliness: "RECORDED", note: "offline recorded fixture; not market data" },
  UNKNOWN: { coverage: "UNKNOWN", timeliness: "UNKNOWN", note: null },
};

function finitePositive(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Build a quality descriptor from a feed profile plus what was actually observed. */
export function describeQuoteQuality(input: {
  source: string;
  feed: QuoteFeed;
  now: Date;
  eventTime?: string | null;
  bid?: string | number | null;
  ask?: string | number | null;
  providerTradeable?: boolean | null;
  notes?: string[];
}): QuoteQuality {
  const profile = FEED_PROFILE[input.feed];
  const eventMs = input.eventTime ? Date.parse(input.eventTime) : Number.NaN;
  const age = Number.isFinite(eventMs) ? input.now.getTime() - eventMs : null;
  const bid = finitePositive(input.bid);
  const ask = finitePositive(input.ask);
  const twoSided = bid !== null && ask !== null && ask >= bid;
  let spread: string | null = null;
  let spreadBps: string | null = null;
  if (twoSided) {
    // Exact decimal arithmetic on the provider's text, so no float noise reaches the display.
    const b = new Decimal(String(input.bid));
    const a = new Decimal(String(input.ask));
    const diff = a.minus(b);
    spread = diff.toFixed();
    const mid = a.plus(b).div(2);
    spreadBps = mid.gt(0) ? diff.div(mid).mul(10_000).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4) : null;
  }
  const notes = [...(profile.note ? [profile.note] : []), ...(input.notes ?? [])];
  return {
    source: input.source,
    feed: input.feed,
    coverage: profile.coverage,
    timeliness: profile.timeliness,
    twoSided,
    eventTime: Number.isFinite(eventMs) ? new Date(eventMs).toISOString() : null,
    quoteAgeMs: age !== null && age >= 0 ? age : null,
    providerTradeable: input.providerTradeable ?? null,
    spread,
    spreadBps,
    notes,
  };
}

/** True when the descriptor describes something that could be a live executable quote. Reference rates never are. */
export function qualityIsRealTimeTwoSided(quality: QuoteQuality): boolean {
  return quality.timeliness === "REAL_TIME" && quality.twoSided && quality.coverage !== "REFERENCE_RATE";
}
