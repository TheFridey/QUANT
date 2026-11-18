import { describe, expect, it } from "vitest";
import { assessQuoteTiers, spreadByNewYorkHour, spreadStatistics, validateTierPolicy, type TierPolicy } from "./gold-quote-tiers.js";

// Test fixture only. These are not recommended values; thresholds need measurement and operator approval.
const POLICY: TierPolicy = {
  REFERENCE_INGEST_QUALITY: { maxSpreadBps: 50, maxQuoteAgeMs: 60_000, requireSessionOpen: false, requireProviderTradeable: false },
  SHADOW_RESEARCH_QUALITY: { maxSpreadBps: 20, maxQuoteAgeMs: 10_000, requireSessionOpen: true, requireProviderTradeable: false },
  PAPER_ENTRY_QUALITY: { maxSpreadBps: 4, maxQuoteAgeMs: 3_000, requireSessionOpen: true, requireProviderTradeable: true },
  PAPER_EXIT_QUALITY: { maxSpreadBps: 12, maxQuoteAgeMs: 5_000, requireSessionOpen: false, requireProviderTradeable: false },
};

describe("gold quote quality tiers (no defaults, never executable)", () => {
  it("accepts an ordered policy and refuses a looser entry, a tighter exit or missing values", () => {
    expect(validateTierPolicy(POLICY)).toEqual({ ok: true });
    expect(validateTierPolicy({ ...POLICY, PAPER_ENTRY_QUALITY: { ...POLICY.PAPER_ENTRY_QUALITY, maxSpreadBps: 30 } })).toMatchObject({ ok: false, issues: expect.arrayContaining(["ENTRY_LOOSER_THAN_RESEARCH"]) });
    expect(validateTierPolicy({ ...POLICY, PAPER_EXIT_QUALITY: { ...POLICY.PAPER_EXIT_QUALITY, maxSpreadBps: 2 } })).toMatchObject({ ok: false, issues: ["EXIT_TIGHTER_THAN_ENTRY"] });
    expect(validateTierPolicy({ ...POLICY, SHADOW_RESEARCH_QUALITY: { ...POLICY.SHADOW_RESEARCH_QUALITY, maxSpreadBps: 60 } })).toMatchObject({ ok: false, issues: expect.arrayContaining(["RESEARCH_LOOSER_THAN_INGEST"]) });
    expect(validateTierPolicy({ ...POLICY, PAPER_ENTRY_QUALITY: { ...POLICY.PAPER_ENTRY_QUALITY, requireProviderTradeable: false } })).toMatchObject({ ok: false, issues: ["ENTRY_MUST_REQUIRE_SESSION_AND_TRADEABLE"] });
    const { PAPER_EXIT_QUALITY: _, ...missing } = POLICY;
    expect(validateTierPolicy(missing as TierPolicy)).toMatchObject({ ok: false, issues: ["INVALID_THRESHOLD:PAPER_EXIT_QUALITY"] });
    expect(validateTierPolicy({ ...POLICY, PAPER_ENTRY_QUALITY: { ...POLICY.PAPER_ENTRY_QUALITY, maxSpreadBps: Number.NaN } }).ok).toBe(false);
    expect(() => assessQuoteTiers({ bid: 1, ask: 2, quoteAgeMs: 0, sessionOpen: true, providerTradeable: true }, { ...POLICY, PAPER_EXIT_QUALITY: undefined as never })).toThrow("INVALID_TIER_POLICY");
  });

  it("labels each tier separately; a wide quote can still be a usable exit and a reference observation", () => {
    // 2650.00 / 2651.80 is about 6.8 bps: too wide to enter, fine to exit, research and ingest.
    const a = assessQuoteTiers({ bid: "2650.00", ask: "2651.80", quoteAgeMs: 1_000, sessionOpen: true, providerTradeable: true }, POLICY);
    expect(a.executable).toBe(false);
    expect(a.spreadBps).toBeCloseTo(6.79, 2);
    expect(a.tiers.PAPER_ENTRY_QUALITY).toEqual({ met: false, failures: ["SPREAD_ABOVE_TIER"] });
    expect(a.tiers.PAPER_EXIT_QUALITY.met).toBe(true);
    expect(a.tiers.SHADOW_RESEARCH_QUALITY.met).toBe(true);
    expect(a.tiers.REFERENCE_INGEST_QUALITY.met).toBe(true);
  });

  it("closed session, untradeable, stale, unknown age and crossed quotes fail the right tiers", () => {
    const closed = assessQuoteTiers({ bid: 2650, ask: 2650.3, quoteAgeMs: 1_000, sessionOpen: false, providerTradeable: false }, POLICY);
    expect(closed.tiers.PAPER_ENTRY_QUALITY.failures).toEqual(["SESSION_NOT_OPEN", "NOT_TRADEABLE"]);
    expect(closed.tiers.SHADOW_RESEARCH_QUALITY.failures).toEqual(["SESSION_NOT_OPEN"]);
    expect(closed.tiers.REFERENCE_INGEST_QUALITY.met).toBe(true);
    const stale = assessQuoteTiers({ bid: 2650, ask: 2650.3, quoteAgeMs: 30_000, sessionOpen: true, providerTradeable: true }, POLICY);
    expect(stale.tiers.REFERENCE_INGEST_QUALITY.met).toBe(true);
    expect(stale.tiers.SHADOW_RESEARCH_QUALITY.failures).toEqual(["QUOTE_TOO_OLD"]);
    const unknown = assessQuoteTiers({ bid: 2650, ask: 2650.3, quoteAgeMs: null, sessionOpen: true, providerTradeable: true }, POLICY);
    expect(Object.values(unknown.tiers).every((t) => t.failures.includes("AGE_UNKNOWN"))).toBe(true);
    const crossed = assessQuoteTiers({ bid: 2651, ask: 2650, quoteAgeMs: 0, sessionOpen: true, providerTradeable: true }, POLICY);
    expect(crossed.spreadBps).toBeNull();
    expect(Object.values(crossed.tiers).every((t) => t.failures.includes("ONE_SIDED_OR_CROSSED"))).toBe(true);
  });

  it("spread statistics in points, bps and GBP per stake; bad samples are rejected, not repaired", () => {
    const samples = [
      { time: "2026-11-17T14:00:00Z", bid: "2650.00", ask: "2650.30" },
      { time: "2026-11-17T14:01:00Z", bid: "2650.00", ask: "2650.40" },
      { time: "2026-11-17T14:02:00Z", bid: "2650.00", ask: "2650.50" },
      { time: "2026-11-17T14:03:00Z", bid: "2650.00", ask: "2651.00" },
      { time: "2026-11-17T14:04:00Z", bid: "2650.00", ask: "2650.00" },
      { time: "bad", bid: "2650.00", ask: "2650.30" },
      { time: "2026-11-17T14:05:00Z", bid: "x", ask: "2650.30" },
    ];
    const d = spreadStatistics(samples, { stakeGbp: 0.5, pointSize: 1 })!;
    expect(d.samples).toBe(4);
    expect(d.rejected).toBe(3);
    expect(d.points.p50).toBeCloseTo(0.4, 6);
    expect(d.points.max).toBeCloseTo(1.0, 6);
    expect(d.roundTripGbpPerStake.max).toBeCloseTo(0.5, 6);
    expect(d.bps.p50).toBeCloseTo(1.509, 2);
    expect(spreadStatistics([], { stakeGbp: 1, pointSize: 1 })).toBeNull();
    expect(() => spreadStatistics(samples, { stakeGbp: 0, pointSize: 1 })).toThrow();
  });

  it("groups by New York hour, including the 17:00 rollover", () => {
    const out = spreadByNewYorkHour(
      [
        { time: "2026-11-17T21:59:00Z", bid: 2650, ask: 2650.3 }, // 16:59 New York (EST)
        { time: "2026-11-17T22:05:00Z", bid: 2650, ask: 2652 }, // 17:05 New York
      ],
      { stakeGbp: 1, pointSize: 1 },
    );
    expect(Object.keys(out)).toEqual(["16", "17"]);
    expect(out[17]!.points.max).toBeCloseTo(2, 6);
  });
});
