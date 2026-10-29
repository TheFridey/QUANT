import type { NormalizedPair } from "@odin/shared";
import { decimalStringFromJson, intFromJson } from "./numbers.js";
import type { ProviderResult } from "./provider.js";

/** Paid/promoted boosts — optional supplement only; never the sole discovery source. */
export const DEXSCREENER_BOOSTS_URL = "https://api.dexscreener.com/token-boosts/top/v1";
/** Organic latest token profiles (not paid boosts). */
export const DEXSCREENER_PROFILES_URL = "https://api.dexscreener.com/token-profiles/latest/v1";
/** Public search — used for organic Solana quote-anchored discovery. */
export const DEXSCREENER_SEARCH_URL = "https://api.dexscreener.com/latest/dex/search?q=solana";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export function dexscreenerTokensUrl(addresses: string[]): string {
  return `https://api.dexscreener.com/tokens/v1/solana/${addresses.join(",")}`;
}

export function parseDexPair(value: unknown): NormalizedPair | null {
  if (!value || typeof value !== "object") return null;
  const pair = value as Record<string, unknown>;
  if (pair.chainId !== "solana") return null;
  if (typeof pair.pairAddress !== "string" || pair.pairAddress.length < 32) return null;
  if (typeof pair.dexId !== "string" || pair.dexId.length === 0) return null;
  const base = token(pair.baseToken);
  const quote = token(pair.quoteToken);
  if (!base || !quote) return null;
  const liquidity = record(pair.liquidity);
  const volume = record(pair.volume);
  const priceChange = record(pair.priceChange);
  const txns = record(pair.txns);
  const m5 = txns ? record(txns.m5) : null;
  const priceUsd = typeof pair.priceUsd === "string" ? decimalStringFromJson(pair.priceUsd) : null;
  const pairCreatedAt = pairCreatedAtIso(pair.pairCreatedAt);
  return {
    source: "dexscreener",
    chainId: "solana",
    pairAddress: pair.pairAddress,
    dexId: pair.dexId,
    url: typeof pair.url === "string" ? pair.url : null,
    baseAddress: base.address,
    baseSymbol: base.symbol,
    baseName: base.name,
    quoteAddress: quote.address,
    quoteSymbol: quote.symbol,
    priceUsd,
    liquidityUsd: liquidity ? decimalStringFromJson(liquidity.usd) : null,
    volume24hUsd: volume ? decimalStringFromJson(volume.h24) : null,
    volume5mUsd: volume ? decimalStringFromJson(volume.m5) : null,
    priceChangeM5Pct: priceChange ? decimalStringFromJson(priceChange.m5) : null,
    priceChangeH1Pct: priceChange ? decimalStringFromJson(priceChange.h1) : null,
    priceChangeH24Pct: priceChange ? decimalStringFromJson(priceChange.h24) : null,
    txnsM5Buys: m5 ? intFromJson(m5.buys) : null,
    txnsM5Sells: m5 ? intFromJson(m5.sells) : null,
    pairCreatedAt,
    fdvUsd: decimalStringFromJson(pair.fdv),
    marketCapUsd: decimalStringFromJson(pair.marketCap),
    raw: value,
  };
}

function pairCreatedAtIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const ms = value < 1_000_000_000_000 ? value * 1000 : value;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

/**
 * Solana universe discovery.
 * Primary sources: organic token profiles + public search pairs.
 * Boosts are optional supplement only — discovery must succeed when boosts fail/empty.
 */
export async function fetchSolanaUniverse(options: {
  limit: number;
  fetchImpl?: typeof fetch;
  now?: Date;
  /** When false, skip paid boosts endpoint entirely. Default true (supplement only). */
  includeBoosts?: boolean;
}): Promise<ProviderResult<NormalizedPair[]>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const fetchedAt = (options.now ?? new Date()).toISOString();
  const includeBoosts = options.includeBoosts !== false;

  const [profiles, search, boosts] = await Promise.all([
    readJson(fetchImpl, DEXSCREENER_PROFILES_URL),
    readJson(fetchImpl, DEXSCREENER_SEARCH_URL),
    includeBoosts ? readJson(fetchImpl, DEXSCREENER_BOOSTS_URL) : Promise.resolve({ ok: false as const, error: "boosts_skipped" }),
  ]);

  const organicMints = [
    ...solanaMints(profiles.ok ? profiles.body : null),
    ...solanaMintsFromPairs(search.ok ? search.body : null),
  ];
  const boostMints = boosts.ok ? solanaMints(boosts.body) : [];
  // Prefer organic, then optional boosts; WSOL always anchored.
  const mints = unique([WSOL_MINT, ...organicMints, ...boostMints]).slice(0, 30);

  // Prefer ranking search pairs directly when present (already pair-shaped, no second hop).
  const searchRanked = search.ok ? rankPairs(search.body, options.limit) : [];
  if (searchRanked.length >= Math.min(5, options.limit)) {
    const merged = mergeRanked(searchRanked, [], options.limit);
    return {
      ok: true,
      fetchedAt,
      data: merged,
      // provenance meta via unused field not on ProviderResult — callers inspect pairs.source
    };
  }

  const tokens = await readJson(fetchImpl, dexscreenerTokensUrl(mints));
  if (!tokens.ok) {
    if (searchRanked.length > 0) {
      return { ok: true, fetchedAt, data: searchRanked.slice(0, options.limit) };
    }
    if (mints.length > 1) {
      const anchor = await readJson(fetchImpl, dexscreenerTokensUrl([WSOL_MINT]));
      if (anchor.ok) {
        return { ok: true, fetchedAt, data: rankPairs(anchor.body, options.limit) };
      }
    }
    return { ok: false, code: "UPSTREAM", error: tokens.error };
  }
  const tokenRanked = rankPairs(tokens.body, options.limit);
  const ranked = mergeRanked(searchRanked, tokenRanked, options.limit);
  if (ranked.length === 0) {
    return { ok: false, code: "INVALID", error: "DexScreener returned no Solana pairs" };
  }
  return { ok: true, fetchedAt, data: ranked };
}

/** True when discovery did not depend solely on paid boosts. */
export function discoverySourcesUsed(calls: string[]): {
  profiles: boolean;
  search: boolean;
  boosts: boolean;
  organicPrimary: boolean;
} {
  const profiles = calls.some((url) => url.includes("token-profiles"));
  const search = calls.some((url) => url.includes("/latest/dex/search"));
  const boosts = calls.some((url) => url.includes("token-boosts"));
  return { profiles, search, boosts, organicPrimary: profiles || search };
}

function mergeRanked(a: NormalizedPair[], b: NormalizedPair[], limit: number): NormalizedPair[] {
  const byAddress = new Map<string, NormalizedPair>();
  for (const pair of [...a, ...b]) byAddress.set(pair.pairAddress, pair);
  return [...byAddress.values()]
    .sort((left, right) => compareLiquidity(right.liquidityUsd, left.liquidityUsd))
    .slice(0, limit);
}

function rankPairs(body: unknown, limit: number): NormalizedPair[] {
  const list = extractPairs(body);
  if (!list) return [];
  const byAddress = new Map<string, NormalizedPair>();
  for (const item of list) {
    const parsed = parseDexPair(item);
    if (!parsed) continue;
    byAddress.set(parsed.pairAddress, parsed);
  }
  return [...byAddress.values()]
    .sort((a, b) => compareLiquidity(b.liquidityUsd, a.liquidityUsd))
    .slice(0, limit);
}

function compareLiquidity(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const left = Number(a);
  const right = Number(b);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return 0;
  return left - right;
}

function extractPairs(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object" && Array.isArray((body as { pairs?: unknown }).pairs)) {
    return (body as { pairs: unknown[] }).pairs;
  }
  return null;
}

function solanaMints(body: unknown): string[] {
  if (!Array.isArray(body)) return [];
  const mints: string[] = [];
  for (const item of body) {
    if (!item || typeof item !== "object") continue;
    const row = item as { chainId?: unknown; tokenAddress?: unknown };
    if (row.chainId === "solana" && typeof row.tokenAddress === "string" && row.tokenAddress.length > 20) {
      mints.push(row.tokenAddress);
    }
  }
  return unique(mints);
}

function solanaMintsFromPairs(body: unknown): string[] {
  const pairs = extractPairs(body);
  if (!pairs) return [];
  const mints: string[] = [];
  for (const item of pairs) {
    const parsed = parseDexPair(item);
    if (parsed) mints.push(parsed.baseAddress);
  }
  return unique(mints);
}

async function readJson(
  fetchImpl: typeof fetch,
  url: string,
): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  try {
    const response = await fetchImpl(url, { headers: { accept: "application/json" } });
    if (!response.ok) return { ok: false, error: `DexScreener HTTP ${response.status} for ${url}` };
    return { ok: true, body: await response.json() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "DexScreener request failed" };
  }
}

function token(value: unknown): { address: string; symbol: string; name: string } | null {
  if (!value || typeof value !== "object") return null;
  const row = value as { address?: unknown; symbol?: unknown; name?: unknown };
  if (typeof row.address !== "string" || typeof row.symbol !== "string") return null;
  return {
    address: row.address,
    symbol: row.symbol,
    name: typeof row.name === "string" ? row.name : row.symbol,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
