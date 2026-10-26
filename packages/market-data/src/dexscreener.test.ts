import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fetchSolanaUniverse, parseDexPair } from "./dexscreener.js";

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

  it("discovers solana mints and keeps the WSOL anchor", async () => {
    const calls: string[] = [];
    const result = await fetchSolanaUniverse({
      limit: 5,
      fetchImpl: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("token-boosts")) {
          return Response.json([
            { chainId: "solana", tokenAddress: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" },
            { chainId: "ethereum", tokenAddress: "0x0000000000000000000000000000000000000000" },
          ]);
        }
        return Response.json([fixture]);
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toHaveLength(1);
    expect(calls.some((url) => url.includes("So11111111111111111111111111111111111111112"))).toBe(true);
    expect(calls.some((url) => url.includes("JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"))).toBe(true);
  });
});
