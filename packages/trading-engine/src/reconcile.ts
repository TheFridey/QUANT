import { d, usd } from "@odin/shared";

export type BrokerOrderTruth = {
  clientOrderId: string;
  status: "ACKED" | "FILLED" | "CANCELLED" | "REJECTED" | "UNKNOWN";
  filledQty: string;
  venue: string;
};

export type LedgerOrderTruth = {
  clientOrderId: string;
  status: string;
  filledQty: string;
  venue: string;
};

export type ReconcileIssue =
  | { kind: "MISSING_LEDGER"; clientOrderId: string }
  | { kind: "MISSING_BROKER"; clientOrderId: string }
  | { kind: "QTY_MISMATCH"; clientOrderId: string; brokerQty: string; ledgerQty: string }
  | { kind: "STATUS_MISMATCH"; clientOrderId: string; brokerStatus: string; ledgerStatus: string }
  | { kind: "UNKNOWN_EXPOSURE"; clientOrderId: string };

export type ReconcileReport = {
  ok: boolean;
  issues: ReconcileIssue[];
  /** When unknown exposure exists, entries must suspend account-wide. */
  suspendEntries: boolean;
};

/**
 * Startup / continuous reconciliation between broker (or paper venue) truth and durable ledger.
 * Never invents fills to resolve gaps — surfaces issues for operator/engine halt.
 */
export function reconcileOrders(input: {
  broker: BrokerOrderTruth[];
  ledger: LedgerOrderTruth[];
}): ReconcileReport {
  const issues: ReconcileIssue[] = [];
  const ledgerById = new Map(input.ledger.map((row) => [row.clientOrderId, row]));
  const brokerById = new Map(input.broker.map((row) => [row.clientOrderId, row]));

  for (const broker of input.broker) {
    const ledger = ledgerById.get(broker.clientOrderId);
    if (!ledger) {
      issues.push({ kind: "MISSING_LEDGER", clientOrderId: broker.clientOrderId });
      if (broker.status === "FILLED" || broker.status === "ACKED" || broker.status === "UNKNOWN") {
        issues.push({ kind: "UNKNOWN_EXPOSURE", clientOrderId: broker.clientOrderId });
      }
      continue;
    }
    if (broker.status === "UNKNOWN") {
      issues.push({ kind: "UNKNOWN_EXPOSURE", clientOrderId: broker.clientOrderId });
    }
    if (!d(broker.filledQty).eq(ledger.filledQty)) {
      issues.push({
        kind: "QTY_MISMATCH",
        clientOrderId: broker.clientOrderId,
        brokerQty: broker.filledQty,
        ledgerQty: ledger.filledQty,
      });
    }
    const normalizedLedger = normalizeStatus(ledger.status);
    if (broker.status !== "UNKNOWN" && normalizedLedger !== broker.status && !(broker.status === "ACKED" && normalizedLedger === "PENDING")) {
      issues.push({
        kind: "STATUS_MISMATCH",
        clientOrderId: broker.clientOrderId,
        brokerStatus: broker.status,
        ledgerStatus: ledger.status,
      });
    }
  }

  for (const ledger of input.ledger) {
    if (!brokerById.has(ledger.clientOrderId) && (ledger.status === "FILLED" || ledger.status === "PENDING")) {
      // Paper venue is self-truthful; missing broker row for PAPER is OK.
      if (ledger.venue !== "PAPER") {
        issues.push({ kind: "MISSING_BROKER", clientOrderId: ledger.clientOrderId });
      }
    }
  }

  const suspendEntries = issues.some((issue) => issue.kind === "UNKNOWN_EXPOSURE" || issue.kind === "QTY_MISMATCH");
  return { ok: issues.length === 0, issues, suspendEntries };
}

function normalizeStatus(status: string): string {
  if (status === "PENDING") return "ACKED";
  return status;
}

/** Detect duplicate clientOrderId exposure on retry — ledger must be idempotent. */
export function detectDuplicateExposure(ledgerRows: LedgerOrderTruth[]): string[] {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const row of ledgerRows) {
    if (seen.has(row.clientOrderId)) dupes.push(row.clientOrderId);
    seen.add(row.clientOrderId);
  }
  return dupes;
}

export function cashMatchesLedger(input: {
  accountCashUsd: string;
  cashAffectingLines: string[];
}): { ok: boolean; sumUsd: string } {
  const sum = input.cashAffectingLines.reduce((total, line) => total.plus(d(line)), d("0"));
  return { ok: d(input.accountCashUsd).eq(sum), sumUsd: usd(sum) };
}
