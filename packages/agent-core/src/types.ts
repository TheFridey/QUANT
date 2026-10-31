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
import type { OrderOwnerScope, TradeIntentAction, TradeIntentSource } from "@odin/shared";

export type PositionView = {
  pairAddress: string;
  baseSymbol: string;
  baseQty: string;
  avgCostUsd: string;
  realizedPnlUsd: string;
  /** ISO time of opening fill when known — used for max-hold exits. */
  openedAt?: string | null;
  /** Peak mark since entry when known — used for trailing stops. */
  peakMarkUsd?: string | null;
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
  /** Concurrent StrategyInstance owner when allocation attributed this order. */
  strategyInstanceId?: string | null;
  /** Canonical TradeIntent identity (Stages 2–4). */
  intentId?: string;
  idempotencyKey?: string;
  intentSource?: TradeIntentSource;
  intentAction?: TradeIntentAction;
  /** Who owns the fill's economic consequence (settlement policy). */
  ownerScope?: OrderOwnerScope;
  /** Estimated cash cost (notional + fee) used for reservations — same number the planner sized against. */
  estimatedCostUsd?: string;
  /** Estimated notional at the decision quote. */
  estimatedNotionalUsd?: string;
  strategyVersion?: string | null;
};

/**
 * One independently identified strategy intent entering planning.
 * Many intents may target the same pairAddress; none overwrite each other.
 */
export type PlanIntent = {
  intentId: string;
  idempotencyKey: string;
  clientOrderId: string;
  source: TradeIntentSource;
  strategyInstanceId: string;
  strategyVersion: string;
  moduleRef: string | null;
  artifactHash: string | null;
  sourceHash: string | null;
  configHash: string | null;
  instrumentId: string;
  pairAddress: string;
  action: "ENTER" | "EXIT" | "REDUCE";
  /** REDUCE only: requested quantity (capped by owned, unreserved quantity). */
  requestedQty?: string | null;
  reasonCodes: string[];
  observationReceivedAt: string | null;
};

export type IntentOutcome = {
  intentId: string;
  idempotencyKey: string;
  clientOrderId: string;
  strategyInstanceId: string | null;
  pairAddress: string;
  action: PlanIntent["action"] | "CLOSE_NET" | "FLATTEN";
  status: "ADMITTED" | "DEFERRED" | "REJECTED";
  reason: string;
  sizedQty: string | null;
  sizedNotionalUsd: string | null;
};

export type AllocationCapacityView = {
  qty: string;
  reservedExitQty: string;
};

export type PlanInput = {
  cycleId: string;
  engineStatus: EngineStatus;
  config: StrategyConfig;
  cashUsd: string;
  startingBalanceUsd: string;
  /** Equity at the Europe/London day start; the daily loss limit is measured against it (audit L3). */
  dayStartEquityUsd?: string | null;
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
  /** Account-wide entry suspension after reconcile unknown exposure. */
  entriesSuspended?: boolean;
  /** Active strategy module id when promotion drives decisions. */
  activeStrategyId?: string | null;
  /**
   * When concurrent StrategyInstances are active, ENTRY is allowed only for
   * pairs present in this set (from allocateOpportunities). An empty set means
   * zero automatic entries — never treat emptiness as "ungated".
   * Undefined/null = no instance gating (legacy single-pulse path).
   * Exits always pass this gate.
   */
  /** Execution account (identity of non-strategy intents). */
  accountId?: string;
  /**
   * Strategy-instance intents in fair order (exits first). null/undefined = legacy
   * ungated global PULSE entries. An empty array means zero automatic entries.
   */
  instanceIntents?: readonly PlanIntent[] | null;
  /** Max new net positions this cycle (account slot capacity). */
  maxNewEntries?: number;
  /** Owned allocation keyed by `${strategyInstanceId}::${pairAddress}` (Stage 9). */
  allocations?: ReadonlyMap<string, AllocationCapacityView> | null;
  /** Instance capital still available (budget − filled − pending), keyed by instance id (Stage 5). */
  instanceAvailableUsd?: ReadonlyMap<string, string> | null;
  /** `${strategyInstanceId}::${pairAddress}` with a pending ENTRY already in flight. */
  pendingEntryKeys?: ReadonlySet<string> | null;
  /** Pairs with an in-flight net/flatten/protection close — owner exits wait. */
  pendingNetCloseByPair?: ReadonlySet<string> | null;
  /**
   * Effective MarketSelection: instrumentId → enabled.
   * When present, automatic ENTRY is refused for disabled markets.
   * Open holdings continue to monitor/exit regardless.
   */
  marketEntryEnabled?: ReadonlyMap<string, boolean> | null;
  now?: Date;
};

export function isIntent(value: unknown): value is OrderIntent {
  return value === "ENTRY" || value === "EXIT" || value === "FLATTEN" || value === "OPERATOR";
}
