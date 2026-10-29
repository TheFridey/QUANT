#!/usr/bin/env node
/**
 * Opt-in Alpaca practice-broker verification (§14 / Gate 2 / §26).
 *
 * Does NOT place orders unless PRACTICE_BROKER_SUBMIT=I_UNDERSTAND_DEMO_ORDERS.
 * Missing credentials → exit 3 with ok:false + BLOCKED_EXTERNAL (not a silent pass).
 * Transport/host/account failures → nonzero exit with ok:false.
 *
 * Usage:
 *   node scripts/verify-practice-broker.mjs
 *   PRACTICE_BROKER_SUBMIT=I_UNDERSTAND_DEMO_ORDERS node scripts/verify-practice-broker.mjs
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distPath = resolve(__dirname, "../packages/market-data/dist/practice-broker.js");
const srcPath = resolve(__dirname, "../packages/market-data/src/practice-broker.ts");

async function loadBroker() {
  if (existsSync(distPath)) {
    return import(pathToFileURL(distPath).href);
  }
  // Dev path: register tsx if available, else fail with clear message.
  try {
    const require = createRequire(import.meta.url);
    require("tsx/cjs");
    return import(pathToFileURL(srcPath).href);
  } catch {
    // Fallback: dynamic import via vitest-less compiled alias is unavailable.
    // Import through workspace package entry after build.
    return import("@odin/market-data");
  }
}

async function main() {
  const mod = await loadBroker();
  const AlpacaPracticeBroker = mod.AlpacaPracticeBroker;
  if (!AlpacaPracticeBroker) {
    console.log(JSON.stringify({ ok: false, error: "AlpacaPracticeBroker export missing — run pnpm build:packages" }, null, 2));
    process.exit(1);
  }

  const broker = AlpacaPracticeBroker.fromEnv(process.env);
  const readiness = broker.readiness();
  const caps = broker.capabilities();
  const host = broker.validatePracticeHost();

  if (readiness === "MISSING_CREDENTIALS") {
    console.log(
      JSON.stringify(
        {
          ok: false,
          blocked: "BLOCKED_EXTERNAL",
          readiness,
          requiredEnv: ["ALPACA_API_KEY_ID", "ALPACA_API_SECRET_KEY"],
          optionalEnv: ["ALPACA_PAPER_BASE_URL"],
          command: "ALPACA_API_KEY_ID=… ALPACA_API_SECRET_KEY=… node scripts/verify-practice-broker.mjs",
          note: "HTTP transport is implemented; credentialed network proof is owner-gated.",
        },
        null,
        2,
      ),
    );
    process.exit(3);
  }

  if (!host.ok) {
    console.log(JSON.stringify({ ok: false, readiness, host }, null, 2));
    process.exit(2);
  }

  const shaped = broker.shapeOrder({
    clientOrderId: `verify_${Date.now()}`,
    symbol: "SPY",
    side: "buy",
    qty: "1",
    type: "market",
    timeInForce: "day",
  });

  const account = await broker.getAccount();
  const allowSubmit = process.env.PRACTICE_BROKER_SUBMIT === "I_UNDERSTAND_DEMO_ORDERS";
  let submit = null;
  if (allowSubmit && shaped.ok) {
    submit = await broker.submitOrder({
      clientOrderId: shaped.value.clientOrderId,
      symbol: "SPY",
      side: "buy",
      qty: "1",
      type: "market",
      timeInForce: "day",
    });
  }

  const ok =
    shaped.ok === true &&
    account.ok === true &&
    (allowSubmit ? submit?.ok === true : true);

  console.log(
    JSON.stringify(
      {
        ok,
        readiness,
        host,
        capabilities: caps,
        shaped,
        account,
        submit,
        submitAttempted: allowSubmit,
        note: allowSubmit
          ? "Submit attempted against practice host"
          : "Account+shape verified; set PRACTICE_BROKER_SUBMIT=I_UNDERSTAND_DEMO_ORDERS to place a demo order",
      },
      null,
      2,
    ),
  );
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
