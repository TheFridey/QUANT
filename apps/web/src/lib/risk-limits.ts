// Operator-editable PAPER risk limits. Values are sent to the existing audited
// PATCH /engine/config (AdminGuard; the engine must be paused); the server
// validates again and records an EngineConfigRevision. Bounds and defaults mirror
// packages/shared/src/strategy.ts, which stays authoritative.

export type RiskLimitKey =
  | "maxDailyLossPct"
  | "maxTotalDrawdownPct"
  | "maxRiskPerTradePct"
  | "maxAggregateExposurePct"
  | "maxPositionPctEquity";

export type RiskLimitField = {
  key: RiskLimitKey;
  label: string;
  help: string;
  min: string;
  max: string;
  defaultValue: string;
};

export const RISK_LIMIT_FIELDS: readonly RiskLimitField[] = [
  {
    key: "maxDailyLossPct",
    label: "Max daily loss %",
    help: "Of start-of-day equity (Europe/London). Once reached, new entries stay blocked until the next London day.",
    min: "0.1",
    max: "100",
    defaultValue: "3",
  },
  {
    key: "maxTotalDrawdownPct",
    label: "Max total drawdown %",
    help: "Below the account high-water mark. Blocks new entries and opens the circuit breaker.",
    min: "0.1",
    max: "100",
    defaultValue: "10",
  },
  {
    key: "maxRiskPerTradePct",
    label: "Max risk per trade %",
    help: "Worst-case stop-out loss of one entry, as a share of equity.",
    min: "0.01",
    max: "25",
    defaultValue: "0.5",
  },
  {
    key: "maxAggregateExposurePct",
    label: "Max aggregate exposure %",
    help: "All open positions together, as a share of equity.",
    min: "0.1",
    max: "100",
    defaultValue: "20",
  },
  {
    key: "maxPositionPctEquity",
    label: "Max position % of equity",
    help: "Largest single position, as a share of equity.",
    min: "0.1",
    max: "100",
    defaultValue: "5",
  },
];

export type RiskLimitDraft = Record<RiskLimitKey, string>;

const DECIMAL = /^-?\d+(\.\d+)?$/;

export function draftFromConfig(config: Record<string, unknown> | null | undefined): RiskLimitDraft {
  const draft = {} as RiskLimitDraft;
  for (const field of RISK_LIMIT_FIELDS) {
    const raw = config?.[field.key];
    draft[field.key] = raw === null || raw === undefined ? "" : String(raw);
  }
  return draft;
}

/** Field errors, keyed by limit; empty when the draft is valid. */
export function validateRiskDraft(draft: RiskLimitDraft): Partial<Record<RiskLimitKey, string>> {
  const errors: Partial<Record<RiskLimitKey, string>> = {};
  for (const field of RISK_LIMIT_FIELDS) {
    const value = draft[field.key].trim();
    if (!DECIMAL.test(value)) {
      errors[field.key] = "Enter a number";
      continue;
    }
    const n = Number(value);
    if (n < Number(field.min) || n > Number(field.max)) {
      errors[field.key] = `Must be between ${field.min} and ${field.max}`;
    }
  }
  return errors;
}

export type RiskLimitChange = { key: RiskLimitKey; label: string; from: string; to: string; loosens: boolean };

/** Changed limits only. A higher number is a looser limit for every field here. */
export function diffRiskDraft(before: RiskLimitDraft, after: RiskLimitDraft): RiskLimitChange[] {
  const changes: RiskLimitChange[] = [];
  for (const field of RISK_LIMIT_FIELDS) {
    const from = before[field.key].trim();
    const to = after[field.key].trim();
    if (from === to || (DECIMAL.test(from) && DECIMAL.test(to) && Number(from) === Number(to))) continue;
    changes.push({ key: field.key, label: field.label, from, to, loosens: Number(to) > Number(from) });
  }
  return changes;
}

/** The PATCH body: changed keys only, as decimal strings (the server's format). */
export function patchFromChanges(changes: RiskLimitChange[]): Partial<RiskLimitDraft> {
  const patch: Partial<RiskLimitDraft> = {};
  for (const change of changes) patch[change.key] = change.to;
  return patch;
}

export type RiskLimitAccount = {
  equityUsd: string | null;
  highWaterMarkUsd: string | null;
};

export type RiskLimitNote = { tone: "warning" | "info"; text: string };

/**
 * What the draft means for the account right now. Informational only: the risk
 * engine decides admission.
 */
export function riskDraftNotes(draft: RiskLimitDraft, account: RiskLimitAccount): RiskLimitNote[] {
  const notes: RiskLimitNote[] = [];
  const daily = Number(draft.maxDailyLossPct);
  const total = Number(draft.maxTotalDrawdownPct);
  if (Number.isFinite(daily) && Number.isFinite(total) && daily >= total) {
    notes.push({
      tone: "warning",
      text: `A ${daily}% daily limit cannot bind while total drawdown is ${total}%: the high-water mark is never below start-of-day equity, so the total-drawdown limit always trips first.`,
    });
  }
  const equity = account.equityUsd === null ? NaN : Number(account.equityUsd);
  const hwm = account.highWaterMarkUsd === null ? NaN : Number(account.highWaterMarkUsd);
  if (Number.isFinite(equity) && Number.isFinite(hwm) && hwm > 0 && Number.isFinite(total)) {
    const drawdown = ((hwm - equity) / hwm) * 100;
    const resumeAt = hwm * (1 - total / 100);
    if (drawdown >= total) {
      notes.push({
        tone: "warning",
        text: `Current drawdown is ${drawdown.toFixed(2)}%, at or above a ${total}% limit: new entries stay blocked (TOTAL_DRAWDOWN_LIMIT) until equity reaches $${resumeAt.toFixed(2)}.`,
      });
    } else {
      notes.push({
        tone: "info",
        text: `Current drawdown is ${drawdown.toFixed(2)}%; a ${total}% limit leaves room to $${resumeAt.toFixed(2)} equity before entries are blocked.`,
      });
    }
  }
  return notes;
}
