import { d, usd } from "@odin/shared";

export type CorrelationGroup = {
  id: string;
  /** Deterministic membership — instrument or pair ids. */
  members: string[];
  /** Max aggregate notional for the group as fraction of equity (0–100). */
  maxGroupExposurePct: string;
};

export type GroupExposure = {
  groupId: string;
  exposureUsd: string;
  capUsd: string;
  ok: boolean;
};

/**
 * Deterministic correlation budgeting: group open notionals and reject when
 * a proposed add would breach the group cap. No ML / random clustering.
 */
export function evaluateCorrelationBudget(input: {
  equityUsd: string;
  groups: CorrelationGroup[];
  openNotionals: Record<string, string>;
  proposedInstrumentId: string;
  proposedNotionalUsd: string;
}): { ok: boolean; breaches: GroupExposure[]; exposures: GroupExposure[] } {
  const exposures: GroupExposure[] = [];
  const breaches: GroupExposure[] = [];
  for (const group of input.groups) {
    if (!group.members.includes(input.proposedInstrumentId)) {
      const current = sumMembers(group.members, input.openNotionals);
      const cap = d(input.equityUsd).mul(d(group.maxGroupExposurePct)).div(100);
      exposures.push({ groupId: group.id, exposureUsd: usd(current), capUsd: usd(cap), ok: current.lte(cap) });
      continue;
    }
    const current = sumMembers(group.members, input.openNotionals);
    const next = current.plus(d(input.proposedNotionalUsd));
    const cap = d(input.equityUsd).mul(d(group.maxGroupExposurePct)).div(100);
    const row = { groupId: group.id, exposureUsd: usd(next), capUsd: usd(cap), ok: next.lte(cap) };
    exposures.push(row);
    if (!row.ok) breaches.push(row);
  }
  return { ok: breaches.length === 0, breaches, exposures };
}

function sumMembers(members: string[], open: Record<string, string>) {
  return members.reduce((total, id) => total.plus(d(open[id] ?? "0")), d("0"));
}

/** Default MVP groups: FX majors together; equity ETF proxies together. */
export const DEFAULT_CORRELATION_GROUPS: CorrelationGroup[] = [
  {
    id: "fx-majors",
    members: ["fx:EURUSD", "fx:GBPUSD", "fx:USDJPY"],
    maxGroupExposurePct: "15",
  },
  {
    id: "us-equity-etf",
    members: ["etf:SPY", "etf:QQQ"],
    maxGroupExposurePct: "15",
  },
];
