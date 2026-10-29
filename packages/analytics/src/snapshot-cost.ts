/**
 * D29 — snapshot / query cost helpers.
 * Profile before optimising. Bounds and coalesce guidance for terminal snapshots.
 */

export type SnapshotQueryPhase = {
  name: string;
  elapsedMs: number;
  rows?: number;
  bounded: boolean;
};

export type SnapshotCostReport = {
  totalMs: number;
  phases: SnapshotQueryPhase[];
  /** True when every listed phase used an explicit take/limit or aggregate. */
  allBounded: boolean;
  recommendations: string[];
};

/** Default caps used by TerminalService.snapshot — keep in sync with call sites. */
export const SNAPSHOT_BOUNDS = {
  closedTrades: 200,
  equitySeries: 500,
  funnelEvents: 200,
  cycleDecisions: 120,
  recentAgentDecisions: 60,
  recentOrders: 40,
  alerts: 40,
  observability: 40,
  strategyInstances: 50,
  protectionPage: 200,
} as const;

export function summarizeSnapshotCost(phases: SnapshotQueryPhase[]): SnapshotCostReport {
  const totalMs = phases.reduce((sum, p) => sum + p.elapsedMs, 0);
  const allBounded = phases.length === 0 ? true : phases.every((p) => p.bounded);
  const recommendations: string[] = [];
  const slow = phases.filter((p) => p.elapsedMs >= 50).sort((a, b) => b.elapsedMs - a.elapsedMs);
  for (const phase of slow.slice(0, 5)) {
    recommendations.push(`phase:${phase.name} took ${phase.elapsedMs}ms${phase.rows != null ? ` rows=${phase.rows}` : ""}`);
  }
  if (!allBounded) {
    recommendations.push("unbounded_phase_detected: add take/limit or aggregate");
  }
  if (totalMs >= 200) {
    recommendations.push("snapshot_total_ge_200ms: coalesce socket refresh; prefer incremental endpoints");
  }
  return { totalMs, phases, allBounded, recommendations };
}

/** Coalesce overlapping snapshot invalidations by revision — drop stale in-flight. */
export function shouldApplySnapshotRevision(input: {
  incomingRevision: number;
  appliedRevision: number;
}): boolean {
  return input.incomingRevision > input.appliedRevision;
}
