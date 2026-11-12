import { describe, expect, it } from "vitest";
import { holdoutAvailable } from "./holdout-policy.js";

describe("legacy holdout check is retired (F06)", () => {
  it("never grants a holdout, for any strategy, alias, interval or fresh instrument", async () => {
    const touched: string[] = [];
    const prisma = new Proxy({}, { get: (_t, p) => (touched.push(String(p)), () => { throw new Error("must not query"); }) });
    for (const [strategyId, instrumentKey, interval] of [["tsmom", "SOLPOOL", "1h"], ["never_seen", "EUR_USD", "1h"], ["never_seen", "EUR/USD", "4h"], ["x", "BRAND_NEW", "1d"]] as const) {
      expect(await holdoutAvailable(prisma, { strategyId, instrumentKey, interval })).toBe(false);
    }
    expect(touched).toEqual([]);
  });
});

describe("study key (F03)", async () => {
  const { studyKey } = await import("./holdout-policy.js");
  it("is stable under key order and distinguishes any identity change", () => {
    const a = studyKey({ cli: "ml-cli", datasetId: "d1", versionHash: "h", args: { horizon: 8, seed: 1 } });
    expect(studyKey({ args: { seed: 1, horizon: 8 }, versionHash: "h", datasetId: "d1", cli: "ml-cli" })).toBe(a);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(studyKey({ cli: "ml-cli", datasetId: "d1", versionHash: "h2", args: { horizon: 8, seed: 1 } })).not.toBe(a);
    expect(studyKey({ cli: "ml-cli", datasetId: "d1", versionHash: "h", args: { horizon: 8, seed: 2 } })).not.toBe(a);
  });
});

describe("OPERATION INTEGRITY F03/F06: legacy CLI holdout and trial-count policy", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolvePriorTrials } = await import("./holdout-policy.js");
  const { runIntelligenceStudy } = await import("@odin/backtest");

  it("a supplied --prior-trials can raise but never lower the durable programme count", () => {
    expect(resolvePriorTrials(null, 120)).toEqual({ priorTrials: 120, source: "LEDGER", ignoredSupplied: null });
    expect(resolvePriorTrials(0, 120)).toEqual({ priorTrials: 120, source: "LEDGER", ignoredSupplied: 0 });
    expect(resolvePriorTrials(5, 120).priorTrials).toBe(120);
    expect(resolvePriorTrials(120, 120)).toEqual({ priorTrials: 120, source: "LEDGER", ignoredSupplied: null });
    expect(resolvePriorTrials(5_000, 120)).toEqual({ priorTrials: 5_000, source: "SUPPLIED_ABOVE_LEDGER", ignoredSupplied: null });
  });

  it("warehouse-mode HORIZON and ML CLIs floor --prior-trials at the count frozen when the study opened", () => {
    for (const file of ["horizon-cli.ts", "ml-cli.ts"]) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      expect(source).toContain("resolvePriorTrials(args.priorTrials, opened.priorTrials)");
      expect(source).not.toMatch(/args\.priorTrials \?\? \(?await programmeTrialCount/);
    }
  });

  it("every warehouse CLI opens its study before computing and closes it before printing (F03)", () => {
    const order: Record<string, [string, string, string]> = {
      "horizon-cli.ts": ["openStudy(prisma", "runHorizonStudy({", "closeStudy(prisma"],
      "ml-cli.ts": ["openStudy(prisma", "runMlPipeline({", "closeStudy(prisma"],
      "research-cli.ts": ["openStudy(prisma", "validateStrategy({", "closeStudy(prisma"],
      "intelligence-cli.ts": ["openStudy(prisma", "const study = runIntelligenceStudy({", "closeStudy(prisma"],
    };
    for (const [file, [open, compute, close]] of Object.entries(order)) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      // The database path: the last print, and the computation preceding it.
      const lastPrint = source.lastIndexOf("console.log(");
      const closeAt = source.lastIndexOf(close, lastPrint);
      const computeAt = source.lastIndexOf(compute, closeAt);
      const openAt = source.lastIndexOf(open, computeAt);
      expect(openAt, file).toBeGreaterThan(-1);
      expect(computeAt, file).toBeGreaterThan(openAt);
      expect(closeAt, file).toBeGreaterThan(computeAt);
      // Nothing is printed between opening and closing.
      expect(source.slice(openAt, closeAt), file).not.toContain("console.log(");
      expect(source, file).toContain("evidenceClass: EXPLORATORY_EVIDENCE_CLASS");
      expect(source, file).not.toContain("declareLegacyTrials(");
    }
  });

  it("the ASCEND and intelligence CLIs withhold every holdout instead of check-evaluate-record", () => {
    for (const file of ["research-cli.ts", "intelligence-cli.ts"]) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      expect(source).toContain("holdoutWithheld: true");
      expect(source).not.toMatch(/holdoutAvailable\(prisma/);
    }
  });

  it("a withheld intelligence study never evaluates a holdout window", () => {
    const bars = Array.from({ length: 1_500 }, (_, i) => {
      const close = 100 * Math.exp(0.0004 * i + 0.01 * Math.sin(i / 9));
      return { t: Date.UTC(2025, 0, 1) + i * 3_600_000, open: close, high: close * 1.002, low: close * 0.998, close, volume: 1_000 };
    });
    const study = runIntelligenceStudy({ bars, barMs: 3_600_000, costBpsPerSide: 5, periodsPerYear: 8_760, codeVersion: "test", holdoutWithheld: true, holdoutAvailable: () => true });
    for (const h of study.hypotheses) {
      expect(h.gated.trials.some((t) => t.window === "HOLDOUT")).toBe(false);
      expect(h.gated.holdout).toBeNull();
    }
  });
});
