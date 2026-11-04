import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { d } from "@odin/shared";

export type BudgetSnapshot = {
  spentUsd: string;
  updatedAt: string;
};

export interface BudgetStore {
  /** Throws `BudgetStoreUnreadableError` when spend cannot be established; callers must fail closed. */
  read(): BudgetSnapshot;
  add(costUsd: string): BudgetSnapshot;
}

/** Spend that cannot be read must never be treated as zero spend (that would reopen an exhausted budget). */
export class BudgetStoreUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetStoreUnreadableError";
  }
}

/** A non-negative, finite decimal string, or null. */
export function parseSpend(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d+(\.\d+)?$/.test(value)) return null;
  const parsed = d(value);
  return parsed.isFinite() && parsed.gte(0) ? parsed.toFixed(8) : null;
}

/**
 * In-process spend. `initialSpentUsd` seeds it from a durable record (for example the sum of
 * `ModelUsageLog.costUsdEst` in the current budget window) so a new router does not start at zero.
 */
export class MemoryBudgetStore implements BudgetStore {
  private spent: string;

  constructor(initialSpentUsd = "0") {
    const parsed = parseSpend(initialSpentUsd);
    if (parsed === null) throw new BudgetStoreUnreadableError(`Invalid initial spend ${String(initialSpentUsd)}`);
    this.spent = parsed;
  }

  read(): BudgetSnapshot {
    return { spentUsd: this.spent, updatedAt: new Date().toISOString() };
  }

  add(costUsd: string): BudgetSnapshot {
    this.spent = d(this.spent).plus(d(costUsd)).toFixed(8);
    return this.read();
  }
}

/**
 * Survives process restarts. Costs are decimal strings. The file never contains API keys.
 * Only a missing file starts at zero spend. A file that exists but cannot be read or parsed,
 * or holds a negative or malformed amount, raises `BudgetStoreUnreadableError` so the router
 * fails closed. Writes go to a temporary file and are renamed into place, so a crash mid-write
 * leaves the previous total rather than a truncated file.
 */
export class FileBudgetStore implements BudgetStore {
  constructor(private readonly path: string) {}

  read(): BudgetSnapshot {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { spentUsd: "0.00000000", updatedAt: new Date(0).toISOString() };
      }
      throw new BudgetStoreUnreadableError(`Budget file unreadable: ${(error as Error).message}`);
    }
    let parsed: Partial<BudgetSnapshot>;
    try {
      parsed = JSON.parse(raw) as Partial<BudgetSnapshot>;
    } catch {
      throw new BudgetStoreUnreadableError("Budget file is not valid JSON");
    }
    const spentUsd = parseSpend(parsed?.spentUsd);
    if (spentUsd === null) throw new BudgetStoreUnreadableError("Budget file has no valid non-negative spentUsd");
    return { spentUsd, updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString() };
  }

  add(costUsd: string): BudgetSnapshot {
    const next = {
      spentUsd: d(this.read().spentUsd).plus(d(costUsd)).toFixed(8),
      updatedAt: new Date().toISOString(),
    };
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(next));
    renameSync(temporary, this.path);
    return next;
  }
}

/**
 * GENESIS Phase 8 durable reservation (no migration; see docs/genesis/RESEARCH_BUDGET_RESERVATION.md). Every
 * research-loop model call first reserves its worst-case cost as a `ModelUsageLog` row (`costKind = RESERVED`)
 * inside a transaction holding this advisory lock, so concurrent processes see each other's in-flight spend.
 */
export const RESEARCH_BUDGET_LOCK = 8_080_802;
export const RESERVED_COST_KIND = "RESERVED";
/** Attempts the router may make per endpoint (one retry on TIMEOUT/UPSTREAM). */
export const ROUTER_ATTEMPTS_PER_ENDPOINT = 2;

/**
 * Worst-case cost of one routed call: every endpoint in the chain, every attempt, the full prompt and twice the
 * completion-token limit (the router estimates completion tokens from characters, which can exceed the limit).
 */
export function reservationEstimateUsd(input: {
  endpoints: ReadonlyArray<{ costPer1kInputUsd: string; costPer1kOutputUsd: string }>;
  promptTokens: number;
  maxCompletionTokens: number;
  attemptsPerEndpoint?: number;
}): string {
  const attempts = input.attemptsPerEndpoint ?? ROUTER_ATTEMPTS_PER_ENDPOINT;
  let total = d("0");
  for (const endpoint of input.endpoints) {
    const one = d(String(input.promptTokens)).div(1000).mul(d(endpoint.costPer1kInputUsd))
      .plus(d(String(input.maxCompletionTokens * 2)).div(1000).mul(d(endpoint.costPer1kOutputUsd)));
    total = total.plus(one.mul(attempts));
  }
  return total.toFixed(8);
}

export type ReservationDecision = { ok: true; remainingAfterUsd: string } | { ok: false; detail: string };

/** Fail closed: unreadable spend or cap refuses; a reservation is granted only if spent + reserve stays within the cap. */
export function reservationDecision(input: { capUsd: string; spentUsd: string; reserveUsd: string }): ReservationDecision {
  const cap = parseSpend(input.capUsd);
  const spent = parseSpend(input.spentUsd);
  const reserve = parseSpend(input.reserveUsd);
  if (cap === null || spent === null || reserve === null) return { ok: false, detail: "Budget cap, spend or reservation unreadable" };
  const after = d(spent).plus(d(reserve));
  if (after.gt(d(cap))) return { ok: false, detail: `Reservation ${reserve} USD would exceed the cap: ${spent} spent of ${cap} USD today (UTC)` };
  return { ok: true, remainingAfterUsd: d(cap).minus(after).toFixed(8) };
}

/** Research model spend is budgeted per UTC calendar day. Returns the start of the window containing `now`. */
export function researchBudgetWindowStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
