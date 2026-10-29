import { describe, expect, it } from "vitest";
import {
  alertAckDoesNotClearSafety,
  ALERT_CODES,
  circuitBreakerAlert,
  protectionUnresolvedAlert,
  sortAlertsForOps,
} from "./alerts.js";

describe("durable alerts ops depth (D50)", () => {
  it("marks safety alerts as ACK≠clear", () => {
    expect(alertAckDoesNotClearSafety(ALERT_CODES.ENTRIES_SUSPENDED)).toBe(true);
    expect(alertAckDoesNotClearSafety(ALERT_CODES.CIRCUIT_BREAKER)).toBe(true);
    expect(alertAckDoesNotClearSafety(ALERT_CODES.PROTECTION_UNRESOLVED)).toBe(true);
    expect(alertAckDoesNotClearSafety(ALERT_CODES.PROVIDER_NOT_READY)).toBe(false);
  });

  it("sorts CRITICAL ahead of WARN/INFO for ops queues", () => {
    const sorted = sortAlertsForOps([
      { severity: "INFO", createdAt: "2026-10-28T16:00:00.000Z", code: "A" },
      { severity: "CRITICAL", createdAt: "2026-10-28T15:00:00.000Z", code: "B" },
      { severity: "WARN", createdAt: "2026-10-28T17:00:00.000Z", code: "C" },
    ]);
    expect(sorted.map((a) => a.code)).toEqual(["B", "C", "A"]);
  });

  it("circuit breaker / unresolved protection drafts carry honest payloads", () => {
    expect(circuitBreakerAlert({ open: true }).code).toBe(ALERT_CODES.CIRCUIT_BREAKER);
    expect(protectionUnresolvedAlert({ id: "x" }).message).toMatch(/ACK/i);
  });
});
