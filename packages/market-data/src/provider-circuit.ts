/**
 * HORIZON Phase II: independent per-instrument provider circuit breakers. **Pure and unwired.**
 *
 * One breaker per `provider:instrument` key, so a failing OANDA XAU_USD price cannot stop EUR_USD, and a
 * failing provider cannot stop another provider. State moves only through `recordSuccess` / `recordFailure`
 * with an injected clock, so behaviour is deterministic in tests and replay.
 *
 * - CLOSED: requests allowed.
 * - OPEN: requests refused until `retryAt`. Opens after `failureThreshold` consecutive failures, or at once
 *   on AUTH_FAILED / INVALID_CONFIGURATION (retrying those cannot help) or RATE_LIMITED.
 * - HALF_OPEN: after `retryAt`, exactly one probe request is allowed; success closes, failure reopens with
 *   a doubled backoff.
 *
 * Backoff is exponential from `baseBackoffMs`, capped at `maxBackoffMs`, and never shorter than a
 * provider `Retry-After` (itself capped at `maxBackoffMs`). Jitter is deterministic from the key, so many
 * breakers opened together do not retry together.
 */

export const PROVIDER_FAILURE_KINDS = [
  "NETWORK",
  "TIMEOUT",
  "HTTP_5XX",
  "RATE_LIMITED",
  "AUTH_FAILED",
  "INVALID_CONFIGURATION",
  "BAD_PAYLOAD",
] as const;
export type ProviderFailureKind = (typeof PROVIDER_FAILURE_KINDS)[number];

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export type CircuitPolicy = {
  failureThreshold: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  /** 0..0.5: fraction of the backoff added as deterministic per-key jitter. */
  jitterFraction: number;
  /** A half-open probe with no recorded result after this long counts as failed, so the breaker cannot stick. */
  probeTimeoutMs: number;
};

export const DEFAULT_CIRCUIT_POLICY: CircuitPolicy = {
  failureThreshold: 3,
  baseBackoffMs: 5_000,
  maxBackoffMs: 300_000,
  jitterFraction: 0.2,
  probeTimeoutMs: 30_000,
};

export type CircuitRecord = {
  key: string;
  state: CircuitState;
  consecutiveFailures: number;
  /** Number of times the breaker has opened since it last closed; drives the exponent. */
  openings: number;
  retryAt: number | null;
  halfOpenInFlight: boolean;
  halfOpenSince: number | null;
  lastFailure: ProviderFailureKind | null;
  lastError: string | null;
  lastSuccessAt: number | null;
};

export function circuitKey(providerId: string, instrument: string): string {
  return `${providerId}:${instrument}`;
}

export function initialCircuit(key: string): CircuitRecord {
  return {
    key,
    state: "CLOSED",
    consecutiveFailures: 0,
    openings: 0,
    retryAt: null,
    halfOpenInFlight: false,
    halfOpenSince: null,
    lastFailure: null,
    lastError: null,
    lastSuccessAt: null,
  };
}

function validPolicy(policy: CircuitPolicy): CircuitPolicy {
  const ok =
    Number.isInteger(policy.failureThreshold) &&
    policy.failureThreshold >= 1 &&
    Number.isFinite(policy.baseBackoffMs) &&
    policy.baseBackoffMs > 0 &&
    Number.isFinite(policy.maxBackoffMs) &&
    policy.maxBackoffMs >= policy.baseBackoffMs &&
    Number.isFinite(policy.jitterFraction) &&
    policy.jitterFraction >= 0 &&
    policy.jitterFraction <= 0.5 &&
    Number.isFinite(policy.probeTimeoutMs) &&
    policy.probeTimeoutMs > 0;
  if (!ok) throw new Error("INVALID_CIRCUIT_POLICY");
  return policy;
}

/** Stable 0..1 value from the key (FNV-1a), so jitter is reproducible. */
function keyUnit(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 0xffffffff;
}

export function backoffMs(key: string, openings: number, policy: CircuitPolicy, retryAfterMs?: number | null): number {
  const p = validPolicy(policy);
  const exp = Math.min(p.baseBackoffMs * 2 ** Math.max(openings - 1, 0), p.maxBackoffMs);
  const jittered = Math.min(Math.round(exp * (1 + p.jitterFraction * keyUnit(key))), p.maxBackoffMs);
  const floor = retryAfterMs !== null && retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? Math.min(retryAfterMs, p.maxBackoffMs) : 0;
  return Math.max(jittered, floor);
}

export type CircuitAdmission = { allowed: boolean; state: CircuitState; reason: "CLOSED" | "OPEN_UNTIL_RETRY" | "HALF_OPEN_PROBE" | "HALF_OPEN_PROBE_IN_FLIGHT"; retryAt: number | null };

/**
 * Ask whether a request may be sent now. Returns the record to store: when an OPEN breaker's retry time
 * has passed, it becomes HALF_OPEN with one probe in flight.
 */
export function admitRequest(
  record: CircuitRecord,
  now: number,
  policy: CircuitPolicy = DEFAULT_CIRCUIT_POLICY,
): { admission: CircuitAdmission; record: CircuitRecord } {
  const p = validPolicy(policy);
  if (record.state === "CLOSED") {
    return { admission: { allowed: true, state: "CLOSED", reason: "CLOSED", retryAt: null }, record };
  }
  if (record.state === "OPEN") {
    if (record.retryAt !== null && now >= record.retryAt) {
      const next = { ...record, state: "HALF_OPEN" as const, halfOpenInFlight: true, halfOpenSince: now };
      return { admission: { allowed: true, state: "HALF_OPEN", reason: "HALF_OPEN_PROBE", retryAt: record.retryAt }, record: next };
    }
    return { admission: { allowed: false, state: "OPEN", reason: "OPEN_UNTIL_RETRY", retryAt: record.retryAt }, record };
  }
  if (record.halfOpenInFlight && record.halfOpenSince !== null && now - record.halfOpenSince >= p.probeTimeoutMs) {
    // The probe never reported: treat it as a failure and reopen with a longer backoff.
    const reopened = recordFailure(record, { kind: "TIMEOUT", error: "HALF_OPEN_PROBE_TIMEOUT" }, now, p);
    return { admission: { allowed: false, state: "OPEN", reason: "OPEN_UNTIL_RETRY", retryAt: reopened.retryAt }, record: reopened };
  }
  if (record.halfOpenInFlight) {
    return { admission: { allowed: false, state: "HALF_OPEN", reason: "HALF_OPEN_PROBE_IN_FLIGHT", retryAt: record.retryAt }, record };
  }
  return {
    admission: { allowed: true, state: "HALF_OPEN", reason: "HALF_OPEN_PROBE", retryAt: record.retryAt },
    record: { ...record, halfOpenInFlight: true, halfOpenSince: now },
  };
}

/**
 * A success closes the breaker only from CLOSED or HALF_OPEN. A late success from a request admitted before
 * the breaker opened is ignored while OPEN, so it cannot cut a backoff short.
 */
export function recordSuccess(record: CircuitRecord, now: number): CircuitRecord {
  if (record.state === "OPEN") return { ...record, lastSuccessAt: now };
  return { ...initialCircuit(record.key), lastSuccessAt: now };
}

const OPEN_IMMEDIATELY: ReadonlySet<ProviderFailureKind> = new Set(["AUTH_FAILED", "INVALID_CONFIGURATION", "RATE_LIMITED"]);

export function recordFailure(
  record: CircuitRecord,
  failure: { kind: ProviderFailureKind; error?: string; retryAfterMs?: number | null },
  now: number,
  policy: CircuitPolicy = DEFAULT_CIRCUIT_POLICY,
): CircuitRecord {
  const p = validPolicy(policy);
  // A late failure while already OPEN is recorded but does not extend the backoff or count as a new opening.
  if (record.state === "OPEN") return { ...record, lastFailure: failure.kind, lastError: failure.error ?? null };
  const consecutiveFailures = record.consecutiveFailures + 1;
  const opens = record.state === "HALF_OPEN" || OPEN_IMMEDIATELY.has(failure.kind) || consecutiveFailures >= p.failureThreshold;
  const base = { ...record, consecutiveFailures, lastFailure: failure.kind, lastError: failure.error ?? null, halfOpenInFlight: false, halfOpenSince: null };
  if (!opens) return { ...base, state: "CLOSED" };
  const openings = record.openings + 1;
  return { ...base, state: "OPEN", openings, retryAt: now + backoffMs(record.key, openings, p, failure.retryAfterMs) };
}

/** Explicit provider state for display: never "ok" while any instrument breaker is not CLOSED. */
export function summariseCircuits(records: readonly CircuitRecord[]): { open: string[]; halfOpen: string[]; closed: number } {
  return {
    open: records.filter((r) => r.state === "OPEN").map((r) => r.key).sort(),
    halfOpen: records.filter((r) => r.state === "HALF_OPEN").map((r) => r.key).sort(),
    closed: records.filter((r) => r.state === "CLOSED").length,
  };
}
