#!/usr/bin/env node
/**
 * Opt-in Alpaca practice-broker verification (§14 / Gate 2).
 *
 * Does NOT place orders unless PRACTICE_BROKER_SUBMIT=I_UNDERSTAND_DEMO_ORDERS.
 * Missing credentials → exit 3 with BLOCKED_EXTERNAL (not a code failure).
 *
 * Usage:
 *   node scripts/verify-practice-broker.mjs
 *   PRACTICE_BROKER_SUBMIT=I_UNDERSTAND_DEMO_ORDERS node scripts/verify-practice-broker.mjs
 */
import { AlpacaPracticeBroker } from "../packages/market-data/dist/practice-broker.js";

async function main() {
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
          note: "Lifecycle adapter is implemented; credentialed network proof is owner-gated.",
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

  console.log(
    JSON.stringify(
      {
        ok: true,
        readiness,
        host,
        capabilities: caps,
        shaped,
        submit,
        submitAttempted: allowSubmit,
        note: allowSubmit
          ? "Submit attempted against practice host"
          : "Shape-only; set PRACTICE_BROKER_SUBMIT=I_UNDERSTAND_DEMO_ORDERS to place a demo order",
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
