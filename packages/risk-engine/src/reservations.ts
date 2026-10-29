import { d, usd, Decimal } from "@odin/shared";

export type ReservationKind = "CASH" | "EXPOSURE" | "SLOT" | "RISK";

export type ReservationRequest = {
  id: string;
  accountId: string;
  /** Execution / trading mode for idempotency scope. */
  mode: string;
  /** Client order / intent id — unique per account+mode. */
  clientOrderId: string;
  cashUsd: string;
  exposureUsd: string;
  slots: number;
  riskUsd: string;
  /** When set, admission also checks this instance's budget under the account lock (Stage I). */
  strategyInstanceId?: string | null;
  intentId?: string | null;
  /**
   * Instance capital budget (filled committed + HELD remaining + this request ≤ budget).
   * Required when strategyInstanceId is set; omit for account-only reservations.
   */
  instanceBudgetUsd?: string | null;
};

export type ReservationBudget = {
  cashAvailableUsd: string;
  exposureCapUsd: string;
  exposureUsedUsd: string;
  slotsAvailable: number;
  slotsUsed: number;
  riskBudgetUsd: string;
  riskUsedUsd: string;
};

export type ReservationRecord = ReservationRequest & {
  status: "HELD" | "RELEASED" | "CONSUMED";
  /** Remaining unreleased amounts (post partial release). */
  remainingCashUsd: string;
  remainingExposureUsd: string;
  remainingRiskUsd: string;
  remainingSlots: number;
  createdAtMs: number;
};

export type ReservationMutation =
  | { type: "RESERVE"; atMs: number; request: ReservationRequest }
  | { type: "RELEASE"; atMs: number; clientOrderId: string }
  | {
      type: "RELEASE_PARTIAL";
      atMs: number;
      clientOrderId: string;
      unused: { cashUsd: string; exposureUsd: string; riskUsd: string; slots: number };
    }
  | { type: "CONSUME"; atMs: number; clientOrderId: string };

export type ReservationResult =
  | { ok: true; reservation: ReservationRecord; budget: ReservationBudget }
  | {
      ok: false;
      reason:
        | "INSUFFICIENT_CASH"
        | "AGGREGATE_EXPOSURE"
        | "MAX_POSITIONS"
        | "RISK_BUDGET"
        | "INSTANCE_BUDGET"
        | "DUPLICATE_RESERVATION"
        | "OVER_RELEASE"
        | "NEGATIVE_RELEASE"
        | "INVALID_STATE";
    };

function keyOf(accountId: string, mode: string, clientOrderId: string): string {
  return `${accountId}::${mode}::${clientOrderId}`;
}

/**
 * In-process atomic reservation ledger — **test reference only**.
 * Production admission must use PostgresReservationAuthority.
 */
export class ReservationLedger {
  private readonly held = new Map<string, ReservationRecord>();
  private readonly mutations: ReservationMutation[] = [];

  constructor(private budget: ReservationBudget) {}

  snapshot(): ReservationBudget {
    return { ...this.budget };
  }

  listHeld(): ReservationRecord[] {
    return [...this.held.values()].filter((row) => row.status === "HELD");
  }

  mutationLog(): readonly ReservationMutation[] {
    return this.mutations;
  }

  /**
   * Atomically admit a reservation if budgets allow.
   * Idempotent on accountId+mode+clientOrderId while HELD.
   */
  reserve(request: ReservationRequest, nowMs = Date.now()): ReservationResult {
    const mode = request.mode || "PAPER";
    const key = keyOf(request.accountId, mode, request.clientOrderId);
    if (this.held.has(key)) {
      const existing = this.held.get(key)!;
      if (existing.status === "HELD") return { ok: true, reservation: existing, budget: this.snapshot() };
      return { ok: false, reason: "DUPLICATE_RESERVATION" };
    }

    const cashNeed = d(request.cashUsd);
    const exposureNeed = d(request.exposureUsd);
    const riskNeed = d(request.riskUsd);
    const slotsNeed = request.slots;
    if (cashNeed.lt(0) || exposureNeed.lt(0) || riskNeed.lt(0) || slotsNeed < 0) {
      return { ok: false, reason: "NEGATIVE_RELEASE" };
    }

    if (cashNeed.gt(this.budget.cashAvailableUsd)) return { ok: false, reason: "INSUFFICIENT_CASH" };
    if (d(this.budget.exposureUsedUsd).plus(exposureNeed).gt(this.budget.exposureCapUsd)) {
      return { ok: false, reason: "AGGREGATE_EXPOSURE" };
    }
    if (this.budget.slotsUsed + slotsNeed > this.budget.slotsAvailable) {
      return { ok: false, reason: "MAX_POSITIONS" };
    }
    if (d(this.budget.riskUsedUsd).plus(riskNeed).gt(this.budget.riskBudgetUsd)) {
      return { ok: false, reason: "RISK_BUDGET" };
    }

    this.budget = {
      ...this.budget,
      cashAvailableUsd: usd(d(this.budget.cashAvailableUsd).minus(cashNeed)),
      exposureUsedUsd: usd(d(this.budget.exposureUsedUsd).plus(exposureNeed)),
      slotsUsed: this.budget.slotsUsed + slotsNeed,
      riskUsedUsd: usd(d(this.budget.riskUsedUsd).plus(riskNeed)),
    };

    const reservation: ReservationRecord = {
      ...request,
      mode,
      status: "HELD",
      remainingCashUsd: usd(cashNeed),
      remainingExposureUsd: usd(exposureNeed),
      remainingRiskUsd: usd(riskNeed),
      remainingSlots: slotsNeed,
      createdAtMs: nowMs,
    };
    this.held.set(key, reservation);
    this.mutations.push({ type: "RESERVE", atMs: nowMs, request: { ...request, mode } });
    return { ok: true, reservation, budget: this.snapshot() };
  }

  /** Release unused reservation on cancel / reject / expiry. */
  release(clientOrderId: string, accountId = "primary", mode = "PAPER"): ReservationRecord | null {
    const key = keyOf(accountId, mode, clientOrderId);
    const row = this.held.get(key);
    if (!row || row.status !== "HELD") return null;
    this.budget = {
      ...this.budget,
      cashAvailableUsd: usd(d(this.budget.cashAvailableUsd).plus(d(row.remainingCashUsd))),
      exposureUsedUsd: usd(Decimal.max(d("0"), d(this.budget.exposureUsedUsd).minus(d(row.remainingExposureUsd)))),
      slotsUsed: Math.max(0, this.budget.slotsUsed - row.remainingSlots),
      riskUsedUsd: usd(Decimal.max(d("0"), d(this.budget.riskUsedUsd).minus(d(row.remainingRiskUsd)))),
    };
    const updated: ReservationRecord = {
      ...row,
      status: "RELEASED",
      remainingCashUsd: "0.00000000",
      remainingExposureUsd: "0.00000000",
      remainingRiskUsd: "0.00000000",
      remainingSlots: 0,
    };
    this.held.set(key, updated);
    this.mutations.push({ type: "RELEASE", atMs: Date.now(), clientOrderId });
    return updated;
  }

  /**
   * Consume on fill — usage moves to the open book.
   * Remainders are zeroed so reconstruct/open usage is not double-counted (D04).
   * Release unused via releasePartial before consume when needed.
   */
  consume(clientOrderId: string, accountId = "primary", mode = "PAPER"): ReservationRecord | null {
    const key = keyOf(accountId, mode, clientOrderId);
    const row = this.held.get(key);
    if (!row || row.status !== "HELD") return null;
    const updated: ReservationRecord = {
      ...row,
      status: "CONSUMED",
      remainingCashUsd: "0.00000000",
      remainingExposureUsd: "0.00000000",
      remainingRiskUsd: "0.00000000",
      remainingSlots: 0,
    };
    this.held.set(key, updated);
    this.mutations.push({ type: "CONSUME", atMs: Date.now(), clientOrderId });
    return updated;
  }

  /**
   * Release unused remainder after a partial fill.
   * Rejects double-release, over-release, and negative amounts.
   * Releases only against remaining*; never restores more than was held.
   */
  releasePartial(
    clientOrderId: string,
    unused: { cashUsd: string; exposureUsd: string; riskUsd: string; slots: number },
    accountId = "primary",
    mode = "PAPER",
  ): ReservationResult {
    const key = keyOf(accountId, mode, clientOrderId);
    const row = this.held.get(key);
    if (!row) return { ok: false, reason: "INVALID_STATE" };
    if (row.status !== "HELD" && row.status !== "CONSUMED") {
      return { ok: false, reason: "INVALID_STATE" };
    }

    const cash = d(unused.cashUsd);
    const exposure = d(unused.exposureUsd);
    const risk = d(unused.riskUsd);
    const slots = unused.slots;
    if (cash.lt(0) || exposure.lt(0) || risk.lt(0) || slots < 0) {
      return { ok: false, reason: "NEGATIVE_RELEASE" };
    }
    if (
      cash.gt(row.remainingCashUsd) ||
      exposure.gt(row.remainingExposureUsd) ||
      risk.gt(row.remainingRiskUsd) ||
      slots > row.remainingSlots
    ) {
      return { ok: false, reason: "OVER_RELEASE" };
    }

    this.budget = {
      ...this.budget,
      cashAvailableUsd: usd(d(this.budget.cashAvailableUsd).plus(cash)),
      exposureUsedUsd: usd(Decimal.max(d("0"), d(this.budget.exposureUsedUsd).minus(exposure))),
      slotsUsed: Math.max(0, this.budget.slotsUsed - slots),
      riskUsedUsd: usd(Decimal.max(d("0"), d(this.budget.riskUsedUsd).minus(risk))),
    };

    // Keep HELD while unused is peeled off; consume() transitions to CONSUMED and
    // zeros remainders when the fill moves usage onto the open book (D04).
    const updated: ReservationRecord = {
      ...row,
      status: row.status === "CONSUMED" ? "CONSUMED" : "HELD",
      remainingCashUsd: usd(d(row.remainingCashUsd).minus(cash)),
      remainingExposureUsd: usd(d(row.remainingExposureUsd).minus(exposure)),
      remainingRiskUsd: usd(d(row.remainingRiskUsd).minus(risk)),
      remainingSlots: row.remainingSlots - slots,
    };
    this.held.set(key, updated);
    this.mutations.push({
      type: "RELEASE_PARTIAL",
      atMs: Date.now(),
      clientOrderId,
      unused,
    });
    return { ok: true, reservation: updated, budget: this.snapshot() };
  }
}

/** Admit many requests serially against one ledger — models parallel contention under a lock. */
export function admitParallel(
  ledger: ReservationLedger,
  requests: ReservationRequest[],
): Array<{ clientOrderId: string; result: ReservationResult }> {
  return requests.map((request) => ({ clientOrderId: request.clientOrderId, result: ledger.reserve(request) }));
}
