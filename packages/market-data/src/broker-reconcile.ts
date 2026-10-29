import Decimal from "decimal.js";
import {
  TERMINAL_EXTERNAL_STATUSES,
  type ExternalAccount,
  type ExternalExecution,
  type ExternalOrderState,
  type ExternalOrderStatus,
  type ExternalPage,
  type ExternalPosition,
} from "./execution-contract.js";

/**
 * Pure local-vs-broker comparison (no I/O). Incomplete broker pagination can never yield CLEAN:
 * absence of evidence is not evidence of absence.
 */

export type LocalOrderView = {
  clientOrderId: string;
  brokerOrderId: string | null;
  status: string;
  qty: string;
  filledQty: string;
  side: "BUY" | "SELL";
  symbol: string;
};

export type LocalBrokerSnapshot = {
  orders: LocalOrderView[];
  /** Signed quantities (short < 0). */
  positions: Array<{ symbol: string; qty: string }>;
  executionIds: string[];
  cashUsd?: string | null;
};

export type BrokerSnapshot = {
  orders: ExternalPage<ExternalOrderState>;
  executions: ExternalPage<ExternalExecution>;
  positions: ExternalPosition[];
  account: ExternalAccount | null;
};

export type ReconcileDifferenceKind =
  | "ORDER_MISSING_LOCAL"
  | "ORDER_MISSING_BROKER"
  | "STATUS_MISMATCH"
  | "FILLED_QTY_MISMATCH"
  | "ORDER_FIELD_MISMATCH"
  | "EXECUTION_NOT_BOOKED"
  | "EXECUTION_PRICE_MISSING"
  | "EXECUTION_UNKNOWN_TO_BROKER"
  | "POSITION_QTY_MISMATCH"
  | "POSITION_MISSING_LOCAL"
  | "POSITION_MISSING_BROKER"
  | "CASH_MISMATCH"
  | "ACCOUNT_UNAVAILABLE"
  | "ACCOUNT_NOT_PRACTICE";

export type ReconcileSeverity = "INFO" | "WARN" | "CRITICAL";

export type ReconcileRecoveryAction =
  | "NONE"
  | "ADOPT_OR_CANCEL_BROKER_ORDER"
  | "LOOKUP_BY_CLIENT_ORDER_ID"
  | "REFRESH_LOCAL_ORDER_FROM_BROKER"
  | "BOOK_MISSING_EXECUTIONS"
  | "MANUAL_REVIEW"
  | "HALT_AND_REVIEW";

export type ReconcileDifference = {
  kind: ReconcileDifferenceKind;
  severity: ReconcileSeverity;
  scope: string;
  detail: string;
  recoveryAction: ReconcileRecoveryAction;
};

export type ReconcileStatus = "CLEAN" | "DRIFT" | "INCOMPLETE";

export type ReconcileReport = {
  complete: boolean;
  coverage: {
    window: { after: string | null; until: string | null };
    orderPagesFetched: number;
    ordersComplete: boolean;
    executionPagesFetched: number;
    executionsComplete: boolean;
    accountAvailable: boolean;
    ordersCompared: number;
    executionsCompared: number;
    positionsCompared: number;
    incompleteReasons: string[];
  };
  differences: ReconcileDifference[];
  status: ReconcileStatus;
};

const LOCAL_STATUS_ALIASES: Record<string, ExternalOrderStatus> = {
  ACCEPTED: "ACCEPTED",
  ACKED: "ACCEPTED",
  PENDING: "ACCEPTED",
  SUBMITTED: "ACCEPTED",
  OPEN: "ACCEPTED",
  NEW: "ACCEPTED",
  PARTIALLY_FILLED: "PARTIALLY_FILLED",
  FILLED: "FILLED",
  CANCEL_PENDING: "CANCEL_PENDING",
  CANCEL_REQUESTED: "CANCEL_PENDING",
  CANCELED: "CANCELED",
  CANCELLED: "CANCELED",
  REJECTED: "REJECTED",
  EXPIRED: "EXPIRED",
};

export function normalizeLocalStatus(status: string): ExternalOrderStatus {
  return LOCAL_STATUS_ALIASES[status.trim().toUpperCase()] ?? "UNKNOWN";
}

export function normalizeSymbol(symbol: string): string {
  const trimmed = symbol.trim();
  const sep = trimmed.indexOf(":");
  const prefix = sep >= 0 ? trimmed.slice(0, sep).toLowerCase() : "";
  return (prefix === "etf" || prefix === "equity" ? trimmed.slice(sep + 1) : trimmed).toUpperCase();
}

function dec(value: string): Decimal | null {
  try {
    const d = new Decimal(value);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

function signedBrokerQty(p: ExternalPosition): Decimal | null {
  const q = dec(p.qty);
  if (!q) return null;
  return p.side === "short" && q.gt(0) ? q.neg() : q;
}

function flattenOrders(orders: ExternalOrderState[]): { all: ExternalOrderState[]; legIds: Set<string> } {
  const byId = new Map<string, ExternalOrderState>();
  const legIds = new Set<string>();
  for (const o of orders) {
    if (!byId.has(o.brokerOrderId)) byId.set(o.brokerOrderId, o);
    for (const leg of o.legs ?? []) {
      legIds.add(leg.brokerOrderId);
      if (!byId.has(leg.brokerOrderId)) byId.set(leg.brokerOrderId, leg);
    }
  }
  return { all: [...byId.values()], legIds };
}

export function compareBrokerState(input: {
  local: LocalBrokerSnapshot;
  broker: BrokerSnapshot;
  window: { after: string | null; until: string | null };
}): ReconcileReport {
  const { local, broker } = input;
  const differences: ReconcileDifference[] = [];
  const add = (d: ReconcileDifference) => differences.push(d);
  const incompleteReasons: string[] = [];
  if (!broker.orders.complete) incompleteReasons.push("broker order pagination incomplete");
  if (!broker.executions.complete) incompleteReasons.push("broker execution pagination incomplete");

  if (!broker.account) {
    add({
      kind: "ACCOUNT_UNAVAILABLE",
      severity: local.cashUsd != null ? "WARN" : "INFO",
      scope: "account",
      detail: "broker account snapshot unavailable",
      recoveryAction: "NONE",
    });
    if (local.cashUsd != null) incompleteReasons.push("cash comparison requested but account unavailable");
  } else {
    if (!broker.account.isPractice) {
      add({
        kind: "ACCOUNT_NOT_PRACTICE",
        severity: "CRITICAL",
        scope: "account",
        detail: "broker account is not a verified practice account",
        recoveryAction: "HALT_AND_REVIEW",
      });
    }
    if (local.cashUsd != null) {
      const localCash = dec(local.cashUsd);
      const brokerCash = dec(broker.account.cash);
      if (!localCash || !brokerCash || !localCash.minus(brokerCash).abs().lte("0.01")) {
        add({
          kind: "CASH_MISMATCH",
          severity: "WARN",
          scope: "account:cash",
          detail: `local cash ${local.cashUsd} vs broker cash ${broker.account.cash}`,
          recoveryAction: "MANUAL_REVIEW",
        });
      }
    }
  }

  const { all: brokerOrders, legIds } = flattenOrders(broker.orders.items);
  const brokerByClient = new Map(brokerOrders.filter((o) => o.clientOrderId).map((o) => [o.clientOrderId, o]));
  const brokerById = new Map(brokerOrders.map((o) => [o.brokerOrderId, o]));
  const matchedBrokerIds = new Set<string>();

  for (const lo of local.orders) {
    const bo = brokerByClient.get(lo.clientOrderId) ?? (lo.brokerOrderId ? brokerById.get(lo.brokerOrderId) : undefined);
    const scope = `order:${lo.clientOrderId}`;
    if (!bo) {
      if (!broker.orders.complete) continue;
      const localStatus = normalizeLocalStatus(lo.status);
      const filled = dec(lo.filledQty);
      const economic = (filled?.gt(0) ?? true) || !TERMINAL_EXTERNAL_STATUSES.has(localStatus);
      add({
        kind: "ORDER_MISSING_BROKER",
        severity: economic ? "CRITICAL" : "WARN",
        scope,
        detail: `local ${lo.status} order not present in broker window`,
        recoveryAction: "LOOKUP_BY_CLIENT_ORDER_ID",
      });
      continue;
    }
    matchedBrokerIds.add(bo.brokerOrderId);
    if (normalizeSymbol(lo.symbol) !== normalizeSymbol(bo.symbol) || lo.side !== bo.side) {
      add({
        kind: "ORDER_FIELD_MISMATCH",
        severity: "CRITICAL",
        scope,
        detail: `local ${lo.side} ${lo.symbol} vs broker ${bo.side} ${bo.symbol}`,
        recoveryAction: "HALT_AND_REVIEW",
      });
    }
    const localQty = dec(lo.qty);
    const brokerQty = dec(bo.qty);
    if (!localQty || !brokerQty || !localQty.eq(brokerQty)) {
      add({
        kind: "ORDER_FIELD_MISMATCH",
        severity: "CRITICAL",
        scope,
        detail: `local qty ${lo.qty} vs broker qty ${bo.qty}`,
        recoveryAction: "HALT_AND_REVIEW",
      });
    }
    const localStatus = normalizeLocalStatus(lo.status);
    if (localStatus !== bo.status) {
      const fillRelevant = localStatus === "FILLED" || bo.status === "FILLED" || bo.status === "PARTIALLY_FILLED";
      add({
        kind: "STATUS_MISMATCH",
        severity: fillRelevant || bo.status === "UNKNOWN" ? "CRITICAL" : "WARN",
        scope,
        detail: `local ${lo.status} vs broker ${bo.status} (${bo.rawStatus})`,
        recoveryAction: "REFRESH_LOCAL_ORDER_FROM_BROKER",
      });
    }
    const localFilled = dec(lo.filledQty);
    const brokerFilled = dec(bo.filledQty);
    if (!localFilled || !brokerFilled || !localFilled.eq(brokerFilled)) {
      add({
        kind: "FILLED_QTY_MISMATCH",
        severity: "CRITICAL",
        scope,
        detail: `local filled ${lo.filledQty} vs broker filled ${bo.filledQty}`,
        recoveryAction: "BOOK_MISSING_EXECUTIONS",
      });
    }
  }

  for (const bo of brokerOrders) {
    // venue-generated protection legs are tracked through their parent; their fills surface as executions
    if (matchedBrokerIds.has(bo.brokerOrderId) || legIds.has(bo.brokerOrderId)) continue;
    const filled = dec(bo.filledQty);
    add({
      kind: "ORDER_MISSING_LOCAL",
      severity: filled && filled.gt(0) ? "CRITICAL" : "WARN",
      scope: `order:${bo.clientOrderId || bo.brokerOrderId}`,
      detail: `broker ${bo.status} ${bo.side} ${bo.qty} ${bo.symbol} (filled ${bo.filledQty}) has no local record`,
      recoveryAction: "ADOPT_OR_CANCEL_BROKER_ORDER",
    });
  }

  const localExecIds = new Set(local.executionIds);
  const brokerExecIds = new Set<string>();
  for (const ex of broker.executions.items) {
    brokerExecIds.add(ex.executionId);
    const scope = `execution:${ex.executionId}`;
    if (ex.price === null) {
      add({
        kind: "EXECUTION_PRICE_MISSING",
        severity: "CRITICAL",
        scope,
        detail: `broker execution for order ${ex.brokerOrderId} has no price; must not be booked`,
        recoveryAction: "MANUAL_REVIEW",
      });
    }
    if (!localExecIds.has(ex.executionId)) {
      add({
        kind: "EXECUTION_NOT_BOOKED",
        severity: "CRITICAL",
        scope,
        detail: `${ex.side} ${ex.qty} ${ex.symbol} @ ${ex.price ?? "unknown"} (order ${ex.brokerOrderId}) not booked locally`,
        recoveryAction: ex.price === null ? "MANUAL_REVIEW" : "BOOK_MISSING_EXECUTIONS",
      });
    }
  }
  if (broker.executions.complete) {
    for (const id of localExecIds) {
      if (brokerExecIds.has(id)) continue;
      add({
        kind: "EXECUTION_UNKNOWN_TO_BROKER",
        severity: "WARN",
        scope: `execution:${id}`,
        detail: "local execution id not reported by broker in this window",
        recoveryAction: "MANUAL_REVIEW",
      });
    }
  }

  const brokerPositions = new Map<string, Decimal | null>();
  for (const p of broker.positions) brokerPositions.set(normalizeSymbol(p.symbol), signedBrokerQty(p));
  const localPositions = new Map<string, Decimal | null>();
  for (const p of local.positions) {
    const key = normalizeSymbol(p.symbol);
    const q = dec(p.qty);
    const prev = localPositions.get(key);
    localPositions.set(key, q && prev !== null ? q.plus(prev ?? 0) : null);
  }
  const symbols = new Set([...brokerPositions.keys(), ...localPositions.keys()]);
  for (const symbol of symbols) {
    const bq = brokerPositions.get(symbol);
    const lq = localPositions.get(symbol);
    const scope = `position:${symbol}`;
    const brokerHas = bq === undefined ? false : bq === null || !bq.isZero();
    const localHas = lq === undefined ? false : lq === null || !lq.isZero();
    if (brokerHas && !localHas) {
      add({ kind: "POSITION_MISSING_LOCAL", severity: "CRITICAL", scope, detail: `broker holds ${bq?.toString() ?? "unparseable"}; local flat`, recoveryAction: "HALT_AND_REVIEW" });
    } else if (!brokerHas && localHas) {
      add({ kind: "POSITION_MISSING_BROKER", severity: "CRITICAL", scope, detail: `local holds ${lq?.toString() ?? "unparseable"}; broker flat`, recoveryAction: "HALT_AND_REVIEW" });
    } else if (brokerHas && localHas && (!bq || !lq || !bq.eq(lq))) {
      add({
        kind: "POSITION_QTY_MISMATCH",
        severity: "CRITICAL",
        scope,
        detail: `local ${lq?.toString() ?? "unparseable"} vs broker ${bq?.toString() ?? "unparseable"}`,
        recoveryAction: "HALT_AND_REVIEW",
      });
    }
  }

  const complete = incompleteReasons.length === 0;
  const drift = differences.some((d) => d.severity !== "INFO");
  return {
    complete,
    coverage: {
      window: input.window,
      orderPagesFetched: broker.orders.pagesFetched,
      ordersComplete: broker.orders.complete,
      executionPagesFetched: broker.executions.pagesFetched,
      executionsComplete: broker.executions.complete,
      accountAvailable: broker.account !== null,
      ordersCompared: brokerOrders.length,
      executionsCompared: broker.executions.items.length,
      positionsCompared: symbols.size,
      incompleteReasons,
    },
    differences,
    status: !complete ? "INCOMPLETE" : drift ? "DRIFT" : "CLEAN",
  };
}
