import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { spreadDecimal } from "./spread-bet-domain.js";
import { AURUM_GENERIC_GOLD_DFB_V1 as spec, bookGbp, deriveSpreadBetQuote, entryPrice, exitPrice, marginGbp, notionalGbp, pnlGbp, sizeStake, stopFillPrice, validateProductSpec } from "./spread-bet.js";
import { AURUM_PROPOSED_ACCOUNT_CONFIG as config, sizeStakeWithinAccountRisk, validateAurumAccountConfig } from "./aurum-account-config.js";

const base = {
  spec, direction: "LONG" as const, equityGbp: "10000", riskFraction: "0.0025",
  entry: "2650.55", closingSide: "2649.95", stop: "2640.55", slippageAllowancePoints: "2",
  availableMarginGbp: "10000", usedMarginGbp: "0", maxMarginUtilisation: "0.3",
};
const invalid = ["1e400", "1e999999999999999", "1e-400", "1e-999999999999999", "1e16", "9999999999999999.999999999", "1e-9", "NaN", "Infinity", "-Infinity", "0x10", "", " ", "1".repeat(65)];

describe("spread-bet numerical domain (pure, inactive)", () => {
  it("reproduces the distinction behind the reported 1e400 defect", () => {
    expect(new Decimal("1e400").isFinite()).toBe(true);
    expect(Number.isFinite(Number("1e400"))).toBe(false);
    expect(sizeStake({ ...base, equityGbp: "1e400" })).toEqual({ ok: false, reason: "INVALID_INPUT" });
  });
  it.each(invalid)("rejects unsupported representation %s before any financial calculation", (value) => {
    expect(spreadDecimal(value)).toBeNull();
    for (const field of ["equityGbp", "entry", "closingSide", "stop", "slippageAllowancePoints", "availableMarginGbp", "usedMarginGbp", "maxMarginUtilisation"] as const) {
      expect(sizeStake({ ...base, [field]: value })).toEqual({ ok: false, reason: "INVALID_INPUT" });
    }
    expect(sizeStake({ ...base, riskFraction: value })).toEqual({ ok: false, reason: "INVALID_RISK_FRACTION" });
    expect(validateAurumAccountConfig({ ...config, initialBalanceGbp: value })).toEqual({ ok: false, reason: "INVALID_CONFIG" });
    expect(sizeStakeWithinAccountRisk({ ...base, config, requestedRiskFraction: value }).ok).toBe(false);
    expect(pnlGbp({ spec, direction: "LONG", stakeGbp: value, entry: "1", exit: "2" }).ok).toBe(false);
    expect(() => notionalGbp(spec, "1", value)).toThrow("INVALID_INPUT");
    expect(() => marginGbp(spec, value, "1")).toThrow("INVALID_INPUT");
    expect(() => stopFillPrice("LONG", value, "1")).toThrow("INVALID_INPUT");
  });

  it("accepts representable boundaries exactly without numeric coercion or rounding", () => {
    expect(spreadDecimal("9999999999999999.99999999")?.toFixed()).toBe("9999999999999999.99999999");
    expect(spreadDecimal("1e-8")?.toFixed()).toBe("0.00000001");
    expect(spreadDecimal("1.0000000000")?.toFixed()).toBe("1");
    expect(sizeStake({ ...base, equityGbp: "9999999999999999.99999999", availableMarginGbp: "9999999999999999.99999999" }).ok).toBe(true);
    expect(sizeStake({ ...base, equityGbp: "0.00000001" })).toEqual({ ok: false, reason: "MIN_STAKE_EXCEEDS_RISK" });
    expect(sizeStake({ ...base, equityGbp: "-1" }).ok).toBe(false);
    expect(sizeStake({ ...base, equityGbp: "0" }).ok).toBe(false);
    expect(pnlGbp({ spec, direction: "LONG", stakeGbp: "-1", entry: "1", exit: "2" }).ok).toBe(false);
  });

  it("rejects invalid point sizes, costs, malformed specs and unmodelled funding claims", () => {
    for (const pointSize of ["0", "-1", ...invalid]) expect(validateProductSpec({ ...spec, pointSize }).ok).toBe(false);
    expect(validateProductSpec({ ...spec, spreadPoints: {} as never }).ok).toBe(false);
    expect(validateProductSpec({ ...spec, spreadPoints: { ...spec.spreadPoints, BASELINE: "-1" } }).ok).toBe(false);
    expect(validateProductSpec({ ...spec, overnightFundingModelled: true as never }).ok).toBe(false);
    expect(sizeStake({ ...base, slippageAllowancePoints: "-1" }).ok).toBe(false);
    expect(sizeStake({ ...base, stop: base.entry }).ok).toBe(false);
    expect(validateAurumAccountConfig({ ...config, marginRate: "1.01" }).ok).toBe(false);
    expect(validateAurumAccountConfig({ ...config, minStakeGbp: "0.501" }).ok).toBe(false);
    for (const stakeGbp of ["0", "-1", "0.001", "5.01"]) {
      expect(pnlGbp({ spec, direction: "LONG", stakeGbp, entry: "1", exit: "2" }).ok).toBe(false);
    }
    expect(pnlGbp({ spec, direction: "LONG", stakeGbp: "0.01", entry: "1", exit: "2" }).ok).toBe(true);
    for (const q of [{ bid: "1e400", ask: "2e400" }, { bid: "0", ask: "1" }, { bid: "2", ask: "1" }]) {
      expect(() => entryPrice("LONG", q)).toThrow("INVALID_INPUT");
      expect(() => exitPrice("SHORT", q)).toThrow("INVALID_INPUT");
    }
  });

  it("rejects derived booked overflow and rounding into overflow", () => {
    const overflowSpec = { ...spec, pointSize: "0.00000001", maxStakeGbp: "9999999999999999" };
    expect(pnlGbp({ spec: overflowSpec, direction: "LONG", stakeGbp: "9999999999999999", entry: "1", exit: "9999999999999999" })).toEqual({ ok: false, reason: "INVALID_INPUT" });
    expect(() => notionalGbp(overflowSpec, "9999999999999999", "9999999999999999")).toThrow("INVALID_INPUT");
    expect(() => bookGbp(new Decimal("-9999999999999999999999.999"))).toThrow("INVALID_INPUT");
    expect(() => bookGbp(new Decimal("1e22"))).toThrow("INVALID_INPUT");
    expect(pnlGbp({ spec: { ...spec, pointSize: "0.00000001" }, direction: "LONG", stakeGbp: "5", entry: "1", exit: "9999999999999999" })).toEqual({ ok: false, reason: "INVALID_INPUT" });
    expect(deriveSpreadBetQuote({ ...spec, pointSize: "0.00000001" }, { kind: "REFERENCE_MARKET_QUOTE", instrumentId: spec.referenceInstrumentId, provider: "TEST", quoteId: "test", eventTime: "2026-11-17T00:00:00Z", bid: "1", ask: "9999999999999999" }, "BASELINE").ok).toBe(false);
    expect(() => bookGbp(new Decimal("NaN"))).toThrow("INVALID_INPUT");
    expect(deriveSpreadBetQuote(spec, { kind: "REFERENCE_MARKET_QUOTE", instrumentId: spec.referenceInstrumentId, quoteId: "q", provider: "test", bid: "9999999999999999.99", ask: "9999999999999999.99999999", eventTime: "2026-11-17T12:00:00Z" }, "SEVERE").ok).toBe(false);
  });

  it("honours a more conservative configured margin rate and refuses caller risk escalation", () => {
    expect(sizeStakeWithinAccountRisk({ ...base, config: { ...config, marginRate: "0.1" }, availableMarginGbp: "300" })).toEqual({ ok: false, reason: "INSUFFICIENT_MARGIN" });
    for (let i = 1; i <= 100; i++) {
      expect(sizeStakeWithinAccountRisk({ ...base, config, requestedRiskFraction: new Decimal(config.riskPerTrade).plus(new Decimal(i).div(100000000)).toFixed() })).toEqual({ ok: false, reason: "RISK_ABOVE_CONFIGURED" });
    }
    expect(sizeStakeWithinAccountRisk({ ...base, config: { ...config, marginRate: "0.1" } })).toMatchObject({ ok: true, value: { stakeGbp: "2.08", marginGbp: "551.32" } });
    for (const risk of ["0.00250001", "0.005", "0.02", "1"]) expect(sizeStakeWithinAccountRisk({ ...base, config, requestedRiskFraction: risk })).toEqual({ ok: false, reason: "RISK_ABOVE_CONFIGURED" });
  });

  it("bounded sampling preserves risk, stake increment, margin and long/short P&L symmetry", () => {
    for (let i = 1; i <= 250; i++) {
      const equity = String(1000 + i * 137);
      const r = sizeStake({ ...base, equityGbp: equity, slippageAllowancePoints: (i % 3 === 0 ? "0.00000001" : "2") });
      if (r.ok) {
        const value = r.value;
        expect(new Decimal(value.estimatedLossAtStopGbp).lte(value.permittedRiskGbp)).toBe(true);
        expect(new Decimal(value.stakeGbp).mod(spec.stakeIncrementGbp).isZero()).toBe(true);
        expect(new Decimal(value.stakeGbp).lte(spec.maxStakeGbp)).toBe(true);
        expect(new Decimal(value.marginGbp).lte(base.availableMarginGbp)).toBe(true);
      }
      const long = pnlGbp({ spec, direction: "LONG", stakeGbp: "1.37", entry: "2650.55", exit: String(2400 + i) });
      const short = pnlGbp({ spec, direction: "SHORT", stakeGbp: "1.37", entry: "2650.55", exit: String(2400 + i) });
      expect(long.ok && short.ok && long.value.plus(short.value).isZero()).toBe(true);
    }
  });

  it("stake penny correction remains bounded for the smallest supported increment", () => {
    const tiny = { ...spec, stakeIncrementGbp: "0.00000001", minStakeGbp: "0.00000001" };
    const r = sizeStake({ ...base, spec: tiny, equityGbp: "10000.8", riskFraction: "0.005", slippageAllowancePoints: "0.0005" });
    expect(r.ok && new Decimal(r.value.estimatedLossAtStopGbp).lte(r.value.permittedRiskGbp)).toBe(true);
  });
});
