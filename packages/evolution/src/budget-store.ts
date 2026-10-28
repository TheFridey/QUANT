import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { d } from "@odin/shared";

export type BudgetSnapshot = {
  spentUsd: string;
  updatedAt: string;
};

export interface BudgetStore {
  read(): BudgetSnapshot;
  add(costUsd: string): BudgetSnapshot;
}

export class MemoryBudgetStore implements BudgetStore {
  private spent = "0.00000000";

  read(): BudgetSnapshot {
    return { spentUsd: this.spent, updatedAt: new Date().toISOString() };
  }

  add(costUsd: string): BudgetSnapshot {
    this.spent = d(this.spent).plus(d(costUsd)).toFixed(8);
    return this.read();
  }
}

/** Survives process restarts. Costs are decimal strings. The file never contains API keys. */
export class FileBudgetStore implements BudgetStore {
  constructor(private readonly path: string) {}

  read(): BudgetSnapshot {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<BudgetSnapshot>;
      if (typeof parsed.spentUsd === "string") {
        return { spentUsd: d(parsed.spentUsd).toFixed(8), updatedAt: parsed.updatedAt ?? new Date(0).toISOString() };
      }
    } catch {
      // Missing file starts at zero spend.
    }
    return { spentUsd: "0.00000000", updatedAt: new Date(0).toISOString() };
  }

  add(costUsd: string): BudgetSnapshot {
    const next = {
      spentUsd: d(this.read().spentUsd).plus(d(costUsd)).toFixed(8),
      updatedAt: new Date().toISOString(),
    };
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(next));
    return next;
  }
}
