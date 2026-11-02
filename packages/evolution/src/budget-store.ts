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

/** Research model spend is budgeted per UTC calendar day. Returns the start of the window containing `now`. */
export function researchBudgetWindowStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
