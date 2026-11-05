import "../load-env.js";
import {
  AlpacaMarketData,
  AlpacaPaperProvider,
  FrankfurterFxProvider,
  OandaPracticeMarketData,
  OandaPracticeProvider,
  inventoryAlpacaCredentials,
  inventoryOandaCredentials,
} from "@odin/market-data";
import { boundedFetch, runMarketProbe, type MarketProbeGateway, type ProbeQuote } from "./market-probe.js";

/**
 * HORIZON market-readiness probe, run by hand. Read-only GETs only, bounded to a handful of requests with a
 * per-request timeout; prints one JSON report and exits. No database, no orders, no config changes.
 *
 *   node dist/src/history/market-probe-cli.js [--timeout-ms 8000]
 *
 * Credentials are read from the environment by name only (OANDA_API_TOKEN, OANDA_ACCOUNT_ID,
 * ALPACA_API_KEY_ID, ALPACA_API_SECRET_KEY); their values are never printed.
 */

function liveProbeGateway(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch, now: () => Date): MarketProbeGateway {
  const oandaCreds = inventoryOandaCredentials(env);
  const alpacaCreds = inventoryAlpacaCredentials(env);
  const oanda = new OandaPracticeMarketData(oandaCreds, { fetchImpl, now, token: () => env.OANDA_API_TOKEN?.trim() ?? "" });
  const alpaca = new AlpacaMarketData(alpacaCreds, {
    fetchImpl,
    now,
    feed: "iex",
    keys: () => ({ keyId: env.ALPACA_API_KEY_ID?.trim() ?? "", secret: env.ALPACA_API_SECRET_KEY?.trim() ?? "" }),
  });
  const frankfurter = new FrankfurterFxProvider({ fetchImpl, now });
  return {
    readiness: () => ({
      oanda_practice: new OandaPracticeProvider(oandaCreds).readiness(),
      alpaca_paper: new AlpacaPaperProvider(alpacaCreds).readiness(),
      frankfurter_fx: frankfurter.readiness(),
    }),
    async oandaAvailability(names) {
      const res = await oanda.availability(names);
      return res.ok ? { ok: true, data: res.data.map(({ instrument, available, reason }) => ({ instrument, available, reason })) } : { ok: false, error: `${res.code}: ${res.error}` };
    },
    async oandaPricing(names) {
      const res = await oanda.pricing(names);
      if (!res.ok) return { ok: false, error: `${res.code}: ${res.error}` };
      const out: Record<string, ProbeQuote> = {};
      for (const p of res.data) out[p.instrument] = { bid: p.bid, ask: p.ask, time: p.time, quality: p.quality };
      return { ok: true, data: out };
    },
    async alpacaQuotes(symbols) {
      const res = await alpaca.latestQuotes(symbols);
      if (!res.ok) return { ok: false, error: `${res.code}: ${res.error}` };
      const out: Record<string, ProbeQuote> = {};
      for (const q of res.data) out[q.symbol] = { bid: q.bid, ask: q.ask, time: q.time, quality: q.quality };
      return { ok: true, data: out };
    },
    async frankfurterQuotes(ids) {
      const res = await frankfurter.getQuotes(ids);
      if (!res.ok) return { ok: false, error: `${res.code}: ${res.error}` };
      const out: Record<string, ProbeQuote> = {};
      for (const q of res.data) {
        if (q.level === null) continue;
        out[q.instrumentId] = { bid: q.bid ?? null, ask: q.ask ?? null, level: q.level, time: q.eventTime ?? null, quality: q.quality ?? null, dataState: q.dataState };
      }
      return { ok: true, data: out };
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf("--timeout-ms");
  const timeoutMs = Math.min(Math.max(Number(i >= 0 ? args[i + 1] : 8000) || 8000, 1000), 30_000);
  const now = () => new Date();
  const report = await runMarketProbe({ gateway: liveProbeGateway(process.env, boundedFetch(timeoutMs), now), now: now() });
  console.log(JSON.stringify(report, null, 2));
}

// Run only as an entry point (the worker compiles to CommonJS); importing it for tests has no side effects.
if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
