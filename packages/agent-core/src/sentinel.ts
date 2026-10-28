import {
  confidenceFixed,
  d,
  isTradableQuote,
  type CyclePair,
  type DiscoveryCandidate,
  type ReasonCode,
  type StrategyConfig,
  Decimal,
} from "@odin/shared";
import { MODEL_VERSIONS } from "./versions.js";
import type { DecisionDraft } from "./types.js";

export type SentinelResult = {
  decision: DecisionDraft;
  candidate: DiscoveryCandidate;
};

/** Quote integrity + discovery scoring. Never invents missing fields. */
export function runSentinel(
  pair: CyclePair,
  config: StrategyConfig,
  now: Date = new Date(),
): SentinelResult {
  const started = Date.now();
  const reasons: ReasonCode[] = [];
  if (pair.freshness === "STALE") reasons.push("DATA_STALE");
  if (pair.freshness === "REPLAY") reasons.push("DATA_REPLAY");
  if (pair.freshness === "DEMO") reasons.push("DATA_DEMO");
  if (pair.priceUsd === null) reasons.push("MISSING_PRICE");
  else if (d(pair.priceUsd).lte(0)) reasons.push("NON_POSITIVE_PRICE");
  if (pair.liquidityUsd === null) reasons.push("MISSING_LIQUIDITY");
  else if (d(pair.liquidityUsd).lt(config.minLiquidityUsd)) reasons.push("LIQUIDITY_FLOOR");
  if (pair.volume24hUsd === null) reasons.push("MISSING_VOLUME");
  else if (d(pair.volume24hUsd).lt(config.minVolume24hUsd)) reasons.push("VOLUME_FLOOR");

  const pairAgeMinutes = ageMinutes(pair.pairCreatedAt ?? null, now);
  const discoveryFiltered = applyDiscoveryFilters(pair, config, pairAgeMinutes, reasons);

  if (reasons.length === 0 && pair.freshness === "DELAYED") reasons.push("DATA_DELAYED");
  if (reasons.length === 0) reasons.push("DATA_OK");

  const rejected = reasons.some(
    (reason) =>
      reason !== "DATA_OK" &&
      reason !== "DATA_DELAYED" &&
      reason !== "DISCOVERY_FILTERED" &&
      !(reason === "DATA_DEMO" && config.allowDemoPaperEntries === true),
  );
  const score = discoveryScore(pair, pairAgeMinutes);
  const candidate: DiscoveryCandidate = {
    pairAddress: pair.pairAddress,
    baseAddress: pair.baseAddress,
    baseSymbol: pair.baseSymbol,
    quoteAddress: pair.quoteAddress,
    quoteSymbol: pair.quoteSymbol,
    dexId: pair.dexId,
    source: pair.source,
    priceUsd: pair.priceUsd,
    liquidityUsd: pair.liquidityUsd,
    volume24hUsd: pair.volume24hUsd,
    volume5mUsd: pair.volume5mUsd,
    marketCapUsd: pair.marketCapUsd ?? null,
    fdvUsd: pair.fdvUsd ?? null,
    pairCreatedAt: pair.pairCreatedAt ?? null,
    pairAgeMinutes,
    txnsM5Buys: pair.txnsM5Buys,
    txnsM5Sells: pair.txnsM5Sells,
    priceChangeM5Pct: pair.priceChangeM5Pct,
    priceChangeH1Pct: pair.priceChangeH1Pct,
    freshness: pair.freshness,
    receivedAt: pair.receivedAt,
    discoveryScore: score,
    rank: 0,
    reasonCodes: discoveryFiltered ? [...reasons, "DISCOVERY_FILTERED"] : [...reasons, "DISCOVERY_RANKED"],
  };

  const decision: DecisionDraft = {
    agent: "SENTINEL",
    modelVersion: MODEL_VERSIONS.SENTINEL,
    pairAddress: pair.pairAddress,
    decision: rejected || discoveryFiltered ? "REJECT" : "PASS",
    confidence: "1.000000",
    reasonCodes: candidate.reasonCodes,
    input: {
      observationId: pair.observationId,
      freshness: pair.freshness,
      pairCreatedAt: pair.pairCreatedAt ?? null,
      fdvUsd: pair.fdvUsd ?? null,
      marketCapUsd: pair.marketCapUsd ?? null,
    },
    output: {
      discoveryScore: score,
      pairAgeMinutes,
      watchlistEligible: !rejected && !discoveryFiltered,
    },
    inputSource: `observation:${pair.source}`,
    durationMs: Date.now() - started,
  };
  return { decision, candidate };
}

export function rankWatchlist(candidates: DiscoveryCandidate[], limit: number): DiscoveryCandidate[] {
  const byPair = new Map<string, DiscoveryCandidate>();
  for (const candidate of candidates) {
    if (candidate.reasonCodes.includes("DISCOVERY_FILTERED")) continue;
    if (candidate.reasonCodes.some((code) => hardReject(code))) continue;
    const existing = byPair.get(candidate.pairAddress);
    if (!existing || d(candidate.discoveryScore).gt(existing.discoveryScore)) {
      byPair.set(candidate.pairAddress, candidate);
    }
  }
  return [...byPair.values()]
    .sort((a, b) => {
      const scoreCmp = d(b.discoveryScore).cmp(d(a.discoveryScore));
      if (scoreCmp !== 0) return scoreCmp;
      return a.pairAddress.localeCompare(b.pairAddress);
    })
    .slice(0, limit)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

function applyDiscoveryFilters(
  pair: CyclePair,
  config: StrategyConfig,
  pairAgeMinutes: number | null,
  reasons: ReasonCode[],
): boolean {
  let filtered = false;
  if (d(config.discoveryMinPairAgeMinutes).gt(0)) {
    if (pairAgeMinutes === null || pairAgeMinutes < Number(config.discoveryMinPairAgeMinutes)) {
      filtered = true;
    }
  }
  if (config.discoveryMaxPairAgeHours !== null) {
    if (pairAgeMinutes === null) {
      // Age unknown: do not invent; filter out when a max age is configured.
      filtered = true;
    } else if (pairAgeMinutes / 60 > Number(config.discoveryMaxPairAgeHours)) {
      filtered = true;
    }
  }
  if (!isTradableQuote(pair.quoteAddress)) {
    // Discovery still ranks; automatic entry is gated later by PULSE.
  }
  void reasons;
  return filtered;
}

function discoveryScore(pair: CyclePair, pairAgeMinutes: number | null): string {
  const liquidity = pair.liquidityUsd ? Decimal.min(d(pair.liquidityUsd).div(1_000_000), new Decimal(1)) : new Decimal(0);
  const volume = pair.volume24hUsd ? Decimal.min(d(pair.volume24hUsd).div(5_000_000), new Decimal(1)) : new Decimal(0);
  const buys = pair.txnsM5Buys ?? 0;
  const sells = pair.txnsM5Sells ?? 0;
  const activity = buys + sells === 0 ? new Decimal(0) : new Decimal(buys).div(buys + sells);
  const freshnessBoost = pair.freshness === "LIVE" ? new Decimal("0.15") : pair.freshness === "DELAYED" ? new Decimal("0.05") : new Decimal(0);
  const ageBoost =
    pairAgeMinutes === null
      ? new Decimal(0)
      : pairAgeMinutes < 60
        ? new Decimal("0.1")
        : pairAgeMinutes < 1440
          ? new Decimal("0.05")
          : new Decimal(0);
  const score = liquidity.mul(0.35).plus(volume.mul(0.3)).plus(activity.mul(0.2)).plus(freshnessBoost).plus(ageBoost);
  return confidenceFixed(Decimal.min(new Decimal(1), Decimal.max(new Decimal(0), score)));
}

function ageMinutes(pairCreatedAt: string | null, now: Date): number | null {
  if (!pairCreatedAt) return null;
  const created = Date.parse(pairCreatedAt);
  if (!Number.isFinite(created)) return null;
  const minutes = (now.getTime() - created) / 60_000;
  return minutes < 0 ? null : minutes;
}

function hardReject(code: ReasonCode): boolean {
  return (
    code === "DATA_STALE" ||
    code === "DATA_REPLAY" ||
    code === "DATA_DEMO" ||
    code === "MISSING_PRICE" ||
    code === "NON_POSITIVE_PRICE" ||
    code === "MISSING_LIQUIDITY" ||
    code === "LIQUIDITY_FLOOR" ||
    code === "MISSING_VOLUME" ||
    code === "VOLUME_FLOOR"
  );
}
