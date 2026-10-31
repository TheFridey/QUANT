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
import type { ProviderReadiness } from "@odin/shared";

type ReadOnlyProvider = {
  readiness(): ProviderReadiness;
  getQuotes(instrumentIds: string[]): ReturnType<AlpacaPaperProvider["getQuotes"]>;
};

/**
 * Keys present but unproven report CONNECTING. That is not "missing credentials": make one
 * read-only quote request (never an order) and report the readiness it proves.
 */
async function verifyReadOnly(
  name: string,
  provider: ReadOnlyProvider,
  instrumentIds: string[],
): Promise<ProviderReadiness | "QUOTES_FAILED"> {
  const initial = provider.readiness();
  if (initial === "MISSING_CREDENTIALS" || initial === "INVALID_CONFIGURATION") {
    console.log(JSON.stringify({ provider: name, readiness: initial }, null, 2));
    return initial;
  }
  const quotes = await provider.getQuotes(instrumentIds);
  const readiness = provider.readiness();
  console.log(
    JSON.stringify(
      {
        provider: name,
        initialReadiness: initial,
        readiness,
        quotesOk: quotes.ok,
        count: quotes.ok ? quotes.data.length : 0,
        error: quotes.ok ? null : quotes.error,
      },
      null,
      2,
    ),
  );
  return quotes.ok ? readiness : readiness === "READY" ? "QUOTES_FAILED" : readiness;
}

async function main() {
  const providerArg = process.argv.find((a) => a.startsWith("--provider="))?.split("=")[1]
    ?? process.argv[process.argv.indexOf("--provider") + 1]
    ?? "all";

  let blocked = false;
  let failed = false;

  if (providerArg === "alpaca_paper" || providerArg === "all") {
    const creds = inventoryAlpacaCredentials();
    const provider = new AlpacaPaperProvider(creds);
    const outcome = await verifyReadOnly("alpaca_paper", provider, ["etf:SPY", "etf:QQQ"]);
    if (outcome === "MISSING_CREDENTIALS") {
      console.error("BLOCKED_EXTERNAL_TEST: set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY (paper keys).");
      blocked = true;
    } else if (outcome !== "READY") {
      failed = true;
    }
  }

  if (providerArg === "oanda_practice" || providerArg === "all") {
    const creds = inventoryOandaCredentials();
    const provider = new OandaPracticeProvider(creds);
    const outcome = await verifyReadOnly("oanda_practice", provider, ["fx:EURUSD", "fx:GBPUSD"]);
    if (outcome === "MISSING_CREDENTIALS") {
      console.error("BLOCKED_EXTERNAL_TEST: set OANDA_API_TOKEN and OANDA_ACCOUNT_ID (fxpractice).");
      blocked = true;
    } else if (outcome !== "READY") {
      failed = true;
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
