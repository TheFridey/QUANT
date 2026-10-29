#!/usr/bin/env node
/**
 * Credentialed external provider smoke.
 * Usage (after pnpm build:packages):
 *   node --import tsx scripts/verify-external-providers.ts --provider alpaca_paper
 *   node scripts/verify-external-providers.mjs   # or run via vitest offline contracts
 *
 * Preferred offline proof without credentials:
 *   pnpm exec vitest run packages/market-data/src/fx-feed.test.ts
 *
 * Without credentials exits 2 with BLOCKED_EXTERNAL_TEST (adapter code may still be complete).
 */
import {
  AlpacaPaperProvider,
  inventoryAlpacaCredentials,
  inventoryOandaCredentials,
  OandaPracticeProvider,
} from "@odin/market-data";

async function main() {
  const providerArg = process.argv.find((a) => a.startsWith("--provider="))?.split("=")[1]
    ?? process.argv[process.argv.indexOf("--provider") + 1]
    ?? "all";

  let blocked = false;
  let failed = false;

  if (providerArg === "alpaca_paper" || providerArg === "all") {
    const creds = inventoryAlpacaCredentials();
    const provider = new AlpacaPaperProvider(creds);
    const ready = provider.readiness();
    console.log(JSON.stringify({ provider: "alpaca_paper", readiness: ready }, null, 2));
    if (ready !== "READY") {
      console.error("BLOCKED_EXTERNAL_TEST: set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY (paper keys).");
      blocked = true;
    } else {
      const quotes = await provider.getQuotes(["etf:SPY", "etf:QQQ"]);
      console.log(JSON.stringify({ alpaca_quotes_ok: quotes.ok, count: quotes.ok ? quotes.data.length : 0 }, null, 2));
      if (!quotes.ok) failed = true;
    }
  }

  if (providerArg === "oanda_practice" || providerArg === "all") {
    const creds = inventoryOandaCredentials();
    const provider = new OandaPracticeProvider(creds);
    const ready = provider.readiness();
    console.log(JSON.stringify({ provider: "oanda_practice", readiness: ready }, null, 2));
    if (ready !== "READY") {
      console.error("BLOCKED_EXTERNAL_TEST: set OANDA_API_TOKEN and OANDA_ACCOUNT_ID (fxpractice).");
      blocked = true;
    } else {
      const quotes = await provider.getQuotes(["fx:EURUSD", "fx:GBPUSD"]);
      console.log(JSON.stringify({ oanda_quotes_ok: quotes.ok, count: quotes.ok ? quotes.data.length : 0 }, null, 2));
      if (!quotes.ok) failed = true;
    }
  }

  if (failed) process.exit(1);
  if (blocked) process.exit(2);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
