import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BudgetStoreUnreadableError,
  FileBudgetStore,
  MemoryBudgetStore,
  parseSpend,
  researchBudgetWindowStart,
} from "./budget-store.js";
import { FixtureModelProvider } from "./fixture-provider.js";
import { ModelRouter } from "./router.js";

function tempFile(content?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "odin-budget-"));
  const path = join(dir, "spend.json");
  if (content !== undefined) writeFileSync(path, content);
  return path;
}

describe("research budget store (APEX D-01/D-02)", () => {
  it("starts at zero only when the file does not exist", () => {
    expect(new FileBudgetStore(tempFile()).read().spentUsd).toBe("0.00000000");
  });

  it.each([
    ["truncated JSON", '{"spentUsd":"1.2'],
    ["empty file", ""],
    ["missing spend", '{"updatedAt":"2026-11-02T00:00:00.000Z"}'],
    ["negative spend", '{"spentUsd":"-50"}'],
    ["numeric spend", '{"spentUsd":4.5}'],
    ["non-decimal spend", '{"spentUsd":"NaN"}'],
    ["null document", "null"],
  ])("fails closed on %s instead of resetting spend to zero", (_label, content) => {
    const store = new FileBudgetStore(tempFile(content));
    expect(() => store.read()).toThrow(BudgetStoreUnreadableError);
    expect(() => store.add("0.01")).toThrow(BudgetStoreUnreadableError);
  });

  it("writes atomically and leaves no temporary file behind", () => {
    const path = tempFile();
    const store = new FileBudgetStore(path);
    store.add("0.25");
    store.add("0.50");
    expect(store.read().spentUsd).toBe("0.75000000");
    expect(readdirSync(join(path, "..")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("seeds an in-memory store from a durable total and refuses an invalid seed", () => {
    const store = new MemoryBudgetStore("4.99");
    expect(store.read().spentUsd).toBe("4.99000000");
    expect(store.add("0.01").spentUsd).toBe("5.00000000");
    expect(() => new MemoryBudgetStore("-1")).toThrow(BudgetStoreUnreadableError);
    expect(() => new MemoryBudgetStore("abc")).toThrow(BudgetStoreUnreadableError);
  });

  it("parses only non-negative decimal strings", () => {
    expect(parseSpend("0")).toBe("0.00000000");
    expect(parseSpend("12.345")).toBe("12.34500000");
    expect(parseSpend("-0.1")).toBeNull();
    expect(parseSpend("1e3")).toBeNull();
    expect(parseSpend(1)).toBeNull();
  });

  it("budgets per UTC calendar day", () => {
    expect(researchBudgetWindowStart(new Date("2026-11-02T23:59:59.999Z")).toISOString()).toBe("2026-11-02T00:00:00.000Z");
    expect(researchBudgetWindowStart(new Date("2026-11-03T00:00:00.000Z")).toISOString()).toBe("2026-11-03T00:00:00.000Z");
    // BST/GMT transitions do not move a UTC window.
    expect(researchBudgetWindowStart(new Date("2026-03-29T01:30:00.000Z")).toISOString()).toBe("2026-03-29T00:00:00.000Z");
  });
});

describe("router budget fails closed", () => {
  const schema = z.object({ ok: z.boolean() }).strict();
  const providers = () => {
    const fixture = new FixtureModelProvider({ fast_observer: { ok: true } });
    return new Map([
      ["hermes-primary", fixture],
      ["openai-primary", fixture],
      ["anthropic-primary", fixture],
      ["challenge-primary", fixture],
    ]);
  };

  it("reports zero remaining and makes no model call when spend is unreadable", async () => {
    const path = tempFile("{corrupt");
    const router = new ModelRouter({ providers: providers(), mode: "live", env: {}, budgetPath: path, budgetCapUsd: "5" });
    const budget = router.budget();
    expect(budget.spentUsd).toBeNull();
    expect(budget.remainingUsd).toBe("0.00000000");
    expect(budget.unavailableReason).toMatch(/not valid JSON/);
    const result = await router.completeJson(
      "FAST_OBSERVER",
      { purpose: "fast_observer", maxTokens: 50, timeoutMs: 500, messages: [{ role: "user", content: "fast_observer" }] },
      schema,
    );
    expect(result.ok).toBe(false);
    expect(router.usage).toEqual([]);
    expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false);
  });

  it("control: the same call succeeds with headroom, so the refusals above are caused by the budget", async () => {
    const router = new ModelRouter({ providers: providers(), mode: "live", env: {}, budgetStore: new MemoryBudgetStore("4.99"), budgetCapUsd: "5" });
    const result = await router.completeJson(
      "FAST_OBSERVER",
      { purpose: "fast_observer", maxTokens: 50, timeoutMs: 500, messages: [{ role: "user", content: "fast_observer" }] },
      schema,
    );
    expect(result.ok).toBe(true);
    expect(router.usage).toHaveLength(1);
  });

  it("refuses calls once a seeded spend reaches the cap", async () => {
    const router = new ModelRouter({
      providers: providers(),
      mode: "live",
      env: {},
      budgetStore: new MemoryBudgetStore("5"),
      budgetCapUsd: "5",
    });
    expect(router.budget().remainingUsd).toBe("0.00000000");
    const result = await router.completeJson(
      "FAST_OBSERVER",
      { purpose: "fast_observer", maxTokens: 50, timeoutMs: 500, messages: [{ role: "user", content: "fast_observer" }] },
      schema,
    );
    expect(result.ok).toBe(false);
    expect(router.usage).toEqual([]);
  });
});
