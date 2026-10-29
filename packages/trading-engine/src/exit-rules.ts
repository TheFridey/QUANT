import { d, eventTimeMs, type StrategyConfig } from "@odin/shared";
import { applyBreakeven, updateTrailing, type PositionDirection } from "./protection.js";

export type ExitPositionState = {
  direction: PositionDirection;
  avgCostUsd: string;
  openedAt: string;
  /** Peak (long) or trough (short) mark for trailing. */
  extremeMarkUsd: string;
  qty: string;
};

export type ExitRuleHit = {
  intent: "EXIT";
  reasonCodes: string[];
  /** Suggested stop / trigger prices after evaluation (for persistence). */
  stopPriceUsd?: string | null;
  extremeMarkUsd?: string | null;
};

export type ExitRuleInput = {
  markUsd: string;
  markAt: string;
  position: ExitPositionState;
  config: Pick<
    StrategyConfig,
    "stopLossPct" | "takeProfitPct" | "trailingStopPct" | "maxHoldingMs" | "exitM5ChangePct"
  > & {
    /** Optional breakeven activation %; null/undefined disables. */
    breakevenActivatePct?: string | null;
    /** Momentum exit from m5 change — null skips. */
    priceChangeM5Pct?: string | null;
  };
};

/**
 * Shared stop / take-profit / trailing / time / breakeven exit evaluation.
 * Used by backtest engine and runtime protection paths for parity.
 * Deterministic: STOP before TAKE_PROFIT before TRAILING before TIME before MOMENTUM.
 */
export function evaluateExitRules(input: ExitRuleInput): ExitRuleHit | null {
  const mark = d(input.markUsd);
  if (mark.lte(0)) return null;
  const entry = d(input.position.avgCostUsd);
  if (entry.lte(0)) return null;
  const direction = input.position.direction;

  const pnlPct =
    direction === "LONG"
      ? mark.minus(entry).div(entry).mul(100)
      : entry.minus(mark).div(entry).mul(100);

  if (pnlPct.lte(d(input.config.stopLossPct).neg())) {
    return { intent: "EXIT", reasonCodes: ["STOP_LOSS"] };
  }
  if (pnlPct.gte(input.config.takeProfitPct)) {
    return { intent: "EXIT", reasonCodes: ["TAKE_PROFIT"] };
  }

  let extreme = input.position.extremeMarkUsd;
  let trailingStop: string | null = null;
  if (input.config.trailingStopPct !== null) {
    const trail = updateTrailing({
      direction,
      markUsd: input.markUsd,
      extremePriceUsd: extreme,
      trailPct: input.config.trailingStopPct,
    });
    extreme = trail.extremePriceUsd;
    trailingStop = trail.stopPriceUsd;
    const stopHit =
      direction === "LONG" ? mark.lte(trail.stopPriceUsd) : mark.gte(trail.stopPriceUsd);
    if (stopHit && d(extreme).gt(0)) {
      return {
        intent: "EXIT",
        reasonCodes: ["TRAILING_STOP"],
        stopPriceUsd: trailingStop,
        extremeMarkUsd: extreme,
      };
    }
  }

  if (input.config.breakevenActivatePct != null && input.config.breakevenActivatePct !== "") {
    const be = applyBreakeven({
      direction,
      entryPriceUsd: input.position.avgCostUsd,
      markUsd: input.markUsd,
      activateAtPct: input.config.breakevenActivatePct,
    });
    if (be.armed) {
      const hit = direction === "LONG" ? mark.lte(be.stopPriceUsd) : mark.gte(be.stopPriceUsd);
      if (hit) {
        return {
          intent: "EXIT",
          reasonCodes: ["STOP_LOSS"],
          stopPriceUsd: be.stopPriceUsd,
          extremeMarkUsd: extreme,
        };
      }
    }
  }

  if (input.config.maxHoldingMs !== null) {
    const opened = eventTimeMs(input.position.openedAt);
    const markAt = eventTimeMs(input.markAt);
    if (opened != null && markAt != null && markAt - opened >= input.config.maxHoldingMs) {
      return {
        intent: "EXIT",
        reasonCodes: ["MAX_HOLDING", "TIME_EXIT"],
        stopPriceUsd: trailingStop,
        extremeMarkUsd: extreme,
      };
    }
  }

  if (
    input.config.priceChangeM5Pct != null &&
    input.config.exitM5ChangePct != null &&
    d(input.config.priceChangeM5Pct).lte(input.config.exitM5ChangePct)
  ) {
    return {
      intent: "EXIT",
      reasonCodes: ["EXIT_MOMENTUM"],
      stopPriceUsd: trailingStop,
      extremeMarkUsd: extreme,
    };
  }

  return null;
}

/**
 * Absolute stop / take-profit prices from entry + pct (long or short).
 * Shared geometry for runtime arming and backtest assertions.
 */
export function protectionPricesFromEntry(input: {
  direction: PositionDirection;
  entryPriceUsd: string;
  stopLossPct: string;
  takeProfitPct: string;
}): { stopPriceUsd: string; takeProfitPriceUsd: string } {
  const entry = d(input.entryPriceUsd);
  const stopPct = d(input.stopLossPct).div(100);
  const tpPct = d(input.takeProfitPct).div(100);
  if (input.direction === "LONG") {
    return {
      stopPriceUsd: entry.mul(d("1").minus(stopPct)).toFixed(8),
      takeProfitPriceUsd: entry.mul(d("1").plus(tpPct)).toFixed(8),
    };
  }
  return {
    stopPriceUsd: entry.mul(d("1").plus(stopPct)).toFixed(8),
    takeProfitPriceUsd: entry.mul(d("1").minus(tpPct)).toFixed(8),
  };
}
