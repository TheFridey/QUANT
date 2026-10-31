import type { ProviderResult } from "@odin/market-data";
import { assertPaperOrSandboxOnly, type NormalizedPair } from "@odin/shared";
import type { MarketFeed, OnChainSecuritySource } from "./stage-runner.js";

/**
 * Seeded, network-free Solana-shaped universe for CI and browser E2E (`ODIN_MARKET_FEED=deterministic`).
 * Never enabled by default and refused unless execution is PAPER.
 */
export const DETERMINISTIC_FEED_ENV = "ODIN_MARKET_FEED";
export const DETERMINISTIC_STEP_ENV = "ODIN_DETERMINISTIC_STEP_MS";
export const DETERMINISTIC_PROVIDER_ID = "odin_deterministic_ci";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

type SeedPair = {
  pairAddress: string;
  baseAddress: string;
  baseSymbol: string;
  baseName: string;
  basePriceUsd: number;
  /** Price multipliers per step; the path repeats. */
  path: readonly number[];
};

/**
 * ALPHA rallies through the default 2% entry and 5% take-profit; BRAVO enters then falls through the
 * default 3% stop; CALM never moves (a quiet NO_EDGE pair). One step stands in for one "5m" bar.
 */
export const DETERMINISTIC_PAIRS: readonly SeedPair[] = [
  {
    pairAddress: "CiDetPairA1phaXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    baseAddress: "CiDetMintA1phaXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    baseSymbol: "ALPHA",
    baseName: "Deterministic CI Alpha",
    basePriceUsd: 2,
    path: [1, 1, 1.03, 1.06, 1.09, 1.07, 1.03, 1, 0.97, 1],
  },
  {
    pairAddress: "CiDetPairBravoXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    baseAddress: "CiDetMintBravoXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    baseSymbol: "BRAVO",
    baseName: "Deterministic CI Bravo",
    basePriceUsd: 0.5,
    path: [1, 1, 1.03, 1.02, 0.99, 0.98, 1, 1, 1, 1],
  },
  {
    pairAddress: "CiDetPairCa1mXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    baseAddress: "CiDetMintCa1mXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    baseSymbol: "CALM",
    baseName: "Deterministic CI Calm",
    basePriceUsd: 10,
    path: [1],
  },
];

export type MarketFeedMode = "live" | "deterministic";

export function resolveMarketFeedMode(env: NodeJS.ProcessEnv = process.env): MarketFeedMode {
  const raw = env[DETERMINISTIC_FEED_ENV]?.trim().toLowerCase();
  if (!raw || raw === "live") return "live";
  if (raw !== "deterministic") throw new Error(`${DETERMINISTIC_FEED_ENV} must be "live" or "deterministic" (got "${raw}")`);
  const gate = assertPaperOrSandboxOnly(env);
  if (!gate.ok || gate.mode !== "PAPER") {
    throw new Error(`${DETERMINISTIC_FEED_ENV}=deterministic is refused outside EXECUTION_MODE=PAPER (resolved ${gate.mode}).`);
  }
  return "deterministic";
}

export function deterministicStepMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env[DETERMINISTIC_STEP_ENV]);
  return Number.isFinite(parsed) && parsed >= 1_000 ? parsed : 20_000;
}

function pct(from: number, to: number): string {
  return (((to - from) / from) * 100).toFixed(4);
}

function at<T>(list: readonly T[], index: number): T {
  return list[((index % list.length) + list.length) % list.length]!;
}

export function deterministicPairsAt(step: number, now: Date): NormalizedPair[] {
  return DETERMINISTIC_PAIRS.map((seed) => {
    const current = seed.basePriceUsd * at(seed.path, step);
    const previous = seed.basePriceUsd * at(seed.path, step - 1);
    const m5 = Number(pct(previous, current));
    const rising = m5 > 0;
    const h1 = rising ? Math.max(0.5, m5 / 2).toFixed(4) : m5.toFixed(4);
    return {
      source: "dexscreener",
      chainId: "solana",
      pairAddress: seed.pairAddress,
      dexId: "deterministic",
      url: null,
      baseAddress: seed.baseAddress,
      baseSymbol: seed.baseSymbol,
      baseName: seed.baseName,
      quoteAddress: USDC_MINT,
      quoteSymbol: "USDC",
      priceUsd: current.toFixed(8),
      liquidityUsd: "2500000",
      volume24hUsd: "8000000",
      volume5mUsd: "40000",
      priceChangeM5Pct: m5.toFixed(4),
      priceChangeH1Pct: h1,
      priceChangeH24Pct: "1.0000",
      txnsM5Buys: rising ? 90 : 40,
      txnsM5Sells: rising ? 30 : 60,
      pairCreatedAt: new Date(Date.UTC(2025, 0, 1)).toISOString(),
      fdvUsd: null,
      marketCapUsd: null,
      raw: { providerId: DETERMINISTIC_PROVIDER_ID, deterministicFeed: true, step, eventTime: now.toISOString() },
    };
  });
}

export function deterministicFeed(options: { stepMs: number; now?: () => Date }): MarketFeed {
  const now = options.now ?? (() => new Date());
  return {
    async fetchUniverse(limit: number): Promise<ProviderResult<NormalizedPair[]>> {
      const at = now();
      const step = Math.floor(at.getTime() / options.stepMs);
      return { ok: true, fetchedAt: at.toISOString(), data: deterministicPairsAt(step, at).slice(0, Math.max(0, limit)) };
    },
    security: deterministicSecuritySource(now),
  };
}

/** DexScreener-shaped JSON so the held-mark refresh path parses deterministic marks unchanged. */
function dexShape(pair: NormalizedPair) {
  return {
    chainId: "solana",
    dexId: pair.dexId,
    url: pair.url,
    pairAddress: pair.pairAddress,
    baseToken: { address: pair.baseAddress, name: pair.baseName, symbol: pair.baseSymbol },
    quoteToken: { address: pair.quoteAddress, name: "USD Coin", symbol: pair.quoteSymbol },
    priceUsd: pair.priceUsd,
    liquidity: { usd: Number(pair.liquidityUsd) },
    volume: { h24: Number(pair.volume24hUsd), m5: Number(pair.volume5mUsd) },
    priceChange: { m5: Number(pair.priceChangeM5Pct), h1: Number(pair.priceChangeH1Pct), h24: Number(pair.priceChangeH24Pct) },
    txns: { m5: { buys: pair.txnsM5Buys, sells: pair.txnsM5Sells } },
    pairCreatedAt: Date.parse(pair.pairCreatedAt ?? "2025-01-01T00:00:00Z"),
  };
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Held-mark refresh calls global fetch for DexScreener pair/token lookups. In deterministic mode,
 * answer those from the seeded path and refuse every other non-loopback request so CI never
 * reaches a public network.
 */
export function installDeterministicNetworkGuard(options: {
  stepMs: number;
  now?: () => Date;
  onBlocked?: (url: string) => void;
}): () => void {
  const original = globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const guarded: typeof fetch = async (input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    if (LOOPBACK.has(url.hostname)) return original(input, init);
    if (url.hostname === "api.dexscreener.com") {
      const at = now();
      const pairs = deterministicPairsAt(Math.floor(at.getTime() / options.stepMs), at);
      const pairMatch = url.pathname.match(/^\/latest\/dex\/pairs\/solana\/([^/]+)$/);
      if (pairMatch) {
        const found = pairs.filter((pair) => pair.pairAddress === pairMatch[1]).map(dexShape);
        return Response.json({ pairs: found });
      }
      const tokenMatch = url.pathname.match(/^\/tokens\/v1\/solana\/([^/]+)$/);
      if (tokenMatch) {
        const mints = new Set(decodeURIComponent(tokenMatch[1]!).split(","));
        return Response.json(pairs.filter((pair) => mints.has(pair.baseAddress)).map(dexShape));
      }
    }
    options.onBlocked?.(`${url.protocol}//${url.host}${url.pathname}`);
    throw new TypeError(`Outbound network disabled by ${DETERMINISTIC_FEED_ENV}=deterministic: ${url.host}`);
  };
  globalThis.fetch = guarded;
  return () => {
    globalThis.fetch = original;
  };
}

/**
 * CI/e2e harness only (network-guarded): deterministic mints read as clean SPL Token mints with
 * low holder concentration, so Aegis can PASS them without a network RPC. Never used by liveFeed.
 */
function deterministicSecuritySource(now: () => Date): OnChainSecuritySource {
  return {
    async getMint(mint: string) {
      return {
        ok: true,
        fetchedAt: now().toISOString(),
        data: {
          mint,
          programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
          mintAuthority: null,
          freezeAuthority: null,
          supply: "1000000000000",
          decimals: 9,
          extensions: [],
          slot: null,
        },
      };
    },
    async getTopHolderConcentration() {
      return { ok: true, fetchedAt: now().toISOString(), data: { top10Pct: "12.000000", accountsSampled: 10, slot: null } };
    },
  };
}
