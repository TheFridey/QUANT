import type { NormalizedPair } from "@odin/shared";
import { decimalStringFromJson, intFromJson } from "./numbers.js";
import type { ProviderResult } from "./provider.js";

/** Paid/promoted boosts — optional supplement only; never the sole discovery source. */
export const DEXSCREENER_BOOSTS_URL = "https://api.dexscreener.com/token-boosts/top/v1";
/** Organic latest token profiles (not paid boosts). */
export const DEXSCREENER_PROFILES_URL = "https://api.dexscreener.com/token-profiles/latest/v1";
/**
 * Public text search — supplement only. A "solana" query matches pair metadata, so it mostly
 * returns dead pools whose base token merely *calls itself* SOL; every result is validated.
 */
export const DEXSCREENER_SEARCH_URL = "https://api.dexscreener.com/latest/dex/search?q=solana";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

/**
 * Canonical mints for symbols that counterfeit tokens commonly impersonate. A pair whose base or
 * quote claims one of these symbols under a different mint is rejected as an impersonation.
 */
export const CANONICAL_SYMBOL_MINTS: Readonly<Record<string, string>> = {
  SOL: WSOL_MINT,
  WSOL: WSOL_MINT,
  USDC: USDC_MINT,
  USDT: USDT_MINT,
};

/**
 * Established, actively traded Solana mints queried every cycle so the universe keeps a stable,
 * history-accumulating core even when organic profiles churn. Addresses verified against
 * DexScreener's token endpoint (2026-10-31). Inclusion is discovery only — never an entry signal.
 */
export const SOLANA_ANCHOR_MINTS = [
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", // JUP
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", // BONK
  "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", // WIF
  "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL", // JTO
  "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3", // PYTH
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S6iCLDgmPjDXUa", // RAY
] as const;

/** Stablecoin bases are not momentum targets (and duplicate the inverted SOL market). */
const STABLE_BASE_MINTS = new Set<string>([USDC_MINT, USDT_MINT]);
/** tokens/v1 accepts at most 30 comma-separated addresses. */
const TOKENS_BATCH_LIMIT = 30;
/**
 * Reported liquidity above this multiple of 24h volume is treated as implausible: spoofed pools
 * report billions of "liquidity" against double-digit daily volume. Discovery hygiene only.
 */
const MAX_LIQUIDITY_TO_VOLUME_RATIO = 1000;

export function dexscreenerTokensUrl(addresses: string[]): string {
  return `https://api.dexscreener.com/tokens/v1/solana/${addresses.join(",")}`;
}

/** All pairs for one token (tokens/v1 returns only a single pair per token). */
export function dexscreenerTokenPairsUrl(address: string): string {
  return `https://api.dexscreener.com/token-pairs/v1/solana/${address}`;
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
    // DexScreener omits a window's key when the pair had no trades in it: that stays null
    // (unavailable), never 0%.
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

export type DiscoveryRejection =
  | "IMPERSONATED_SYMBOL"
  | "STABLE_BASE"
  | "MISSING_PRICE"
  | "INACTIVE"
  | "LIQUIDITY_IMPLAUSIBLE";

/** Why a parsed pair is unsuitable for the trading universe, or null when it is usable. */
export function discoveryRejection(pair: NormalizedPair): DiscoveryRejection | null {
  const baseCanonical = CANONICAL_SYMBOL_MINTS[pair.baseSymbol.trim().toUpperCase()];
  const quoteCanonical = CANONICAL_SYMBOL_MINTS[pair.quoteSymbol.trim().toUpperCase()];
  if (baseCanonical !== undefined && baseCanonical !== pair.baseAddress) return "IMPERSONATED_SYMBOL";
  if (quoteCanonical !== undefined && quoteCanonical !== pair.quoteAddress) return "IMPERSONATED_SYMBOL";
  if (STABLE_BASE_MINTS.has(pair.baseAddress)) return "STABLE_BASE";
  if (pair.priceUsd === null || !(Number(pair.priceUsd) > 0)) return "MISSING_PRICE";
  const volume = pair.volume24hUsd === null ? 0 : Number(pair.volume24hUsd);
  if (!(volume > 0) || tradeCount(pair.raw) === 0) return "INACTIVE";
  const liquidity = pair.liquidityUsd === null ? null : Number(pair.liquidityUsd);
  if (liquidity !== null && liquidity > volume * MAX_LIQUIDITY_TO_VOLUME_RATIO) return "LIQUIDITY_IMPLAUSIBLE";
  return null;
}

export type DiscoveryReport = {
  sources: Record<"anchorPairs" | "anchorTokens" | "profiles" | "boosts" | "search" | "discoveredTokens", "ok" | "failed" | "skipped">;
  candidates: number;
  rejected: Partial<Record<DiscoveryRejection, number>>;
  duplicatesCollapsed: number;
  selected: number;
};

export type SolanaUniverseResult = ProviderResult<NormalizedPair[]> & { discovery?: DiscoveryReport };

/**
 * Solana universe discovery.
 * Sources: all WSOL pairs (token-pairs), anchor mints and organic profile mints enriched via
 * tokens/v1, optional paid boosts, and text search as a supplement. Every candidate is validated
 * (canonical mints, real trading activity, plausible liquidity), collapsed to the most active pair
 * per base mint, and ranked by 24h volume rather than reported liquidity.
 */
export async function fetchSolanaUniverse(options: {
  limit: number;
  fetchImpl?: typeof fetch;
  now?: Date;
  /** When false, skip paid boosts endpoint entirely. Default true (supplement only). */
  includeBoosts?: boolean;
}): Promise<SolanaUniverseResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const fetchedAt = (options.now ?? new Date()).toISOString();
  const includeBoosts = options.includeBoosts !== false;

  const [anchorPairs, anchorTokens, profiles, search, boosts] = await Promise.all([
    readJson(fetchImpl, dexscreenerTokenPairsUrl(WSOL_MINT)),
    readJson(fetchImpl, dexscreenerTokensUrl([...SOLANA_ANCHOR_MINTS])),
    readJson(fetchImpl, DEXSCREENER_PROFILES_URL),
    readJson(fetchImpl, DEXSCREENER_SEARCH_URL),
    includeBoosts ? readJson(fetchImpl, DEXSCREENER_BOOSTS_URL) : Promise.resolve(SKIPPED),
  ]);

  const known = new Set<string>([WSOL_MINT, ...SOLANA_ANCHOR_MINTS]);
  const discoveredMints = unique([
    ...solanaMints(profiles.ok ? profiles.body : null),
    ...(boosts.ok ? solanaMints(boosts.body) : []),
  ]).filter((mint) => !known.has(mint)).slice(0, TOKENS_BATCH_LIMIT);
  const discoveredTokens =
    discoveredMints.length > 0 ? await readJson(fetchImpl, dexscreenerTokensUrl(discoveredMints)) : SKIPPED;

  const responses = { anchorPairs, anchorTokens, profiles, boosts, search, discoveredTokens };
  const sources = Object.fromEntries(
    Object.entries(responses).map(([name, response]) => [name, response === SKIPPED ? "skipped" : response.ok ? "ok" : "failed"]),
  ) as DiscoveryReport["sources"];

  const pairBodies = [anchorPairs, anchorTokens, discoveredTokens, search];
  if (pairBodies.every((response) => !response.ok)) {
    const failure = pairBodies.find((response): response is { ok: false; error: string } => !response.ok && response !== SKIPPED);
    return { ok: false, code: "UPSTREAM", error: failure?.error ?? "DexScreener returned no pair data" };
  }

  const parsed = new Map<string, NormalizedPair>();
  for (const response of pairBodies) {
    if (!response.ok) continue;
    for (const item of extractPairs(response.body) ?? []) {
      const pair = parseDexPair(item);
      if (pair && !parsed.has(pair.pairAddress)) parsed.set(pair.pairAddress, pair);
    }
  }

  const rejected: DiscoveryReport["rejected"] = {};
  const bestByBase = new Map<string, NormalizedPair>();
  let usable = 0;
  for (const pair of parsed.values()) {
    const reason = discoveryRejection(pair);
    if (reason) {
      rejected[reason] = (rejected[reason] ?? 0) + 1;
      continue;
    }
    usable += 1;
    const current = bestByBase.get(pair.baseAddress);
    if (!current || preferPair(pair, current)) bestByBase.set(pair.baseAddress, pair);
  }

  const data = [...bestByBase.values()].sort(compareActivity).slice(0, options.limit);
  const discovery: DiscoveryReport = {
    sources,
    candidates: parsed.size,
    rejected,
    duplicatesCollapsed: usable - bestByBase.size,
    selected: data.length,
  };
  if (data.length === 0) {
    return { ok: false, code: "INVALID", error: "DexScreener returned no usable Solana pairs", discovery };
  }
  return { ok: true, fetchedAt, data, discovery };
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
  const tokens = calls.some((url) => url.includes("/token-pairs/v1/") || url.includes("/tokens/v1/"));
  return { profiles, search, boosts, organicPrimary: profiles || search || tokens };
}

const SKIPPED = { ok: false as const, error: "skipped" };

/** Same base mint: a USD/SOL-quoted pair beats any other quote, then the more active pair wins. */
function preferPair(candidate: NormalizedPair, current: NormalizedPair): boolean {
  const candidateQuote = isSettlementQuote(candidate.quoteAddress);
  const currentQuote = isSettlementQuote(current.quoteAddress);
  if (candidateQuote !== currentQuote) return candidateQuote;
  return compareActivity(candidate, current) < 0;
}

function isSettlementQuote(address: string): boolean {
  return address === WSOL_MINT || address === USDC_MINT || address === USDT_MINT;
}

/** Descending 24h volume, then liquidity, then pair address for a deterministic order. */
function compareActivity(left: NormalizedPair, right: NormalizedPair): number {
  const volume = numberOrZero(right.volume24hUsd) - numberOrZero(left.volume24hUsd);
  if (volume !== 0) return volume;
  const liquidity = numberOrZero(right.liquidityUsd) - numberOrZero(left.liquidityUsd);
  if (liquidity !== 0) return liquidity;
  return left.pairAddress.localeCompare(right.pairAddress);
}

function numberOrZero(value: string | null): number {
  if (value === null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Buys + sells across every reported window; null when the payload carries no txn counts. */
function tradeCount(raw: unknown): number | null {
  const txns = record(record(raw)?.txns);
  if (!txns) return null;
  let total: number | null = null;
  for (const window of ["m5", "h1", "h6", "h24"]) {
    const row = record(txns[window]);
    if (!row) continue;
    const buys = intFromJson(row.buys) ?? 0;
    const sells = intFromJson(row.sells) ?? 0;
    total = (total ?? 0) + buys + sells;
  }
  return total;
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

const DEXSCREENER_TIMEOUT_MS = 8_000;

async function readJson(
  fetchImpl: typeof fetch,
  url: string,
): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  try {
    const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(DEXSCREENER_TIMEOUT_MS) });
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
