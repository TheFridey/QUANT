import type { NormalizedPair } from "@odin/shared";
import { decimalStringFromJson, intFromJson } from "./numbers.js";
import type { ProviderResult } from "./provider.js";

export const DEXSCREENER_BOOSTS_URL = "https://api.dexscreener.com/token-boosts/top/v1";
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
    raw: value,
  };
}

export async function fetchSolanaUniverse(options: {
  limit: number;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<ProviderResult<NormalizedPair[]>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const fetchedAt = (options.now ?? new Date()).toISOString();
  const boosts = await readJson(fetchImpl, DEXSCREENER_BOOSTS_URL);
  const discovered = boosts.ok ? solanaMints(boosts.body).slice(0, 29) : [];
  const mints = unique([WSOL_MINT, ...discovered]).slice(0, 30);
  const tokens = await readJson(fetchImpl, dexscreenerTokensUrl(mints));
  if (!tokens.ok) {
    if (mints.length > 1) {
      const anchor = await readJson(fetchImpl, dexscreenerTokensUrl([WSOL_MINT]));
      if (anchor.ok) {
        return { ok: true, fetchedAt, data: rankPairs(anchor.body, options.limit) };
      }
    }
    return { ok: false, code: "UPSTREAM", error: tokens.error };
  }
  const ranked = rankPairs(tokens.body, options.limit);
  if (ranked.length === 0) {
    return { ok: false, code: "INVALID", error: "DexScreener returned no Solana pairs" };
  }
  return { ok: true, fetchedAt, data: ranked };
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
