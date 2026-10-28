import { d, usd, Decimal } from "@odin/shared";

export type ReservationKind = "CASH" | "EXPOSURE" | "SLOT" | "RISK";

export type ReservationRequest = {
  id: string;
  accountId: string;
  /** Client order / intent id — unique per reservation. */
  clientOrderId: string;
  cashUsd: string;
  exposureUsd: string;
  slots: number;
  riskUsd: string;
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
  createdAtMs: number;
};

export type ReservationResult =
  | { ok: true; reservation: ReservationRecord; budget: ReservationBudget }
  | { ok: false; reason: "INSUFFICIENT_CASH" | "AGGREGATE_EXPOSURE" | "MAX_POSITIONS" | "RISK_BUDGET" | "DUPLICATE_RESERVATION" };

/**
 * In-process atomic reservation ledger for parallel admission.
 * Durable Postgres table mirrors this for restart; unit tests use this pure store.
 */
export class ReservationLedger {
  private readonly held = new Map<string, ReservationRecord>();

  constructor(private budget: ReservationBudget) {}

  snapshot(): ReservationBudget {
    return { ...this.budget };
  }

  listHeld(): ReservationRecord[] {
    return [...this.held.values()].filter((row) => row.status === "HELD");
  }

  /**
   * Atomically admit a reservation if budgets allow.
   * Parallel callers must serialize on the same ledger instance (or DB FOR UPDATE).
   */
  reserve(request: ReservationRequest, nowMs = Date.now()): ReservationResult {
    if (this.held.has(request.clientOrderId)) {
      const existing = this.held.get(request.clientOrderId)!;
      if (existing.status === "HELD") return { ok: true, reservation: existing, budget: this.snapshot() };
      return { ok: false, reason: "DUPLICATE_RESERVATION" };
    }

    const cashNeed = d(request.cashUsd);
    const exposureNeed = d(request.exposureUsd);
    const riskNeed = d(request.riskUsd);
    const slotsNeed = request.slots;

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
      status: "HELD",
      createdAtMs: nowMs,
    };
    this.held.set(request.clientOrderId, reservation);
    return { ok: true, reservation, budget: this.snapshot() };
  }

  /** Release unused reservation on cancel / reject / expiry. */
  release(clientOrderId: string): ReservationRecord | null {
    const row = this.held.get(clientOrderId);
    if (!row || row.status !== "HELD") return null;
    this.budget = {
      ...this.budget,
      cashAvailableUsd: usd(d(this.budget.cashAvailableUsd).plus(d(row.cashUsd))),
      exposureUsedUsd: usd(Decimal.max(d("0"), d(this.budget.exposureUsedUsd).minus(d(row.exposureUsd)))),
      slotsUsed: Math.max(0, this.budget.slotsUsed - row.slots),
      riskUsedUsd: usd(Decimal.max(d("0"), d(this.budget.riskUsedUsd).minus(d(row.riskUsd)))),
    };
    const updated = { ...row, status: "RELEASED" as const };
    this.held.set(clientOrderId, updated);
    return updated;
  }

  /**
   * Consume on fill. Partial: pass remaining fractions to release afterward via
   * `releasePartial` for unused cash/exposure/risk/slots.
   */
  consume(clientOrderId: string): ReservationRecord | null {
    const row = this.held.get(clientOrderId);
    if (!row || row.status !== "HELD") return null;
    const updated = { ...row, status: "CONSUMED" as const };
    this.held.set(clientOrderId, updated);
    return updated;
  }

  /** Release unused remainder after a partial fill (does not restore slots if position opened). */
  releasePartial(
    clientOrderId: string,
    unused: { cashUsd: string; exposureUsd: string; riskUsd: string; slots: number },
  ): ReservationRecord | null {
    const row = this.held.get(clientOrderId);
    if (!row || (row.status !== "HELD" && row.status !== "CONSUMED")) return null;
    this.budget = {
      ...this.budget,
      cashAvailableUsd: usd(d(this.budget.cashAvailableUsd).plus(d(unused.cashUsd))),
      exposureUsedUsd: usd(Decimal.max(d("0"), d(this.budget.exposureUsedUsd).minus(d(unused.exposureUsd)))),
      slotsUsed: Math.max(0, this.budget.slotsUsed - unused.slots),
      riskUsedUsd: usd(Decimal.max(d("0"), d(this.budget.riskUsedUsd).minus(d(unused.riskUsd)))),
    };
    if (row.status === "HELD") {
      const updated = { ...row, status: "CONSUMED" as const };
      this.held.set(clientOrderId, updated);
      return updated;
    }
    return row;
  }
}

/** Admit many requests serially against one ledger — models parallel contention under a lock. */
export function admitParallel(
  ledger: ReservationLedger,
  requests: ReservationRequest[],
): Array<{ clientOrderId: string; result: ReservationResult }> {
  return requests.map((request) => ({ clientOrderId: request.clientOrderId, result: ledger.reserve(request) }));
}
