import { describe, expect, it } from "vitest";
import {
  AlpacaPracticeBroker,
  classifyAmbiguousSubmit,
  createUnknownOutcome,
} from "./practice-broker.js";

describe("§14 Alpaca practice broker adapter", () => {
  it("reports MISSING_CREDENTIALS and blocks lifecycle without keys", async () => {
    const broker = new AlpacaPracticeBroker({
      apiKeyId: "",
      apiSecretKey: "",
      baseUrl: "https://paper-api.alpaca.markets",
    });
    expect(broker.readiness()).toBe("MISSING_CREDENTIALS");
    expect(broker.capabilities().practiceHostEnforcement).toBe(true);
    expect(broker.capabilities().orders).toBe(false);
    const submit = await broker.submitOrder({
      clientOrderId: "c1",
      symbol: "SPY",
      side: "buy",
      qty: "1",
      type: "market",
      timeInForce: "day",
    });
    expect(submit.ok).toBe(false);
    if (!submit.ok) {
      expect(submit.code).toBe("MISSING_CREDENTIALS");
      expect(submit.error).toMatch(/BLOCKED_EXTERNAL/);
    }
  });

  it("enforces practice host allowlist", () => {
    const live = new AlpacaPracticeBroker({
      apiKeyId: "k",
      apiSecretKey: "s",
      baseUrl: "https://api.alpaca.markets",
    });
    expect(live.readiness()).toBe("INVALID_CONFIGURATION");
    expect(live.validatePracticeHost().ok).toBe(false);
  });

  it("shapes idempotent client_order_id body (offline contract)", () => {
    const broker = new AlpacaPracticeBroker(
      {
        apiKeyId: "k",
        apiSecretKey: "s",
        baseUrl: "https://paper-api.alpaca.markets",
      },
      { offline: { account: { id: "paper", cash: "100000", buyingPower: "100000", currency: "USD" } } },
    );
    const shaped = broker.shapeOrder({
      clientOrderId: "intent_abc",
      symbol: "SPY",
      side: "buy",
      qty: "2",
      type: "market",
      timeInForce: "day",
    });
    expect(shaped.ok).toBe(true);
    if (shaped.ok) {
      expect(shaped.value.path).toBe("/v2/orders");
      expect(shaped.value.body.client_order_id).toBe("intent_abc");
    }
  });

  it("offline lifecycle: submit → lookup → cancel → reconcile; idempotent resubmit", async () => {
    const orders = new Map();
    const broker = new AlpacaPracticeBroker(
      {
        apiKeyId: "k",
        apiSecretKey: "s",
        baseUrl: "https://paper-api.alpaca.markets",
      },
      {
        offline: {
          account: { id: "paper", cash: "100000", buyingPower: "200000", currency: "USD" },
          orders,
        },
      },
    );
    expect(broker.readiness()).toBe("READY");
    const first = await broker.submitOrder({
      clientOrderId: "c_idem",
      symbol: "SPY",
      side: "buy",
      qty: "1",
      type: "market",
      timeInForce: "day",
    });
    const again = await broker.submitOrder({
      clientOrderId: "c_idem",
      symbol: "SPY",
      side: "buy",
      qty: "1",
      type: "market",
      timeInForce: "day",
    });
    expect(first.ok && again.ok).toBe(true);
    if (first.ok && again.ok) {
      expect(again.value.brokerOrderId).toBe(first.value.brokerOrderId);
    }
    const lookup = await broker.lookupOrder("c_idem");
    expect(lookup.ok).toBe(true);
    const cancel = await broker.cancelOrder("c_idem");
    expect(cancel.ok).toBe(true);
    const recon = await broker.reconcile();
    expect(recon.ok).toBe(true);
    if (recon.ok) expect(recon.value.drift).toBe(false);
  });
});

describe("§15 unknown outcomes", () => {
  it("tracks unresolved outcomes with reservation safety flag", () => {
    const row = createUnknownOutcome({
      clientOrderId: "c1",
      accountId: "primary",
      instrumentId: "etf:SPY",
      detail: "timeout after submit",
    });
    expect(row.state).toBe("unknown");
    expect(row.reservationHeld).toBe(true);
    expect(row.operatorVisible).toBe(true);
  });

  it("classifies ambiguous submit: not-found → idempotent retry; unknown → reconcile-before-resubmit", () => {
    expect(
      classifyAmbiguousSubmit({
        ok: false,
        code: "NOT_FOUND",
        error: "missing",
        retryClass: "idempotent_retry",
      }).action,
    ).toBe("idempotent_retry");
    expect(
      classifyAmbiguousSubmit({
        ok: true,
        value: { status: "unknown" },
      }).action,
    ).toBe("reconcile_before_resubmit");
    expect(
      classifyAmbiguousSubmit({
        ok: true,
        value: { status: "filled" },
      }).action,
    ).toBe("complete");
  });
});
