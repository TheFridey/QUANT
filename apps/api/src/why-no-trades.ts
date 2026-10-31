import { isReasonCode, REASON_TEXT } from "@odin/shared";

/**
 * Operator-facing reason families for "why is nothing trading?".
 * Order is precedence: when one evaluation carries several codes, the earliest family wins,
 * so an account-wide suspension is never reported as "no signal".
 */
export const NO_TRADE_FAMILIES = {
  SAFETY_SUSPENSION: {
    label: "Safety suspension",
    action: "Entries are suspended. Resolve recovery prerequisites, then use Reconcile & resume entries.",
    codes: ["ENTRIES_SUSPENDED", "PAUSE_NEW_ENTRIES", "EMERGENCY_STOP", "SAFETY_SUSPENDED"],
  },
  RECONCILIATION_REQUIRED: {
    label: "Reconciliation required",
    action: "Open recovery cases or a non-clean reconciliation block entries. Review Capacity → Recovery cases.",
    codes: ["RECONCILE_ISSUE", "RECONCILE_REQUIRED", "RECONCILIATION_REQUIRED", "STATE_CHANGED", "ALLOCATION_DRIFT", "UNKNOWN_SUBMISSION"],
  },
  PROTECTION_ISSUE: {
    label: "Protection issue",
    action: "A protective exit is unresolved or rejected. Check Positions → protection before adding risk.",
    codes: ["PROTECTION_UNRESOLVED", "PROTECTION_RECOVERY", "PROTECTION_GAP", "VENUE_PROTECTION_REJECTED", "PROTECTION_UNAVAILABLE"],
  },
  BROKER_UNAVAILABLE: {
    label: "Broker unavailable",
    action: "The execution venue is not ready (credentials or connectivity). Internal paper is unaffected.",
    codes: ["BLOCKED_EXTERNAL", "MISSING_CREDENTIALS", "PROVIDER_NOT_READY", "EXTERNAL_DEMO_NOT_CONFIGURED", "BROKER_UNAVAILABLE"],
  },
  ENGINE_NOT_RUNNING: {
    label: "Engine not running",
    action: "Start or resume the engine from the command bar.",
    codes: ["ENGINE_HALTED", "ENGINE_NOT_RUNNING"],
  },
  STRATEGY_PAUSED: {
    label: "Strategy paused or disabled",
    action: "Resume the strategy instance in Capacity & Allocations.",
    codes: ["STRATEGY_PAUSED", "STRATEGY_DISABLED", "INSTANCE_PAUSED", "INSTANCE_DISABLED", "STRATEGY_INSTANCE_INACTIVE"],
  },
  UNSUPPORTED_MODULE: {
    label: "Unsupported strategy module/version",
    action: "The instance is bound to a module or version this runtime cannot execute. Rebind via promotion.",
    codes: ["UNSUPPORTED_MODULE", "MODULE_UNSUPPORTED", "UNSUPPORTED_MODULE_VERSION", "MODULE_NOT_FOUND", "STRATEGY_BINDING_INVALID"],
  },
  MARKET_NOT_SELECTED: {
    label: "Market not selected",
    action: "Automatic entries are disabled for this instrument. Enable it in Market Selector.",
    codes: ["MARKET_ENTRY_DISABLED", "MARKET_NOT_SELECTED"],
  },
  UNSUPPORTED_INSTRUMENT: {
    label: "Unsupported instrument",
    action: "This instrument cannot receive paper fills (research-only, closed session, or incomplete product economics).",
    codes: [
      "INDEX_NOT_EXECUTABLE",
      "INDEX_NO_EXECUTION",
      "RESEARCH_ONLY",
      "NO_EXECUTION",
      "PRODUCT_SEMANTICS_UNSUPPORTED",
      "SESSION_CLOSED",
      "QUOTE_NOT_ALLOWED",
      "FIXTURE_ISOLATION",
      "UNSUPPORTED_INSTRUMENT",
    ],
  },
  STALE_DATA: {
    label: "Stale or missing data",
    action: "Quotes are stale, delayed, or missing. Check the market feed and provider health.",
    codes: [
      "DATA_STALE",
      "DATA_DELAYED",
      "DATA_DEMO",
      "DATA_REPLAY",
      "MISSING_PRICE",
      "NON_POSITIVE_PRICE",
      "MISSING_LIQUIDITY",
      "MISSING_VOLUME",
      "UPSTREAM_UNAVAILABLE",
      "EMPTY_UNIVERSE",
      "MARK_UNAVAILABLE",
      "VALUATION_NOT_LIVE",
      "QUOTE_STALE_AT_FILL",
      "PAIR_NOT_IN_SNAPSHOT",
      "FX_RATE_UNAVAILABLE",
      "DAILY_PNL_UNAVAILABLE",
      "INSUFFICIENT_DATA",
      "INSUFFICIENT_HISTORY",
      "STALE_DATA",
    ],
  },
  INSTANCE_BUDGET_EXHAUSTED: {
    label: "Instance budget exhausted",
    action: "The strategy's budget is fully committed (filled + pending). Raise the budget or wait for exits.",
    codes: ["BUDGET_EXHAUSTED", "INSTANCE_BUDGET_EXHAUSTED", "INSTANCE_CAPACITY_EXHAUSTED"],
  },
  ACCOUNT_CAPACITY_EXHAUSTED: {
    label: "Account capacity exhausted",
    action: "Account cash, position slots, or aggregate exposure are used up.",
    codes: ["MAX_POSITIONS", "INSUFFICIENT_CASH", "AGGREGATE_EXPOSURE", "RESERVATION_REJECTED", "ACCOUNT_CAPACITY_EXHAUSTED"],
  },
  RISK_LIMIT: {
    label: "Risk limit or sizing",
    action: "Loss limits, drawdown, breaker, or order sizing prevented the entry. Review Risk Management.",
    codes: [
      "DAILY_LOSS_LIMIT",
      "TOTAL_DRAWDOWN_LIMIT",
      "CIRCUIT_BREAKER",
      "SIZE_ZERO",
      "BELOW_MIN_NOTIONAL",
      "MIN_ORDER_EXCEEDS_RISK_CAP",
      "SIZE_ABOVE_CAP",
      "SLIPPAGE_LIMIT",
      "PRICE_IMPACT_LIMIT",
    ],
  },
  WAITING_FAIR_ALLOCATION: {
    label: "Waiting for fair allocation",
    action: "Another instance holds the shared capacity this cycle; the intent is deferred, not dropped.",
    codes: ["WAITING_FAIR_ALLOCATION", "FAIR_ALLOCATION", "FAIRNESS_DEFERRED", "STRATEGY_INSTANCE_GATING"],
  },
  SECURITY_SCREEN: {
    label: "Security screen",
    action:
      "Token security review, block or UNKNOWN prevented the entry. UNKNOWN is not PASS: Solana entries need a positive assessment (set BIRDEYE_API_KEY or a dedicated SOLANA_RPC_URL for holder data).",
    codes: [
      "SECURITY_BLOCK",
      "SECURITY_REVIEW",
      "SECURITY_UNKNOWN",
      "BLOCKED_BY_SENTINEL",
      "MINT_AUTHORITY_PRESENT",
      "FREEZE_AUTHORITY_PRESENT",
      "HOLDER_CONCENTRATION",
      "LIQUIDITY_FRAGILE",
    ],
  },
  NO_ELIGIBLE_SIGNAL: {
    label: "No eligible signal",
    action: "Entry rules were not met. A quiet market is normal; there is no trade quota.",
    codes: ["NO_EDGE", "NO_INTENT", "PRICE_ANOMALY", "LIQUIDITY_FLOOR", "VOLUME_FLOOR", "DISCOVERY_FILTERED", "ALREADY_HELD", "NO_ORDER"],
  },
} as const satisfies Record<string, { label: string; action: string; codes: readonly string[] }>;

export type NoTradeFamilyId = keyof typeof NO_TRADE_FAMILIES;

export const NO_TRADE_FAMILY_ORDER = Object.keys(NO_TRADE_FAMILIES) as NoTradeFamilyId[];

const CODE_TO_FAMILY = new Map<string, NoTradeFamilyId>();
for (const family of NO_TRADE_FAMILY_ORDER) {
  for (const code of NO_TRADE_FAMILIES[family].codes) CODE_TO_FAMILY.set(code, family);
}

function precedence(family: NoTradeFamilyId): number {
  return NO_TRADE_FAMILY_ORDER.indexOf(family);
}

function tokens(value: string): string[] {
  return value.toUpperCase().split(/[^A-Z0-9_]+/).filter(Boolean);
}

/** Highest-precedence family for an explicit statusReason (preferred) or reason codes. */
export function classifyNoTradeReason(statusReason: string | null | undefined, reasonCodes: readonly string[] = []): NoTradeFamilyId | null {
  if (statusReason) {
    const fromReason = bestFamily(tokens(statusReason));
    if (fromReason) return fromReason;
  }
  return bestFamily(reasonCodes);
}

export function bestFamily(codes: readonly string[]): NoTradeFamilyId | null {
  let best: NoTradeFamilyId | null = null;
  for (const code of codes) {
    const family = CODE_TO_FAMILY.get(code);
    if (family && (best === null || precedence(family) < precedence(best))) best = family;
  }
  return best;
}

export function reasonText(code: string): string {
  return isReasonCode(code) ? REASON_TEXT[code] : code.replace(/_/g, " ").toLowerCase();
}

export type WhyNoTradesWindow = "1H" | "24H" | "7D";

export function parseWindow(raw: string | undefined): WhyNoTradesWindow {
  const value = (raw ?? "").toUpperCase();
  return value === "1H" || value === "7D" ? value : "24H";
}

export function windowStart(window: WhyNoTradesWindow, now: Date): Date {
  const hours = window === "1H" ? 1 : window === "7D" ? 168 : 24;
  return new Date(now.getTime() - hours * 3_600_000);
}

export type DecisionInput = {
  cycleId: string;
  agent: string;
  pairAddress: string;
  decision: string;
  reasonCodes: string[];
  createdAt: Date;
};

export type IntentInput = {
  id: string;
  cycleId: string;
  pairAddress: string;
  strategyInstanceId: string | null;
  status: string;
  statusReason: string | null;
  reasonCodes: string[];
  createdAt: Date;
};

export type ActiveCondition = {
  family: NoTradeFamilyId;
  detail: string;
  count: number;
};

export type NoTradeSample = {
  source: "intent" | "decision";
  id: string;
  cycleId: string;
  pairAddress: string | null;
  strategyInstanceId: string | null;
  agent: string | null;
  status: string | null;
  reason: string;
  reasonText: string;
  at: string;
};

const SAMPLE_LIMIT = 10;
const ACTED_DECISIONS = new Set(["ACT", "BUY", "SELL", "SUBMIT"]);

/**
 * Attribute each (cycle, pair) evaluation to exactly one decisive family, and each non-progressing
 * TradeIntent to one family. Counts are evaluations, not raw reason-code occurrences.
 */
export function summarizeNoTrades(input: {
  decisions: DecisionInput[];
  intents: IntentInput[];
  active: ActiveCondition[];
}) {
  type Bucket = { windowCount: number; intentCount: number; evaluationCount: number; samples: NoTradeSample[] };
  const buckets = new Map<NoTradeFamilyId, Bucket>();
  const bucket = (family: NoTradeFamilyId) => {
    let row = buckets.get(family);
    if (!row) {
      row = { windowCount: 0, intentCount: 0, evaluationCount: 0, samples: [] };
      buckets.set(family, row);
    }
    return row;
  };

  const byEvaluation = new Map<string, DecisionInput[]>();
  for (const decision of input.decisions) {
    const key = `${decision.cycleId}\u0000${decision.pairAddress}`;
    const list = byEvaluation.get(key) ?? [];
    list.push(decision);
    byEvaluation.set(key, list);
  }
  let evaluations = 0;
  let actedEvaluations = 0;
  for (const rows of byEvaluation.values()) {
    evaluations += 1;
    if (rows.some((row) => ACTED_DECISIONS.has(row.decision))) {
      actedEvaluations += 1;
      continue;
    }
    let decisive: { family: NoTradeFamilyId; row: DecisionInput; code: string } | null = null;
    for (const row of rows) {
      if (row.decision === "PASS") continue;
      for (const code of row.reasonCodes) {
        const family = CODE_TO_FAMILY.get(code);
        if (!family) continue;
        if (!decisive || precedence(family) < precedence(decisive.family)) decisive = { family, row, code };
      }
    }
    if (!decisive) continue;
    const target = bucket(decisive.family);
    target.windowCount += 1;
    target.evaluationCount += 1;
    if (target.samples.length < SAMPLE_LIMIT) {
      target.samples.push({
        source: "decision",
        id: `${decisive.row.cycleId}:${decisive.row.agent}:${decisive.row.pairAddress}`,
        cycleId: decisive.row.cycleId,
        pairAddress: decisive.row.pairAddress || null,
        strategyInstanceId: null,
        agent: decisive.row.agent,
        status: decisive.row.decision,
        reason: decisive.code,
        reasonText: reasonText(decisive.code),
        at: decisive.row.createdAt.toISOString(),
      });
    }
  }

  for (const intent of input.intents) {
    const family = classifyNoTradeReason(intent.statusReason, intent.reasonCodes);
    if (!family) continue;
    const target = bucket(family);
    target.windowCount += 1;
    target.intentCount += 1;
    if (target.samples.length < SAMPLE_LIMIT) {
      const reason = intent.statusReason ?? intent.reasonCodes.find((code) => CODE_TO_FAMILY.get(code) === family) ?? family;
      target.samples.push({
        source: "intent",
        id: intent.id,
        cycleId: intent.cycleId,
        pairAddress: intent.pairAddress,
        strategyInstanceId: intent.strategyInstanceId,
        agent: null,
        status: intent.status,
        reason,
        reasonText: reasonText(tokens(reason)[0] ?? reason),
        at: intent.createdAt.toISOString(),
      });
    }
  }

  const activeByFamily = new Map<NoTradeFamilyId, ActiveCondition>();
  for (const condition of input.active) {
    const existing = activeByFamily.get(condition.family);
    activeByFamily.set(condition.family, existing ? { ...existing, count: existing.count + condition.count, detail: `${existing.detail} ${condition.detail}` } : condition);
  }

  const families = NO_TRADE_FAMILY_ORDER.filter((id) => buckets.has(id) || activeByFamily.has(id)).map((id) => {
    const row = buckets.get(id);
    const active = activeByFamily.get(id) ?? null;
    return {
      id,
      label: NO_TRADE_FAMILIES[id].label,
      action: NO_TRADE_FAMILIES[id].action,
      activeNow: active !== null,
      activeDetail: active?.detail ?? null,
      activeCount: active?.count ?? 0,
      count: row?.windowCount ?? 0,
      intentCount: row?.intentCount ?? 0,
      evaluationCount: row?.evaluationCount ?? 0,
      samples: row?.samples ?? [],
    };
  });
  families.sort((a, b) => {
    if (a.activeNow !== b.activeNow) return a.activeNow ? -1 : 1;
    if (a.activeNow && b.activeNow) return precedence(a.id) - precedence(b.id);
    return b.count - a.count || precedence(a.id) - precedence(b.id);
  });

  const primary = families[0] ?? null;
  return {
    evaluations,
    actedEvaluations,
    intentsConsidered: input.intents.length,
    families,
    primary: primary
      ? {
          id: primary.id,
          label: primary.label,
          action: primary.action,
          basis: primary.activeNow ? ("ACTIVE_CONDITION" as const) : ("MOST_FREQUENT_IN_WINDOW" as const),
        }
      : null,
  };
}
