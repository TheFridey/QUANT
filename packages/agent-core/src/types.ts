import type {
  AgentName,
  CyclePair,
  EngineStatus,
  ObservationPoint,
  OperatorOrder,
  OrderIntent,
  OrderSide,
  ReasonCode,
  SecurityAssessment,
  StrategyConfig,
} from "@odin/shared";
import type { Mark } from "@odin/analytics";

export type PositionView = {
  pairAddress: string;
  baseSymbol: string;
  baseQty: string;
  avgCostUsd: string;
  realizedPnlUsd: string;
};

export type DecisionDraft = {
  agent: AgentName;
  modelVersion: string;
  pairAddress: string;
  decision: "PASS" | "REJECT" | "HOLD" | "ACT";
  confidence: string;
  reasonCodes: ReasonCode[];
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  inputSource?: string;
  durationMs?: number;
};

export type ProposedOrder = {
  clientOrderId: string;
  pairAddress: string;
  baseSymbol: string;
  side: OrderSide;
  intent: OrderIntent;
  qty: string;
  observationId: string;
  reasonCodes: ReasonCode[];
  /** When set, worker may defer fill until eligibleAt. */
  eligibleAt?: string;
  expiresAt?: string;
};

export type PlanInput = {
  cycleId: string;
  engineStatus: EngineStatus;
  config: StrategyConfig;
  cashUsd: string;
  startingBalanceUsd: string;
  positions: PositionView[];
  pairs: CyclePair[];
  marks: Record<string, Mark | undefined>;
  dailyPnlUsd: string | null;
  flatten: boolean;
  operator: OperatorOrder | null;
  /** Timestamped history keyed by pairAddress for PULSE indicators. */
  observationHistory?: Record<string, ObservationPoint[]>;
  /** Security assessments keyed by base mint. */
  securityByMint?: Record<string, SecurityAssessment>;
  /** Peak equity for drawdown / circuit breaker. */
  highWaterMarkUsd?: string | null;
  /** Current marked exposure of open positions. */
  aggregateExposureUsd?: string | null;
  now?: Date;
};

export function isIntent(value: unknown): value is OrderIntent {
  return value === "ENTRY" || value === "EXIT" || value === "FLATTEN" || value === "OPERATOR";
}
