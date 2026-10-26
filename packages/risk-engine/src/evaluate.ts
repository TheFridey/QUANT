import { confidenceFixed, d, type DataState, type EngineStatus, type OrderIntent, type OrderSide, type ReasonCode } from "@odin/shared";
import { Decimal } from "@odin/shared";

export type ValuationState = DataState | "INCOMPLETE" | "CASH_ONLY";

export type RiskContext = {
  engineStatus: EngineStatus;
  side: OrderSide;
  intent: OrderIntent;
  freshness: DataState;
  allowDelayedExits: boolean;
  openPositions: number;
  maxPositions: number;
  dailyPnlUsd: string | null;
  startingBalanceUsd: string;
  maxDailyLossPct: string;
  valuation: ValuationState;
};

export type RiskGate = {
  decision: "PASS" | "REJECT";
  reasonCodes: ReasonCode[];
  confidence: string;
};

export function evaluateRisk(input: RiskContext): RiskGate {
  if (input.engineStatus === "EMERGENCY_STOP" && input.intent !== "FLATTEN") {
    return gate("REJECT", ["EMERGENCY_STOP"], 1);
  }
  if (input.intent === "FLATTEN") {
    if (input.engineStatus !== "EMERGENCY_STOP" && input.engineStatus !== "RUNNING") {
      return gate("REJECT", ["ENGINE_HALTED"], 1);
    }
  } else if (input.engineStatus !== "RUNNING") {
    return gate("REJECT", ["ENGINE_HALTED"], 1);
  }

  const freshness = freshnessGate(input);
  if (freshness) return freshness;

  if (input.side === "BUY") {
    if (input.valuation === "INCOMPLETE") return gate("REJECT", ["MARK_UNAVAILABLE"], 0);
    if (input.valuation !== "LIVE" && input.valuation !== "CASH_ONLY") {
      return gate("REJECT", ["VALUATION_NOT_LIVE"], 1);
    }
    if (input.dailyPnlUsd === null) return gate("REJECT", ["DAILY_PNL_UNAVAILABLE"], 0);
    const limit = d(input.startingBalanceUsd).mul(d(input.maxDailyLossPct)).div(100);
    if (d(input.dailyPnlUsd).lte(limit.neg())) return gate("REJECT", ["DAILY_LOSS_LIMIT"], 1);
    if (input.openPositions >= input.maxPositions) return gate("REJECT", ["MAX_POSITIONS"], 1);
  }

  const reasons: ReasonCode[] = [];
  if (input.freshness === "DELAYED") reasons.push("DATA_DELAYED_EXIT_ALLOWED");
  reasons.push("RISK_OK");
  return gate("PASS", reasons, 1);
}

function freshnessGate(input: RiskContext): RiskGate | null {
  if (input.freshness === "STALE") return gate("REJECT", ["DATA_STALE"], 1);
  if (input.freshness === "REPLAY") return gate("REJECT", ["DATA_REPLAY"], 1);
  if (input.freshness === "DEMO") return gate("REJECT", ["DATA_DEMO"], 1);
  if (input.freshness === "DELAYED" && !(input.side === "SELL" && input.allowDelayedExits)) {
    return gate("REJECT", ["DATA_DELAYED"], 1);
  }
  return null;
}

function gate(decision: "PASS" | "REJECT", reasonCodes: ReasonCode[], confidence: number): RiskGate {
  return { decision, reasonCodes, confidence: confidenceFixed(new Decimal(confidence)) };
}
