import { describe, expect, it } from "vitest";
import { aggregateProtectionCoverage, derivePositionProtectionCoverage } from "./protection-coverage.js";

describe("protection coverage (R12)", () => {
  it("does not count FAILED historical legs as protected", () => {
    const coverage = derivePositionProtectionCoverage({
      positionKey: "primary:SOL",
      lifecycleId: "lot_1",
      baseQty: "10",
      legs: [
        {
          positionKey: "primary:SOL",
          lifecycleId: "lot_0",
          kind: "STOP",
          origin: "SYNTHETIC_ENGINE",
          status: "FAILED",
          remainingQty: "10",
          protectedQty: "10",
          triggerPriceUsd: "90",
          confirmedTriggerPriceUsd: "90",
        },
        {
          positionKey: "primary:SOL",
          lifecycleId: "lot_1",
          kind: "STOP",
          origin: "SYNTHETIC_ENGINE",
          status: "FAILED",
          remainingQty: "10",
          protectedQty: "10",
          triggerPriceUsd: "90",
          confirmedTriggerPriceUsd: "90",
        },
      ],
    });
    expect(coverage.protected).toBe(false);
    expect(coverage.status).toBe("FAILED");
    expect(coverage.recoveryNeeded).toBe(true);
  });

  it("requires armed stop qty covering the open position", () => {
    const coverage = derivePositionProtectionCoverage({
      positionKey: "primary:SOL",
      lifecycleId: "lot_2",
      baseQty: "10",
      legs: [
        {
          positionKey: "primary:SOL",
          lifecycleId: "lot_2",
          kind: "STOP",
          origin: "SYNTHETIC_ENGINE",
          status: "ARMED",
          remainingQty: "10",
          protectedQty: "10",
          triggerPriceUsd: "95",
          confirmedTriggerPriceUsd: "95",
        },
      ],
    });
    expect(coverage.protected).toBe(true);
    expect(coverage.status).toBe("PROTECTED");
  });

  it("distinguishes exit-in-progress from protected", () => {
    const coverage = derivePositionProtectionCoverage({
      positionKey: "primary:SOL",
      baseQty: "5",
      legs: [
        {
          positionKey: "primary:SOL",
          kind: "STOP",
          origin: "SYNTHETIC_ENGINE",
          status: "TRIGGERED",
          remainingQty: "5",
          protectedQty: "5",
          triggerPriceUsd: "90",
        },
      ],
    });
    expect(coverage.status).toBe("EXIT_IN_PROGRESS");
    expect(coverage.protected).toBe(false);
  });

  it("aggregates many positions without inventing coverage from unrelated legs", () => {
    const rows = aggregateProtectionCoverage(
      [
        { positionKey: "primary:A", baseQty: "1" },
        { positionKey: "primary:B", baseQty: "2" },
      ],
      [
        {
          positionKey: "primary:A",
          kind: "STOP",
          origin: "SYNTHETIC_ENGINE",
          status: "ARMED",
          remainingQty: "1",
          protectedQty: "1",
          triggerPriceUsd: "1",
          confirmedTriggerPriceUsd: "1",
        },
      ],
    );
    expect(rows.find((r) => r.positionKey === "primary:A")?.protected).toBe(true);
    expect(rows.find((r) => r.positionKey === "primary:B")?.protected).toBe(false);
  });

  it("never treats desired-only venue-native stops as protected", () => {
    const coverage = derivePositionProtectionCoverage({
      positionKey: "primary:fixture:etf:SPY",
      lifecycleId: "lot_spy",
      baseQty: "10",
      legs: [
        {
          positionKey: "primary:fixture:etf:SPY",
          lifecycleId: "lot_spy",
          kind: "STOP",
          origin: "VENUE_NATIVE",
          status: "ARMED",
          remainingQty: "10",
          protectedQty: "10",
          ackState: "DESIRED_ONLY",
          triggerPriceUsd: "400",
          confirmedTriggerPriceUsd: null,
        },
      ],
    });
    expect(coverage.protected).toBe(false);
    expect(coverage.status).not.toBe("PROTECTED");
  });

  it("does not match colon-containing keys by first-colon suffix", () => {
    const coverage = derivePositionProtectionCoverage({
      positionKey: "primary:fixture:etf:SPY",
      lifecycleId: "lot_1",
      baseQty: "5",
      legs: [
        {
          // Would match if decoded as account=primary, instrument=fixture:etf:SPY via first colon.
          positionKey: "primary:etf:SPY",
          lifecycleId: "lot_1",
          kind: "STOP",
          origin: "SYNTHETIC_ENGINE",
          status: "ARMED",
          remainingQty: "5",
          protectedQty: "5",
          triggerPriceUsd: "400",
          confirmedTriggerPriceUsd: "400",
        },
      ],
    });
    expect(coverage.protected).toBe(false);
    expect(coverage.status).toBe("UNPROTECTED");
  });
});
