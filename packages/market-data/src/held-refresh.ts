import type { NormalizedPair } from "@odin/shared";
import { parseDexPair, dexscreenerTokensUrl } from "./dexscreener.js";
import type { ProviderResult } from "./provider.js";

/**
 * Independent refresh for held / pending / protected instruments (R02).
 * Discovery universe is NOT sufficient — marks for open risk must be fetched
 * even when the instrument left the discovery set. Provider outages must not
 * pretend old stored marks are fresh.
 */

export type MandatoryMarkTarget = {
  pairAddress: string;
  /** Solana base mint when known — used for DexScreener tokens endpoint. */
  baseAddress?: string | null;
};

export async function fetchMandatorySolanaMarks(options: {
  targets: MandatoryMarkTarget[];
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<
  ProviderResult<NormalizedPair[]> & {
    /** Addresses requested but not returned by the provider (outage / delist). */
    missing: string[];
    fetchedAddresses: string[];
  }
> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const fetchedAt = (options.now ?? new Date()).toISOString();
  const solanaTargets = options.targets.filter(
    (t) => !t.pairAddress.includes(":") || t.pairAddress.length >= 32,
  );
  // Multi-market ids (fx:/etf:/commodity:) are refreshed by their own providers — not here.
  const multiMarket = options.targets.filter((t) => /^(fx|etf|commodity|index):/.test(t.pairAddress));

  if (solanaTargets.length === 0) {
    return {
      ok: true,
      fetchedAt,
      data: [],
      missing: multiMarket.map((t) => t.pairAddress),
      fetchedAddresses: [],
    };
  }

  // DexScreener tokens endpoint is mint-keyed; fall back to pairs lookup by address via search.
  const mints = [
    ...new Set(
      solanaTargets
        .map((t) => t.baseAddress)
        .filter((m): m is string => typeof m === "string" && m.length > 20),
    ),
  ];
  const byAddress = new Map<string, NormalizedPair>();

  if (mints.length > 0) {
    for (let i = 0; i < mints.length; i += 30) {
      const chunk = mints.slice(i, i + 30);
      const result = await readJson(fetchImpl, dexscreenerTokensUrl(chunk));
      if (!result.ok) {
        return {
          ok: false as const,
          code: "UPSTREAM" as const,
          error: result.error,
          missing: solanaTargets.map((t) => t.pairAddress),
          fetchedAddresses: [],
        };
      }
      const list = extractPairs(result.body);
      for (const item of list ?? []) {
        const parsed = parseDexPair(item);
        if (parsed) byAddress.set(parsed.pairAddress, parsed);
      }
    }
  }

  // Pair-address direct fetch for holdings whose mint was unknown.
  const stillMissing = solanaTargets.filter((t) => !byAddress.has(t.pairAddress));
  for (const target of stillMissing.slice(0, 20)) {
    const url = `https://api.dexscreener.com/latest/dex/pairs/solana/${target.pairAddress}`;
    const result = await readJson(fetchImpl, url);
    if (!result.ok) continue;
    const list = extractPairs(result.body);
    for (const item of list ?? []) {
      const parsed = parseDexPair(item);
      if (parsed) byAddress.set(parsed.pairAddress, parsed);
    }
  }

  const data = solanaTargets
    .map((t) => byAddress.get(t.pairAddress))
    .filter((p): p is NormalizedPair => Boolean(p));
  const fetchedAddresses = data.map((p) => p.pairAddress);
  const missing = [
    ...solanaTargets.filter((t) => !byAddress.has(t.pairAddress)).map((t) => t.pairAddress),
    // Multi-market mandatory marks must be fetched by FX/ETF providers separately.
    ...multiMarket.map((t) => t.pairAddress),
  ];

  return {
    ok: true,
    fetchedAt,
    data,
    missing,
    fetchedAddresses,
  };
}

async function readJson(
  fetchImpl: typeof fetch,
  url: string,
): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  try {
    const response = await fetchImpl(url, { headers: { accept: "application/json" } });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status} for ${url}` };
    return { ok: true, body: await response.json() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "request failed" };
  }
}

function extractPairs(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    const row = body as { pairs?: unknown; pair?: unknown };
    if (Array.isArray(row.pairs)) return row.pairs;
    if (row.pair) return [row.pair];
  }
  return null;
}
