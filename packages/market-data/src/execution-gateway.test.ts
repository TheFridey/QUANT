import { describe, expect, it } from "vitest";
import {
  SandboxExecutionGateway,
  LocalPaperExecutionGateway,
  allowsLocalPaperBooking,
  createExecutionGateway,
} from "./execution-gateway.js";

describe("ExecutionGateway (D09)", () => {
  it("PAPER gateway allows local booking and admits submit", async () => {
    const gateway = new LocalPaperExecutionGateway();
    expect(gateway.readiness()).toBe("READY");
    expect(allowsLocalPaperBooking(gateway)).toBe(true);
    const ack = await gateway.submitOrder({
      clientOrderId: "c1",
      instrumentId: "etf:SPY",
      side: "BUY",
      qty: "1",
    });
    expect(ack.ok).toBe(true);
    if (ack.ok) expect(ack.venue).toBe("PAPER");
  });

  it("SANDBOX without credentials is MISSING_CREDENTIALS and refuses local PAPER", async () => {
    const gateway = new SandboxExecutionGateway({
      alpacaKeyPresent: false,
      oandaTokenPresent: false,
    });
    expect(gateway.readiness()).toBe("MISSING_CREDENTIALS");
    expect(allowsLocalPaperBooking(gateway)).toBe(false);
    const ack = await gateway.submitOrder({
      clientOrderId: "c1",
      instrumentId: "fx:EURUSD",
      side: "BUY",
      qty: "1000",
    });
    expect(ack.ok).toBe(false);
    if (!ack.ok) {
      expect(ack.code).toBe("BLOCKED_EXTERNAL_TEST");
      expect(ack.readiness).toBe("MISSING_CREDENTIALS");
    }
  });

  it("SANDBOX with keys still NOT_IMPLEMENTED — never fake READY or book PAPER", async () => {
    const gateway = new SandboxExecutionGateway({
      alpacaKeyPresent: true,
      oandaTokenPresent: true,
    });
    expect(gateway.readiness()).toBe("NOT_IMPLEMENTED");
    expect(allowsLocalPaperBooking(gateway)).toBe(false);
    const caps = gateway.capabilities();
    expect(caps.submit).toBe(false);
    expect(caps.reconcile).toBe(false);
    const ack = await gateway.submitOrder({
      clientOrderId: "c2",
      instrumentId: "etf:SPY",
      side: "BUY",
      qty: "1",
    });
    expect(ack.ok).toBe(false);
    if (!ack.ok) {
      expect(ack.code).toBe("NOT_IMPLEMENTED");
      expect(ack.error).toMatch(/must not book local PAPER/i);
    }
  });

  it("createExecutionGateway routes SANDBOX vs PAPER from mode", () => {
    const paper = createExecutionGateway("PAPER", {});
    expect(paper.mode).toBe("PAPER");
    expect(allowsLocalPaperBooking(paper)).toBe(true);

    const sandbox = createExecutionGateway("SANDBOX", {});
    expect(sandbox.mode).toBe("SANDBOX");
    expect(sandbox.readiness()).toBe("MISSING_CREDENTIALS");
    expect(allowsLocalPaperBooking(sandbox)).toBe(false);
  });
});
