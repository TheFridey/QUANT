import { reportDataQuality, type BacktestObservation } from "@odin/backtest";

export type IntegrityIssue = {
  code:
    | "MISSING_PRICE"
    | "MISSING_LIQUIDITY"
    | "INVALID_TIMESTAMP"
    | "DUPLICATE"
    | "STALE"
    | "PROVIDER_OUTAGE"
    | "MARKET_ID"
    | "QUOTE_CURRENCY"
    | "INCOMPLETE_SESSION"
    | "SURVIVORSHIP"
    | "LOOK_AHEAD"
    | "LEAKAGE";
  severity: "block" | "warn";
  detail: string;
};

export function assessObservationIntegrity(
  observations: BacktestObservation[],
  options?: { asOfMs?: number; gapThresholdMs?: number },
): { issues: IntegrityIssue[]; blocking: boolean; usable: BacktestObservation[] } {
  const issues: IntegrityIssue[] = [];
  const usable: BacktestObservation[] = [];
  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  const quotes = new Set<string>();

  for (const row of observations) {
    const stamp = Date.parse(row.receivedAt);
    if (!row.pairAddress || !row.baseSymbol) {
      issues.push({ code: "MARKET_ID", severity: "block", detail: `Observation ${row.id} is missing a market identifier` });
      continue;
    }
    if (!Number.isFinite(stamp)) {
      issues.push({ code: "INVALID_TIMESTAMP", severity: "block", detail: `Observation ${row.id} has an invalid timestamp` });
      continue;
    }
    if (options?.asOfMs !== undefined && stamp > options.asOfMs) {
      issues.push({ code: "LOOK_AHEAD", severity: "block", detail: `Observation ${row.id} is timestamped after the decision clock` });
      continue;
    }
    if (seenIds.has(row.id) || seenKeys.has(`${row.pairAddress}|${row.receivedAt}`)) {
      issues.push({ code: "DUPLICATE", severity: "warn", detail: `Duplicate observation ${row.id} at ${row.receivedAt}` });
      continue;
    }
    seenIds.add(row.id);
    seenKeys.add(`${row.pairAddress}|${row.receivedAt}`);
    if (row.priceUsd === null) {
      issues.push({ code: "MISSING_PRICE", severity: "warn", detail: `Missing price on ${row.pairAddress} at ${row.receivedAt}` });
    }
    if (row.liquidityUsd === null) {
      issues.push({ code: "MISSING_LIQUIDITY", severity: "warn", detail: `Missing liquidity on ${row.pairAddress} at ${row.receivedAt}` });
    }
    if (row.freshness === "STALE") {
      issues.push({ code: "STALE", severity: "warn", detail: `Stale observation ${row.id}` });
    }
    if (row.provenance.toUpperCase().includes("OUTAGE") || row.freshness === "DEMO") {
      issues.push({
        code: "PROVIDER_OUTAGE",
        severity: "warn",
        detail: `${row.id} provenance ${row.provenance} freshness ${row.freshness}`,
      });
    }
    if (row.quoteSymbol) quotes.add(row.quoteSymbol);
    usable.push(row);
  }

  if (quotes.size > 1) {
    issues.push({
      code: "QUOTE_CURRENCY",
      severity: "warn",
      detail: `Mixed quote currencies: ${[...quotes].join(", ")}`,
    });
  }

  const quality = reportDataQuality(usable, { gapThresholdMs: options?.gapThresholdMs });
  if (quality.gaps.length > 0) {
    issues.push({
      code: "INCOMPLETE_SESSION",
      severity: "warn",
      detail: `${quality.gaps.length} gaps inside the observation window`,
    });
  }
  if (quality.disappearedPairs.length > 0 || quality.inactivePairs.length > 0) {
    issues.push({
      code: "SURVIVORSHIP",
      severity: "warn",
      detail: `${quality.disappearedPairs.length} disappeared and ${quality.inactivePairs.length} inactive instruments remain in the report`,
    });
  }

  return { issues, blocking: issues.some((issue) => issue.severity === "block"), usable };
}

/** Entry reconstruction must not receive post-exit fields. */
export function assertEntryContextHasNoPostTradeLeak(context: Record<string, unknown>): IntegrityIssue[] {
  const leaked = ["exitPrice", "realizedPnlUsd", "afterActionReview", "postExit"].filter((key) => key in context);
  return leaked.map((key) => ({
    code: "LEAKAGE" as const,
    severity: "block" as const,
    detail: `Entry context contains post-trade field ${key}`,
  }));
}
