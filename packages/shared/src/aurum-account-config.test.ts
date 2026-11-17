import { describe, expect, it } from "vitest";
import { AURUM_ACCOUNT_CEILINGS, AURUM_PROPOSED_ACCOUNT_CONFIG, sizeStakeWithinAccountRisk, validateAurumAccountConfig } from "./aurum-account-config.js";
import { AURUM_GENERIC_GOLD_DFB_V1, sizeStake } from "./spread-bet.js";

const C = AURUM_PROPOSED_ACCOUNT_CONFIG;
const base = {
  spec: AURUM_GENERIC_GOLD_DFB_V1,
  direction: "LONG" as const,
  equityGbp: "10000",
  entry: "2650.55",
  closingSide: "2649.95",
  stop: "2640.55",
  slippageAllowancePoints: "2",
  availableMarginGbp: "10000",
  usedMarginGbp: "0",
  maxMarginUtilisation: "0.3",
  config: C,
};

describe("AURUM proposed account configuration (unwired, pending approval)", () => {
  it("matches the proposal: GBP, £10,000, 0.25% per trade, 2% daily, 10% drawdown, flat overnight and weekend", () => {
    expect(C).toMatchObject({
      status: "PROPOSED_PENDING_APPROVAL",
      accountCurrency: "GBP",
      initialBalanceGbp: "10000",
      riskPerTrade: "0.0025",
      dailyLossLimit: "0.02",
      maxDrawdown: "0.10",
      minStakeGbp: "0.5",
      marginRate: "0.05",
      overnightExposure: false,
      weekendExposure: false,
      directions: ["LONG", "SHORT"],
    });
    expect(validateAurumAccountConfig(C)).toEqual({ ok: true });
    expect(Object.isFrozen(C)).toBe(true);
  });

  it("refuses any value above a ceiling or below the product, and unsupported exposure", () => {
    expect(validateAurumAccountConfig({ ...C, riskPerTrade: "0.0051" })).toEqual({ ok: false, reason: "RISK_ABOVE_CEILING" });
    expect(validateAurumAccountConfig({ ...C, riskPerTrade: "0.02" })).toEqual({ ok: false, reason: "RISK_ABOVE_CEILING" });
    expect(validateAurumAccountConfig({ ...C, dailyLossLimit: "0.021" })).toEqual({ ok: false, reason: "DAILY_LOSS_ABOVE_CEILING" });
    expect(validateAurumAccountConfig({ ...C, maxDrawdown: "0.11" })).toEqual({ ok: false, reason: "DRAWDOWN_ABOVE_CEILING" });
    expect(validateAurumAccountConfig({ ...C, minStakeGbp: "0.1" })).toEqual({ ok: false, reason: "MIN_STAKE_BELOW_PRODUCT" });
    expect(validateAurumAccountConfig({ ...C, marginRate: "0.01" })).toEqual({ ok: false, reason: "MARGIN_BELOW_PRODUCT" });
    expect(validateAurumAccountConfig({ ...C, overnightExposure: true as never })).toEqual({ ok: false, reason: "OVERNIGHT_NOT_SUPPORTED" });
    expect(validateAurumAccountConfig({ ...C, weekendExposure: true as never })).toEqual({ ok: false, reason: "WEEKEND_NOT_SUPPORTED" });
    expect(validateAurumAccountConfig({ ...C, accountCurrency: "USD" as never })).toEqual({ ok: false, reason: "NOT_GBP" });
    expect(validateAurumAccountConfig({ ...C, productId: "other" })).toEqual({ ok: false, reason: "PRODUCT_MISMATCH" });
    for (const bad of ["", "-0.001", "NaN", "Infinity", "x"]) expect(validateAurumAccountConfig({ ...C, riskPerTrade: bad }).ok).toBe(false);
    expect(AURUM_ACCOUNT_CEILINGS.riskPerTrade).toBe("0.005");
  });

  it("sizes at the configured 0.25%, independently of the sizing function's 2% ceiling", () => {
    const r = sizeStakeWithinAccountRisk(base);
    // 10,000 × 0.25% = £25 over (10 + 2) points → £2.08/point.
    expect(r).toMatchObject({ ok: true, value: { stakeGbp: "2.08", permittedRiskGbp: "25.00", riskFractionUsed: "0.0025" } });
    // The raw function would happily size at 2%.
    expect(sizeStake({ ...base, riskFraction: "0.02" })).toMatchObject({ ok: true, value: { permittedRiskGbp: "200.00" } });
  });

  it("a caller may ask for less risk, never more", () => {
    expect(sizeStakeWithinAccountRisk({ ...base, requestedRiskFraction: "0.001" })).toMatchObject({ ok: true, value: { riskFractionUsed: "0.001", permittedRiskGbp: "10.00" } });
    expect(sizeStakeWithinAccountRisk({ ...base, requestedRiskFraction: "0.0026" })).toEqual({ ok: false, reason: "RISK_ABOVE_CONFIGURED" });
    expect(sizeStakeWithinAccountRisk({ ...base, requestedRiskFraction: "0.02" })).toEqual({ ok: false, reason: "RISK_ABOVE_CONFIGURED" });
    expect(sizeStakeWithinAccountRisk({ ...base, requestedRiskFraction: "-1" })).toEqual({ ok: false, reason: "INVALID_INPUT" });
    // A raised config is refused before sizing, so it cannot be smuggled in either.
    expect(sizeStakeWithinAccountRisk({ ...base, config: { ...C, riskPerTrade: "0.01" } })).toEqual({ ok: false, reason: "RISK_ABOVE_CEILING" });
  });

  it("short sizing works; the minimum stake is refused, never rounded up", () => {
    expect(sizeStakeWithinAccountRisk({ ...base, direction: "SHORT", entry: "2649.95", closingSide: "2650.55", stop: "2659.95" })).toMatchObject({
      ok: true,
      value: { stakeGbp: "2.08" },
    });
    expect(sizeStakeWithinAccountRisk({ ...base, stop: "2590.55" })).toEqual({ ok: false, reason: "MIN_STAKE_EXCEEDS_RISK" });
    expect(sizeStakeWithinAccountRisk({ ...base, config: { ...C, directions: ["LONG"] }, direction: "SHORT", entry: "2649.95", closingSide: "2650.55", stop: "2659.95" })).toEqual({
      ok: false,
      reason: "DIRECTION_NOT_ALLOWED",
    });
  });
});
