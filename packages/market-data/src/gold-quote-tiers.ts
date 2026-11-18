/**
 * CATALYST: gold quote quality tiers and spread statistics. **Pure. No defaults. Never executable.**
 *
 * Four tiers, each with its own operator-approved thresholds:
 * - REFERENCE_INGEST_QUALITY: worth storing as a reference observation at all.
 * - SHADOW_RESEARCH_QUALITY:  usable as evidence in shadow research.
 * - PAPER_ENTRY_QUALITY:      would be good enough to *open* a paper position (no order path exists yet).
 * - PAPER_EXIT_QUALITY:       would be good enough to *close* one at a fair price.
 *
 * There are deliberately no default thresholds: the proposed 10 bps cap is not adopted. Values must come from
 * a measured spread distribution (`spreadStatistics`) and operator approval. `validateTierPolicy` enforces the
 * ordering that keeps the tiers meaningful: entry is the strictest, research is no looser than ingest, and the
 * exit cap is never tighter than entry. A protective exit must never be blocked by an entry-quality rule, so a
 * quote that fails PAPER_EXIT_QUALITY is reported as a poor exit price, not as a reason to keep risk open.
 */

export const QUOTE_QUALITY_TIERS = ["REFERENCE_INGEST_QUALITY", "SHADOW_RESEARCH_QUALITY", "PAPER_ENTRY_QUALITY", "PAPER_EXIT_QUALITY"] as const;
export type QuoteQualityTier = (typeof QUOTE_QUALITY_TIERS)[number];

export type TierThreshold = {
  maxSpreadBps: number;
  maxQuoteAgeMs: number;
  requireSessionOpen: boolean;
  requireProviderTradeable: boolean;
};

export type TierPolicy = Record<QuoteQualityTier, TierThreshold>;

export type TierPolicyIssue =
  | `INVALID_THRESHOLD:${QuoteQualityTier}`
  | "ENTRY_LOOSER_THAN_RESEARCH"
  | "RESEARCH_LOOSER_THAN_INGEST"
  | "EXIT_TIGHTER_THAN_ENTRY"
  | "ENTRY_MUST_REQUIRE_SESSION_AND_TRADEABLE";

function validThreshold(t: TierThreshold | undefined): boolean {
  return (
    !!t &&
    typeof t.maxSpreadBps === "number" &&
    Number.isFinite(t.maxSpreadBps) &&
    t.maxSpreadBps > 0 &&
    t.maxSpreadBps <= 1_000 &&
    typeof t.maxQuoteAgeMs === "number" &&
    Number.isFinite(t.maxQuoteAgeMs) &&
    t.maxQuoteAgeMs > 0 &&
    t.maxQuoteAgeMs <= 3_600_000 &&
    typeof t.requireSessionOpen === "boolean" &&
    typeof t.requireProviderTradeable === "boolean"
  );
}

export function validateTierPolicy(p: TierPolicy): { ok: true } | { ok: false; issues: TierPolicyIssue[] } {
  const issues: TierPolicyIssue[] = [];
  for (const tier of QUOTE_QUALITY_TIERS) if (!validThreshold(p?.[tier])) issues.push(`INVALID_THRESHOLD:${tier}`);
  if (issues.length > 0) return { ok: false, issues };
  const ingest = p.REFERENCE_INGEST_QUALITY;
  const research = p.SHADOW_RESEARCH_QUALITY;
  const entry = p.PAPER_ENTRY_QUALITY;
  const exit = p.PAPER_EXIT_QUALITY;
  if (research.maxSpreadBps > ingest.maxSpreadBps || research.maxQuoteAgeMs > ingest.maxQuoteAgeMs) issues.push("RESEARCH_LOOSER_THAN_INGEST");
  if (entry.maxSpreadBps > research.maxSpreadBps || entry.maxQuoteAgeMs > research.maxQuoteAgeMs) issues.push("ENTRY_LOOSER_THAN_RESEARCH");
  if (exit.maxSpreadBps < entry.maxSpreadBps || exit.maxQuoteAgeMs < entry.maxQuoteAgeMs) issues.push("EXIT_TIGHTER_THAN_ENTRY");
  if (!entry.requireSessionOpen || !entry.requireProviderTradeable) issues.push("ENTRY_MUST_REQUIRE_SESSION_AND_TRADEABLE");
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

export type QuoteMetrics = {
  bid: number | string | null;
  ask: number | string | null;
  /** Age at assessment time from the provider event time; null when unknown. */
  quoteAgeMs: number | null;
  sessionOpen: boolean | null;
  providerTradeable: boolean | null;
};

export type TierFailure = "ONE_SIDED_OR_CROSSED" | "SPREAD_ABOVE_TIER" | "AGE_UNKNOWN" | "QUOTE_TOO_OLD" | "SESSION_NOT_OPEN" | "NOT_TRADEABLE";

export type TierAssessment = {
  spreadBps: number | null;
  tiers: Record<QuoteQualityTier, { met: boolean; failures: TierFailure[] }>;
  /** Always false: a tier is a quality label, never an order permission. */
  executable: false;
};

function num(v: number | string | null): number | null {
  if (v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function assessQuoteTiers(m: QuoteMetrics, policy: TierPolicy): TierAssessment {
  const valid = validateTierPolicy(policy);
  if (!valid.ok) throw new Error(`INVALID_TIER_POLICY:${valid.issues.join(",")}`);
  const bid = num(m.bid);
  const ask = num(m.ask);
  const spreadBps = bid !== null && ask !== null && ask > bid ? ((ask - bid) / ((ask + bid) / 2)) * 10_000 : null;
  const tiers = {} as TierAssessment["tiers"];
  for (const tier of QUOTE_QUALITY_TIERS) {
    const t = policy[tier];
    const failures: TierFailure[] = [];
    if (spreadBps === null) failures.push("ONE_SIDED_OR_CROSSED");
    else if (spreadBps > t.maxSpreadBps) failures.push("SPREAD_ABOVE_TIER");
    if (m.quoteAgeMs === null || !Number.isFinite(m.quoteAgeMs) || m.quoteAgeMs < 0) failures.push("AGE_UNKNOWN");
    else if (m.quoteAgeMs > t.maxQuoteAgeMs) failures.push("QUOTE_TOO_OLD");
    if (t.requireSessionOpen && m.sessionOpen !== true) failures.push("SESSION_NOT_OPEN");
    if (t.requireProviderTradeable && m.providerTradeable !== true) failures.push("NOT_TRADEABLE");
    tiers[tier] = { met: failures.length === 0, failures };
  }
  return { spreadBps, tiers, executable: false };
}

export type SpreadSample = { time: string; bid: number | string; ask: number | string };

export type SpreadDistribution = {
  samples: number;
  rejected: number;
  points: Percentiles;
  bps: Percentiles;
  /** Round-trip spread cost for one stake unit of `stakeGbp` per point: spread points × stake. */
  roundTripGbpPerStake: Percentiles;
  stakeGbp: number;
  pointSize: number;
};

export type Percentiles = { p50: number; p90: number; p95: number; p99: number; max: number; mean: number };

/** Nearest-rank percentile on a sorted array. */
function rank(sorted: number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i]!;
}

function percentiles(values: number[]): Percentiles {
  const s = [...values].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { p50: rank(s, 0.5), p90: rank(s, 0.9), p95: rank(s, 0.95), p99: rank(s, 0.99), max: s[s.length - 1]!, mean };
}

/**
 * Spread distribution from bid/ask samples: live quotes, or bid/ask candle closes (OANDA `price=BA`), which give a
 * historical spread at every bar close without polling. Crossed, locked, one-sided or non-numeric samples are
 * counted as rejected, never repaired. `pointSize` is USD of price per point (1 for the generic gold profile).
 */
export function spreadStatistics(samples: readonly SpreadSample[], opts: { stakeGbp: number; pointSize: number }): SpreadDistribution | null {
  if (!(opts.stakeGbp > 0) || !(opts.pointSize > 0)) throw new Error("INVALID_STAKE_OR_POINT");
  const points: number[] = [];
  const bps: number[] = [];
  let rejected = 0;
  for (const s of samples) {
    const bid = num(s.bid);
    const ask = num(s.ask);
    if (bid === null || ask === null || !(ask > bid) || Number.isNaN(Date.parse(s.time))) {
      rejected++;
      continue;
    }
    points.push((ask - bid) / opts.pointSize);
    bps.push(((ask - bid) / ((ask + bid) / 2)) * 10_000);
  }
  if (points.length === 0) return null;
  const pts = percentiles(points);
  const gbp = (x: number) => x * opts.stakeGbp;
  return {
    samples: points.length,
    rejected,
    points: pts,
    bps: percentiles(bps),
    roundTripGbpPerStake: { p50: gbp(pts.p50), p90: gbp(pts.p90), p95: gbp(pts.p95), p99: gbp(pts.p99), max: gbp(pts.max), mean: gbp(pts.mean) },
    stakeGbp: opts.stakeGbp,
    pointSize: opts.pointSize,
  };
}

/** Groups samples by New York hour (0–23), so thresholds can reflect the rollover and thin sessions. */
export function spreadByNewYorkHour(samples: readonly SpreadSample[], opts: { stakeGbp: number; pointSize: number }): Record<number, SpreadDistribution | null> {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" });
  const buckets = new Map<number, SpreadSample[]>();
  for (const s of samples) {
    const t = Date.parse(s.time);
    if (Number.isNaN(t)) continue;
    const h = Number(fmt.format(new Date(t)));
    buckets.set(h, [...(buckets.get(h) ?? []), s]);
  }
  const out: Record<number, SpreadDistribution | null> = {};
  for (const [h, list] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) out[h] = spreadStatistics(list, opts);
  return out;
}
