import type Decimal from "decimal.js";
import { d } from "./money.js";
import { spreadDecimal } from "./spread-bet-domain.js";
import { AURUM_GENERIC_GOLD_DFB_V1, sizeStake, validateProductSpec, type SizingReason, type SpreadBetProductSpec, type StakeSizing } from "./spread-bet.js";

/**
 * OPERATION AURUM: proposed simulation account parameters (docs/aurum/SCOPE.md §3). **Pure, unwired, proposed.**
 * No account is created from this. The AURUM account does not exist until PCR-AURUM-01 C3 (schema) and C10
 * (account isolation) are implemented and the operator approves these values (decision D5).
 *
 * `AURUM_ACCOUNT_CEILINGS` are code ceilings: a configuration above any of them is refused. Raising one needs a
 * reviewed code change, never a runtime input. No strategy, model, research agent or UI request can raise risk:
 * `sizeStakeWithinAccountRisk` takes the fraction from the configuration, and a caller may only ask for less.
 */

export type AurumAccountConfig = {
  status: "PROPOSED_PENDING_APPROVAL";
  accountCurrency: "GBP";
  initialBalanceGbp: string;
  riskPerTrade: string;
  dailyLossLimit: string;
  maxDrawdown: string;
  minStakeGbp: string;
  marginRate: string;
  overnightExposure: false;
  weekendExposure: false;
  directions: readonly ("LONG" | "SHORT")[];
  productId: string;
};

export const AURUM_PROPOSED_ACCOUNT_CONFIG: Readonly<AurumAccountConfig> = Object.freeze({
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
  directions: Object.freeze(["LONG", "SHORT"]) as readonly ("LONG" | "SHORT")[],
  productId: AURUM_GENERIC_GOLD_DFB_V1.id,
}) as AurumAccountConfig;

/** Ceilings. The SCOPE ceiling for risk per trade is 0.5%, below the sizing function's 2% hard ceiling. */
export const AURUM_ACCOUNT_CEILINGS = Object.freeze({ riskPerTrade: "0.005", dailyLossLimit: "0.02", maxDrawdown: "0.10" });

export type AurumConfigReason =
  | "INVALID_CONFIG"
  | "NOT_GBP"
  | "RISK_ABOVE_CEILING"
  | "DAILY_LOSS_ABOVE_CEILING"
  | "DRAWDOWN_ABOVE_CEILING"
  | "PRODUCT_MISMATCH"
  | "MIN_STAKE_BELOW_PRODUCT"
  | "MARGIN_BELOW_PRODUCT"
  | "OVERNIGHT_NOT_SUPPORTED"
  | "WEEKEND_NOT_SUPPORTED";

function pos(v: unknown): Decimal | null {
  const x = spreadDecimal(v);
  return x && x.gt(0) ? x : null;
}

export function validateAurumAccountConfig(c: AurumAccountConfig, spec: SpreadBetProductSpec = AURUM_GENERIC_GOLD_DFB_V1): { ok: true } | { ok: false; reason: AurumConfigReason } {
  if (!validateProductSpec(spec).ok) return { ok: false, reason: "INVALID_CONFIG" };
  const balance = pos(c?.initialBalanceGbp);
  const risk = pos(c?.riskPerTrade);
  const daily = pos(c?.dailyLossLimit);
  const dd = pos(c?.maxDrawdown);
  const minStake = pos(c?.minStakeGbp);
  const margin = pos(c?.marginRate);
  if (!balance || !risk || !daily || !dd || !minStake || !margin) return { ok: false, reason: "INVALID_CONFIG" };
  if (c.accountCurrency !== "GBP") return { ok: false, reason: "NOT_GBP" };
  if (risk.gt(AURUM_ACCOUNT_CEILINGS.riskPerTrade)) return { ok: false, reason: "RISK_ABOVE_CEILING" };
  if (daily.gt(AURUM_ACCOUNT_CEILINGS.dailyLossLimit)) return { ok: false, reason: "DAILY_LOSS_ABOVE_CEILING" };
  if (dd.gt(AURUM_ACCOUNT_CEILINGS.maxDrawdown)) return { ok: false, reason: "DRAWDOWN_ABOVE_CEILING" };
  if (c.productId !== spec.id) return { ok: false, reason: "PRODUCT_MISMATCH" };
  if (minStake.lt(spec.minStakeGbp)) return { ok: false, reason: "MIN_STAKE_BELOW_PRODUCT" };
  if (margin.lt(spec.marginRate)) return { ok: false, reason: "MARGIN_BELOW_PRODUCT" };
  if (margin.gt(1) || minStake.gt(spec.maxStakeGbp) || !minStake.mod(spec.stakeIncrementGbp).isZero()) return { ok: false, reason: "INVALID_CONFIG" };
  // Funding and weekend gaps are not modelled, so exposure across them cannot be simulated honestly.
  if (c.overnightExposure !== false) return { ok: false, reason: "OVERNIGHT_NOT_SUPPORTED" };
  if (c.weekendExposure !== false) return { ok: false, reason: "WEEKEND_NOT_SUPPORTED" };
  if (c.status !== "PROPOSED_PENDING_APPROVAL" || !Array.isArray(c.directions) || c.directions.length === 0 || c.directions.some((x) => x !== "LONG" && x !== "SHORT")) return { ok: false, reason: "INVALID_CONFIG" };
  return { ok: true };
}

export type AccountSizingReason = SizingReason | AurumConfigReason | "RISK_ABOVE_CONFIGURED" | "DIRECTION_NOT_ALLOWED";

type SizingInput = Parameters<typeof sizeStake>[0];

/**
 * Sizes a stake at the account's configured risk fraction. A caller (strategy, model, agent, UI) may pass
 * `requestedRiskFraction` to ask for *less*; asking for more is refused, not clamped, so the attempt is visible.
 * The product's minimum stake is the larger of the spec's and the account's.
 */
export function sizeStakeWithinAccountRisk(
  input: Omit<SizingInput, "riskFraction"> & { config: AurumAccountConfig; requestedRiskFraction?: string },
): { ok: true; value: StakeSizing & { riskFractionUsed: string } } | { ok: false; reason: AccountSizingReason } {
  const { config, requestedRiskFraction, ...rest } = input;
  const valid = validateAurumAccountConfig(config, rest.spec);
  if (!valid.ok) return valid;
  if (!config.directions.includes(rest.direction)) return { ok: false, reason: "DIRECTION_NOT_ALLOWED" };
  const configured = d(config.riskPerTrade);
  let fraction = configured;
  if (requestedRiskFraction !== undefined) {
    const req = pos(requestedRiskFraction);
    if (!req) return { ok: false, reason: "INVALID_INPUT" };
    if (req.gt(configured)) return { ok: false, reason: "RISK_ABOVE_CONFIGURED" };
    fraction = req;
  }
  const spec: SpreadBetProductSpec = { ...rest.spec, minStakeGbp: config.minStakeGbp, marginRate: config.marginRate };
  const sized = sizeStake({ ...rest, spec, riskFraction: fraction.toFixed() });
  if (!sized.ok) return sized;
  return { ok: true, value: { ...sized.value, riskFractionUsed: fraction.toFixed() } };
}
