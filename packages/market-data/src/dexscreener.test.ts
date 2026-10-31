import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  discoveryRejection,
  discoverySourcesUsed,
  fetchSolanaUniverse,
  parseDexPair,
  SOLANA_ANCHOR_MINTS,
  USDC_MINT,
  WSOL_MINT,
} from "./dexscreener.js";

const fixture = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/sol-usdc.json"), "utf8"),
) as unknown;

describe("DexScreener parser", () => {
  it("parses a captured SOL/USDC payload without coercing priceUsd from a number", () => {
    const parsed = parseDexPair(fixture);
    expect(parsed?.priceUsd).toBe("100.97");
    expect(parsed?.baseSymbol).toBe("SOL");
    expect(parsed?.quoteSymbol).toBe("USDC");
    expect(parsed?.source).toBe("dexscreener");
    expect(parsed?.txnsM5Buys).toBe(244);
    expect(parseDexPair({ ...fixture as object, priceUsd: 100.97 })?.priceUsd).toBeNull();
  });

  it("returns upstream failure and no pairs when every request fails", async () => {
    const result = await fetchSolanaUniverse({
      limit: 5,
      fetchImpl: async () => new Response("no", { status: 503 }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("UPSTREAM");
  });

  it("discovers via organic profiles/search without requiring paid boosts", async () => {
    const calls: string[] = [];
    const result = await fetchSolanaUniverse({
      limit: 5,
      includeBoosts: true,
      fetchImpl: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("token-boosts")) {
          // Boosts fail — organic must still succeed.
          return new Response("no", { status: 503 });
        }
        if (url.includes("token-profiles")) {
          return Response.json([
            { chainId: "solana", tokenAddress: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" },
          ]);
        }
        if (url.includes("/latest/dex/search")) {
          return Response.json({ pairs: [fixture] });
        }
        return Response.json([fixture]);
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.length).toBeGreaterThan(0);
    const sources = discoverySourcesUsed(calls);
    expect(sources.organicPrimary).toBe(true);
    expect(sources.profiles).toBe(true);
    expect(sources.search).toBe(true);
  });

  it("succeeds with includeBoosts=false using search pairs alone", async () => {
    const calls: string[] = [];
    const result = await fetchSolanaUniverse({
      limit: 5,
      includeBoosts: false,
      fetchImpl: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("token-boosts")) throw new Error("boosts must not be called");
        if (url.includes("token-profiles")) return Response.json([]);
        if (url.includes("/latest/dex/search")) return Response.json({ pairs: [fixture, fixture] });
        return Response.json([fixture]);
      },
    });
    expect(result.ok).toBe(true);
    expect(calls.some((url) => url.includes("token-boosts"))).toBe(false);
  });
});

type DiscoveryFixture = {
  search: { pairs: unknown[] };
  wsolTokenPairs: unknown[];
  anchorTokens: unknown[];
  profiles: unknown[];
  discoveredTokens: unknown[];
};

/** Real (trimmed) DexScreener responses captured 2026-10-31 — see fixtures file note. */
const live = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/dexscreener-discovery-2026-10-31.json"),
    "utf8",
  ),
) as DiscoveryFixture;

function liveFetch(calls: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("token-boosts")) return Response.json([]);
    if (url.includes("token-profiles")) return Response.json(live.profiles);
    if (url.includes("/latest/dex/search")) return Response.json(live.search);
    if (url.includes(`/token-pairs/v1/solana/${WSOL_MINT}`)) return Response.json(live.wsolTokenPairs);
    if (url.includes(`/tokens/v1/solana/${SOLANA_ANCHOR_MINTS[0]}`)) return Response.json(live.anchorTokens);
    if (url.includes("/tokens/v1/solana/")) return Response.json(live.discoveredTokens);
    return new Response("unexpected", { status: 404 });
  }) as typeof fetch;
}

describe("Solana discovery quality (real captured responses)", () => {
  it("rejects every counterfeit SOL pair returned by the text search", async () => {
    for (const item of live.search.pairs) {
      const parsed = parseDexPair(item);
      expect(parsed?.baseSymbol).toBe("SOL");
      expect(parsed?.baseAddress).not.toBe(WSOL_MINT);
      expect(discoveryRejection(parsed!)).toBe("IMPERSONATED_SYMBOL");
    }
  });

  it("selects genuine, active pairs with real momentum fields and canonical mints", async () => {
    const calls: string[] = [];
    const result = await fetchSolanaUniverse({ limit: 24, fetchImpl: liveFetch(calls) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sol = result.data.find((pair) => pair.baseAddress === WSOL_MINT);
    expect(sol?.quoteAddress).toBe(USDC_MINT);
    // The most active SOL/USDC pool wins the per-mint collapse (orca, ~$67.6M 24h volume).
    expect(sol?.pairAddress.startsWith("Czfq3x")).toBe(true);
    expect(sol?.priceChangeM5Pct).not.toBeNull();
    expect(sol?.priceChangeH1Pct).not.toBeNull();
    for (const pair of result.data) {
      expect(discoveryRejection(pair)).toBeNull();
      expect(pair.source).toBe("dexscreener");
    }
    // One pair per base mint — duplicated SOL/USDC pools are collapsed, not traded side by side.
    expect(new Set(result.data.map((pair) => pair.baseAddress)).size).toBe(result.data.length);
    expect(result.discovery?.rejected.IMPERSONATED_SYMBOL).toBe(live.search.pairs.length);
    expect(result.discovery?.duplicatesCollapsed).toBeGreaterThan(0);
    // Ranked by activity (24h volume), not by reported liquidity.
    const volumes = result.data.map((pair) => Number(pair.volume24hUsd));
    expect([...volumes].sort((a, b) => b - a)).toEqual(volumes);
    expect(calls.some((url) => url.includes("/token-pairs/v1/solana/"))).toBe(true);
  });

  it("keeps a missing provider momentum window as null, never 0%", () => {
    const garrett = live.discoveredTokens
      .map((item) => parseDexPair(item))
      .find((pair) => pair?.baseSymbol === "Garrett");
    expect(garrett?.priceChangeM5Pct).toBeNull();
  });

  it("rejects inactive pools and implausible liquidity relative to volume", () => {
    const base = parseDexPair(fixture)!;
    expect(discoveryRejection(base)).toBeNull();
    expect(discoveryRejection({ ...base, volume24hUsd: "0" })).toBe("INACTIVE");
    expect(
      discoveryRejection({ ...base, raw: { txns: { m5: { buys: 0, sells: 0 }, h24: { buys: 0, sells: 0 } } } }),
    ).toBe("INACTIVE");
    expect(discoveryRejection({ ...base, liquidityUsd: "2500000000", volume24hUsd: "48" })).toBe(
      "LIQUIDITY_IMPLAUSIBLE",
    );
    expect(discoveryRejection({ ...base, priceUsd: null })).toBe("MISSING_PRICE");
    expect(
      discoveryRejection({ ...base, baseAddress: USDC_MINT, baseSymbol: "USDC", quoteAddress: WSOL_MINT, quoteSymbol: "SOL" }),
    ).toBe("STABLE_BASE");
  });

  it("still discovers when search and boosts fail (search is a supplement)", async () => {
    const result = await fetchSolanaUniverse({
      limit: 24,
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/latest/dex/search") || url.includes("token-boosts")) return new Response("no", { status: 429 });
        return liveFetch()(input);
      }) as typeof fetch,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.some((pair) => pair.baseAddress === WSOL_MINT)).toBe(true);
      expect(result.discovery?.sources.search).toBe("failed");
    }
  });

  it("fails safely as INVALID when only counterfeit pairs are available", async () => {
    const result = await fetchSolanaUniverse({
      limit: 24,
      includeBoosts: false,
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/latest/dex/search")) return Response.json(live.search);
        if (url.includes("token-profiles")) return Response.json([]);
        return Response.json([]);
      }) as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID");
  });
});
