import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  discoverySourcesUsed,
  fetchSolanaUniverse,
  parseDexPair,
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
