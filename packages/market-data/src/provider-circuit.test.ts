import { describe, expect, it } from "vitest";
import {
  admitRequest,
  backoffMs,
  circuitKey,
  DEFAULT_CIRCUIT_POLICY,
  initialCircuit,
  recordFailure,
  recordSuccess,
  summariseCircuits,
  type CircuitPolicy,
} from "./provider-circuit.js";

const NO_JITTER: CircuitPolicy = { ...DEFAULT_CIRCUIT_POLICY, jitterFraction: 0 };
const T0 = 1_000_000;

describe("provider circuit breaker (HORIZON Phase II, unwired)", () => {
  it("stays closed below the failure threshold and opens at it", () => {
    let r = initialCircuit(circuitKey("oanda_practice", "XAU_USD"));
    r = recordFailure(r, { kind: "NETWORK", error: "fetch failed" }, T0, NO_JITTER);
    r = recordFailure(r, { kind: "TIMEOUT" }, T0 + 1, NO_JITTER);
    expect(r.state).toBe("CLOSED");
    expect(admitRequest(r, T0 + 2).admission.allowed).toBe(true);
    r = recordFailure(r, { kind: "HTTP_5XX" }, T0 + 2, NO_JITTER);
    expect(r).toMatchObject({ state: "OPEN", openings: 1, retryAt: T0 + 2 + 5_000, lastFailure: "HTTP_5XX" });
    expect(admitRequest(r, T0 + 5_001).admission).toMatchObject({ allowed: false, reason: "OPEN_UNTIL_RETRY" });
  });

  it("a success resets the failure count (one transient failure never opens)", () => {
    let r = initialCircuit("oanda_practice:EUR_USD");
    r = recordFailure(r, { kind: "NETWORK" }, T0, NO_JITTER);
    r = recordSuccess(r, T0 + 10);
    expect(r).toMatchObject({ state: "CLOSED", consecutiveFailures: 0, lastSuccessAt: T0 + 10 });
  });

  it("opens immediately on auth, configuration and rate-limit failures", () => {
    for (const kind of ["AUTH_FAILED", "INVALID_CONFIGURATION", "RATE_LIMITED"] as const) {
      expect(recordFailure(initialCircuit("k"), { kind }, T0, NO_JITTER).state).toBe("OPEN");
    }
  });

  it("honours Retry-After as a floor, capped at maxBackoffMs", () => {
    const r = recordFailure(initialCircuit("alpaca_paper:SPY"), { kind: "RATE_LIMITED", retryAfterMs: 60_000 }, T0, NO_JITTER);
    expect(r.retryAt).toBe(T0 + 60_000);
    const capped = recordFailure(initialCircuit("alpaca_paper:SPY"), { kind: "RATE_LIMITED", retryAfterMs: 10 ** 9 }, T0, NO_JITTER);
    expect(capped.retryAt).toBe(T0 + NO_JITTER.maxBackoffMs);
  });

  it("allows exactly one half-open probe; success closes, failure reopens with doubled backoff", () => {
    let r = recordFailure(initialCircuit("k"), { kind: "AUTH_FAILED" }, T0, NO_JITTER);
    const first = admitRequest(r, T0 + 5_000);
    expect(first.admission).toMatchObject({ allowed: true, state: "HALF_OPEN", reason: "HALF_OPEN_PROBE" });
    r = first.record;
    expect(admitRequest(r, T0 + 5_001).admission).toMatchObject({ allowed: false, reason: "HALF_OPEN_PROBE_IN_FLIGHT" });
    const reopened = recordFailure(r, { kind: "NETWORK" }, T0 + 6_000, NO_JITTER);
    expect(reopened).toMatchObject({ state: "OPEN", openings: 2, retryAt: T0 + 6_000 + 10_000 });
    expect(recordSuccess(admitRequest(reopened, T0 + 16_000).record, T0 + 16_001).state).toBe("CLOSED");
  });

  it("backoff grows exponentially and is capped", () => {
    const values = [1, 2, 3, 4, 10, 30].map((n) => backoffMs("k", n, NO_JITTER));
    expect(values).toEqual([5_000, 10_000, 20_000, 40_000, 300_000, 300_000]);
  });

  it("jitter is deterministic per key, bounded, and differs across keys", () => {
    const a = backoffMs("oanda_practice:EUR_USD", 1, DEFAULT_CIRCUIT_POLICY);
    expect(backoffMs("oanda_practice:EUR_USD", 1, DEFAULT_CIRCUIT_POLICY)).toBe(a);
    expect(a).toBeGreaterThanOrEqual(5_000);
    expect(a).toBeLessThanOrEqual(6_000);
    const keys = ["EUR_USD", "GBP_USD", "USD_JPY", "XAU_USD", "WTICO_USD"].map((i) => backoffMs(`oanda_practice:${i}`, 1, DEFAULT_CIRCUIT_POLICY));
    expect(new Set(keys).size).toBeGreaterThan(1);
  });

  it("breakers are independent per instrument and provider", () => {
    const xau = recordFailure(initialCircuit("oanda_practice:XAU_USD"), { kind: "AUTH_FAILED" }, T0, NO_JITTER);
    const eur = initialCircuit("oanda_practice:EUR_USD");
    const spy = initialCircuit("alpaca_paper:SPY");
    expect(summariseCircuits([xau, eur, spy])).toEqual({ open: ["oanda_practice:XAU_USD"], halfOpen: [], closed: 2 });
  });

  it("ignores late results while OPEN and expires a probe that never reports", () => {
    const open = recordFailure(initialCircuit("k"), { kind: "AUTH_FAILED" }, T0, NO_JITTER);
    expect(recordSuccess(open, T0 + 1)).toMatchObject({ state: "OPEN", retryAt: open.retryAt });
    expect(recordFailure(open, { kind: "NETWORK" }, T0 + 2, NO_JITTER)).toMatchObject({ state: "OPEN", openings: 1, retryAt: open.retryAt });
    const probing = admitRequest(open, T0 + 5_000, NO_JITTER).record;
    const stuck = admitRequest(probing, T0 + 5_000 + NO_JITTER.probeTimeoutMs, NO_JITTER);
    expect(stuck.admission).toMatchObject({ allowed: false, state: "OPEN" });
    expect(stuck.record).toMatchObject({ state: "OPEN", openings: 2, lastError: "HALF_OPEN_PROBE_TIMEOUT" });
  });

  it("refuses an invalid policy instead of running unbounded", () => {
    expect(() => backoffMs("k", 1, { ...NO_JITTER, failureThreshold: 0 })).toThrow("INVALID_CIRCUIT_POLICY");
    expect(() => backoffMs("k", 1, { ...NO_JITTER, maxBackoffMs: 1 })).toThrow("INVALID_CIRCUIT_POLICY");
    expect(() => backoffMs("k", 1, { ...NO_JITTER, jitterFraction: 2 })).toThrow("INVALID_CIRCUIT_POLICY");
  });
});
