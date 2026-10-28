#!/usr/bin/env node
/**
 * Credentialed external provider smoke (after pnpm build:packages).
 *
 *   node scripts/verify-external-providers.mjs --provider alpaca_paper
 *   node scripts/verify-external-providers.mjs --provider oanda_practice
 *   node scripts/verify-external-providers.mjs --provider all
 *
 * Offline contracts (no credentials required):
 *   pnpm exec vitest run packages/market-data/src/fx-feed.test.ts
 *
 * Exit 2 = BLOCKED_EXTERNAL_TEST (missing credentials).
 * Exit 1 = provider call failed while READY.
 */
import {
  AlpacaPaperProvider,
  inventoryAlpacaCredentials,
  inventoryOandaCredentials,
  OandaPracticeProvider,
} from "../packages/market-data/dist/index.js";

async function main() {
  const providerArg =
    process.argv.find((a) => a.startsWith("--provider="))?.split("=")[1] ??
    (process.argv.includes("--provider")
      ? process.argv[process.argv.indexOf("--provider") + 1]
      : "all");

  let blocked = false;
  let failed = false;

  if (providerArg === "alpaca_paper" || providerArg === "all") {
    const creds = inventoryAlpacaCredentials();
    const provider = new AlpacaPaperProvider(creds);
    const ready = provider.readiness();
    console.log(JSON.stringify({ provider: "alpaca_paper", readiness: ready }, null, 2));
    if (ready !== "READY") {
      console.error(
        "BLOCKED_EXTERNAL_TEST: set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY (paper keys).",
      );
      blocked = true;
    } else {
      const quotes = await provider.getQuotes(["etf:SPY", "etf:QQQ"]);
      console.log(
        JSON.stringify(
          { alpaca_quotes_ok: quotes.ok, count: quotes.ok ? quotes.data.length : 0 },
          null,
          2,
        ),
      );
      if (!quotes.ok) failed = true;
    }
  }

  if (providerArg === "oanda_practice" || providerArg === "all") {
    const creds = inventoryOandaCredentials();
    const provider = new OandaPracticeProvider(creds);
    const ready = provider.readiness();
    console.log(JSON.stringify({ provider: "oanda_practice", readiness: ready }, null, 2));
    if (ready !== "READY") {
      console.error(
        "BLOCKED_EXTERNAL_TEST: set OANDA_API_TOKEN and OANDA_ACCOUNT_ID (fxpractice).",
      );
      blocked = true;
    } else {
      const quotes = await provider.getQuotes(["fx:EURUSD", "fx:GBPUSD"]);
      console.log(
        JSON.stringify(
          { oanda_quotes_ok: quotes.ok, count: quotes.ok ? quotes.data.length : 0 },
          null,
          2,
        ),
      );
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
