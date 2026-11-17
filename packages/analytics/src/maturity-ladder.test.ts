import { describe, expect, it } from "vitest";
import { allocateScanCapacity, classifyMaturity, MATURITY_STAGES, type MaturityFacts } from "./maturity-ladder.js";

const ALL: MaturityFacts = {
  instrumentId: "fx:EURUSD",
  supported: true,
  providerConfigured: true,
  quoteObserved: true,
  quoteQualified: true,
  historicalDatasetReady: true,
  researchValidated: true,
  shadowActive: true,
  shadowPassed: true,
  operatorApproved: true,
  protectedAdmissionActive: true,
};

describe("maturity ladder (HORIZON Phase II)", () => {
  it("reaches PAPER_ELIGIBLE only when every rung holds", () => {
    expect(classifyMaturity(ALL)).toEqual({ instrumentId: "fx:EURUSD", stage: "PAPER_ELIGIBLE", blocker: null });
  });

  it("today's EUR/USD: a live OANDA quote but no validated research stops at DATA_VALID", () => {
    const result = classifyMaturity({ ...ALL, researchValidated: false, shadowActive: false, shadowPassed: false, operatorApproved: false, protectedAdmissionActive: false });
    expect(result).toMatchObject({ stage: "DATA_VALID", blocker: { code: "NO_VALIDATED_RESEARCH" } });
  });

  it("an observed but unqualified quote (closed session, stale IEX book) is OBSERVABLE, never an opportunity", () => {
    expect(classifyMaturity({ ...ALL, quoteQualified: false })).toMatchObject({ stage: "OBSERVABLE", blocker: { code: "QUOTE_NOT_QUALIFIED" } });
  });

  it("names the first blocker and ignores later facts", () => {
    expect(classifyMaturity({ ...ALL, providerConfigured: false })).toMatchObject({ stage: "REGISTERED", blocker: { code: "PROVIDER_NOT_CONFIGURED" } });
    expect(classifyMaturity({ ...ALL, supported: false })).toMatchObject({ stage: "REGISTERED", blocker: { code: "NOT_SUPPORTED" } });
    expect(classifyMaturity({ ...ALL, historicalDatasetReady: false })).toMatchObject({ stage: "DATA_VALID", blocker: { code: "NO_HISTORICAL_DATASET" } });
    expect(classifyMaturity({ ...ALL, shadowPassed: false })).toMatchObject({ stage: "RESEARCH_READY", blocker: { code: "SHADOW_EVIDENCE_INSUFFICIENT" } });
    expect(classifyMaturity({ ...ALL, protectedAdmissionActive: false })).toMatchObject({ stage: "SHADOW_READY", blocker: { code: "PROTECTED_ADMISSION_NOT_ACTIVE" } });
    expect(classifyMaturity({ ...ALL, operatorApproved: false })).toMatchObject({ stage: "SHADOW_READY", blocker: { code: "NOT_OPERATOR_APPROVED" } });
  });

  it("property: the stage is monotone — turning any fact off never raises the stage", () => {
    const keys = Object.keys(ALL).filter((k) => k !== "instrumentId") as Array<keyof Omit<MaturityFacts, "instrumentId">>;
    for (let mask = 0; mask < 1 << keys.length; mask += 1) {
      const facts = { ...ALL };
      keys.forEach((k, i) => {
        facts[k] = Boolean(mask & (1 << i));
      });
      const base = MATURITY_STAGES.indexOf(classifyMaturity(facts).stage);
      for (const k of keys) {
        if (!facts[k]) continue;
        const lowered = MATURITY_STAGES.indexOf(classifyMaturity({ ...facts, [k]: false }).stage);
        expect(lowered).toBeLessThanOrEqual(base);
      }
      if (classifyMaturity(facts).stage === "PAPER_ELIGIBLE") expect(keys.every((k) => facts[k])).toBe(true);
    }
  });
});

describe("allocateScanCapacity", () => {
  const sol = Array.from({ length: 250 }, (_, i) => ({ id: `sol${i}`, assetClass: "SPOT_CRYPTO_PAIR" }));
  const fx = ["EURUSD", "GBPUSD", "USDJPY"].map((id) => ({ id, assetClass: "FX_SPOT" }));
  const etf = ["SPY", "QQQ"].map((id) => ({ id, assetClass: "EQUITY_ETF_PROXY" }));
  const gold = [{ id: "XAUUSD", assetClass: "COMMODITY_PROXY" }];

  it("crypto cannot consume all capacity because it has more candidates", () => {
    const picked = allocateScanCapacity([...sol, ...fx, ...etf, ...gold], 8);
    expect(picked).toHaveLength(8);
    expect(picked.filter((p) => p.assetClass === "SPOT_CRYPTO_PAIR")).toHaveLength(2);
    expect(picked.map((p) => p.id)).toEqual(expect.arrayContaining(["XAUUSD", "SPY", "QQQ", "EURUSD", "GBPUSD"]));
  });

  it("unused share flows to classes that still have candidates", () => {
    const picked = allocateScanCapacity([...sol.slice(0, 10), ...gold], 6);
    expect(picked.filter((p) => p.assetClass === "SPOT_CRYPTO_PAIR")).toHaveLength(5);
  });

  it("keeps caller order within a class and refuses bad capacity", () => {
    expect(allocateScanCapacity(sol, 3).map((p) => p.id)).toEqual(["sol0", "sol1", "sol2"]);
    expect(allocateScanCapacity(sol, 0)).toEqual([]);
    expect(allocateScanCapacity(sol, Number.NaN)).toEqual([]);
  });
});
