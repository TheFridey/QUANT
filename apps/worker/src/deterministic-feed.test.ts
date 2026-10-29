import { afterEach, describe, expect, it } from "vitest";
import {
  DETERMINISTIC_FEED_ENV,
  DETERMINISTIC_PAIRS,
  deterministicFeed,
  deterministicPairsAt,
  deterministicStepMs,
  installDeterministicNetworkGuard,
  resolveMarketFeedMode,
} from "./deterministic-feed.js";

const originalEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

describe("deterministic market feed", () => {
  it("defaults to live and refuses non-PAPER deterministic mode", () => {
    delete process.env[DETERMINISTIC_FEED_ENV];
    expect(resolveMarketFeedMode(process.env)).toBe("live");
    process.env.EXECUTION_MODE = "PAPER";
    process.env.LIVE_MONEY_ENABLED = "false";
    process.env[DETERMINISTIC_FEED_ENV] = "deterministic";
    expect(resolveMarketFeedMode(process.env)).toBe("deterministic");
    process.env.EXECUTION_MODE = "SANDBOX";
    expect(() => resolveMarketFeedMode(process.env)).toThrow(/PAPER/);
  });

  it("advances ALPHA through the entry threshold on successive steps", async () => {
    const stepMs = 20_000;
    expect(deterministicStepMs({ [DETERMINISTIC_FEED_ENV]: "deterministic" })).toBe(20_000);
    const flat = deterministicPairsAt(0, new Date(0));
    expect(flat).toHaveLength(DETERMINISTIC_PAIRS.length);
    expect(Number(flat[0]!.priceChangeM5Pct)).toBeCloseTo(0, 5);
    const rally = deterministicPairsAt(2, new Date(stepMs * 2));
    expect(Number(rally[0]!.priceChangeM5Pct)).toBeGreaterThan(2);
    const feed = deterministicFeed({ stepMs, now: () => new Date(stepMs * 2) });
    const universe = await feed.fetchUniverse(10);
    expect(universe.ok).toBe(true);
    if (universe.ok) expect(universe.data[0]!.baseSymbol).toBe("ALPHA");
  });

  it("answers DexScreener-shaped lookups and blocks other outbound hosts", async () => {
    const restore = installDeterministicNetworkGuard({
      stepMs: 20_000,
      now: () => new Date(0),
    });
    try {
      const pairRes = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${DETERMINISTIC_PAIRS[0]!.pairAddress}`);
      const pairBody = (await pairRes.json()) as { pairs: Array<{ pairAddress: string }> };
      expect(pairBody.pairs[0]?.pairAddress).toBe(DETERMINISTIC_PAIRS[0]!.pairAddress);
      await expect(fetch("https://example.com/nope")).rejects.toThrow(/Outbound network disabled/);
    } finally {
      restore();
    }
  });
});
