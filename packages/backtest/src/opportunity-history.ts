import { createHash } from "node:crypto";

/**
 * GENESIS Phase 3 Opportunity History dataset. Pure: turns stored OpportunityFunnelEvent, AgentDecision and
 * TradeIntent rows (one bounded time window at a time) into one point-in-time row per (cycle, pair).
 *
 * Point-in-time rule: every field carries the time it was written (`knownAt`). The row's `decisionAt` is the
 * latest write that belongs to the decision itself; writes more than `maxCycleSpanMs` after the cycle's first
 * write (late retries, later status changes on an upserted TradeIntent) are excluded rather than back-filled,
 * and any timestamp embedded in a stored feature that lies after that record's own write time is removed. So
 * nothing in a row outside the `hypothetical` block was known later than `decisionAt`.
 *
 * `outcome`, `stages` and `intents[].status` describe what happened to the opportunity; they are labels,
 * not features, and must never be fed to a model as inputs.
 *
 * Counterfactual forward outcomes come from warehouse bars that closed after the decision. They are research
 * labels only, always tagged HYPOTHETICAL, and never mixed into the decision-time fields.
 */

export const OPPORTUNITY_HISTORY_SCHEMA = "genesis.opportunity-history.v1";
export const HYPOTHETICAL = "HYPOTHETICAL" as const;

type TimeLike = Date | string | number;

export type FunnelEventRow = {
  id: string;
  accountId: string;
  cycleId: string;
  pairAddress: string;
  instrumentId: string | null;
  stage: string;
  reasonCodes: string[];
  detail: unknown;
  createdAt: TimeLike;
};

export type AgentDecisionRow = {
  id: string;
  cycleId: string;
  agent: string;
  modelVersion: string;
  pairAddress: string;
  decision: string;
  confidence: string;
  reasonCodes: string[];
  input: unknown;
  output: unknown;
  inputSource: string | null;
  createdAt: TimeLike;
  /** ASCEND-09: upserts rewrite content but keep createdAt, so the content is as of updatedAt. */
  updatedAt: TimeLike;
};

export type TradeIntentRow = {
  id: string;
  cycleId: string;
  accountId: string;
  source: string;
  strategyInstanceId: string | null;
  strategyVersion: string | null;
  configHash: string | null;
  instrumentId: string;
  pairAddress: string;
  action: string;
  side: string;
  requestedQty: string | null;
  sizedQty: string | null;
  sizedNotionalUsd: string | null;
  observationId: string | null;
  observationAt: TimeLike | null;
  reasonCodes: string[];
  status: string;
  statusReason: string | null;
  createdAt: TimeLike;
  updatedAt: TimeLike;
};

export type CycleContext = { cycleId: string; startedAt: TimeLike; accountId: string | null; tradingEnvironment: string | null; dataMode: string | null };

export type CounterfactualSeries = {
  datasetId: string;
  interval: string;
  intervalMs: number;
  /** Closed bars only, any order. Must cover every bar that closed by the latest target needed. */
  bars: Array<{ openTime: number; availableAt: number; close: string }>;
  /** availableAt of the dataset's last stored bar (HistoricalDataset.lastOpenTime + interval), if known. */
  dataEndAvailableAt?: number | null;
};

export type OpportunityOutcome = "ELIGIBLE" | "REJECTED" | "NON_TRADE";

export type ExcludedField = { path: string; reason: "LATE_WRITE" | "FUTURE_TIMESTAMP" | "MUTABLE_AFTER_DECISION"; knownAt?: string };

export type HypotheticalOutcome = {
  label: typeof HYPOTHETICAL;
  basis: string;
  datasetId: string;
  interval: string;
  referenceClose: string | null;
  referenceAvailableAt: string | null;
  reason: string | null;
  horizons: Array<{ horizonMs: number; exitClose: string | null; exitAvailableAt: string | null; forwardReturn: number | null; reason: string | null }>;
};

export type OpportunityRow = {
  schema: typeof OPPORTUNITY_HISTORY_SCHEMA;
  rowId: string;
  cycleId: string;
  pairAddress: string;
  instrumentId: string | null;
  accountId: string | null;
  tradingEnvironment: string | null;
  dataMode: string | null;
  cycleStartedAt: string | null;
  decisionAt: string;
  outcome: OpportunityOutcome;
  stages: string[];
  reasonCodes: string[];
  agents: Record<string, { decision: string; confidence: string; modelVersion: string; reasonCodes: string[]; inputSource: string | null; knownAt: string; features: { input: unknown; output: unknown } }>;
  funnel: Array<{ stage: string; reasonCodes: string[]; detail: unknown; knownAt: string }>;
  intents: Array<{
    id: string;
    action: string;
    side: string;
    source: string;
    strategyInstanceId: string | null;
    strategyVersion: string | null;
    configHash: string | null;
    requestedQty: string | null;
    observationId: string | null;
    observationAt: string | null;
    reasonCodes: string[];
    knownAt: string;
    /** Present only when the intent's mutable fields were last written within the decision window. */
    status: string | null;
    statusReason: string | null;
    sizedQty: string | null;
    sizedNotionalUsd: string | null;
  }>;
  excluded: ExcludedField[];
  hypothetical?: HypotheticalOutcome;
};

export type BuildOpportunityOptions = {
  /** Writes later than the cycle's first write by more than this are excluded. Default 10 minutes. */
  maxCycleSpanMs?: number;
  counterfactual?: { series: Map<string, CounterfactualSeries>; horizonsMs: number[] };
};

const toMs = (value: TimeLike): number => (value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value));
const iso = (ms: number) => new Date(ms).toISOString();
const ISO_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
/**
 * A key names a timestamp only at a word boundary: `at` / `time` / `timestamp` alone, a snake_case suffix
 * (`created_at`), or a camelCase suffix (`createdAt`, `exitTime`). So `format`, `stat` and `lat` do not.
 */
export function isTimestampKey(key: string): boolean {
  return /^(at|time|timestamp)$/i.test(key) || /_(at|time|timestamp)$/i.test(key) || /[a-z0-9](At|Time|Timestamp)$/.test(key);
}

/**
 * Remove any timestamp in a stored JSON feature that is later than `cutoff`. Strings that look like ISO
 * instants are checked, as are numbers under a *At / *Time / *Timestamp key (epoch seconds or ms).
 */
export function stripFutureTimestamps(value: unknown, cutoff: number, path: string, excluded: ExcludedField[]): unknown {
  const kept = strip(value, cutoff, path, excluded);
  return kept === REMOVED ? null : kept;
}

const REMOVED = Symbol("removed");

function strip(value: unknown, cutoff: number, path: string, excluded: ExcludedField[]): unknown {
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    value.forEach((item, i) => {
      const kept = strip(item, cutoff, `${path}[${i}]`, excluded);
      if (kept !== REMOVED) out.push(kept);
    });
    return out;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (typeof child === "number" && isTimestampKey(key)) {
        const ms = child >= 1e12 && child < 1e14 ? child : child >= 1e9 && child < 1e11 ? child * 1000 : null;
        if (ms !== null && ms > cutoff) {
          excluded.push({ path: `${path}.${key}`, reason: "FUTURE_TIMESTAMP", knownAt: iso(ms) });
          continue;
        }
      }
      const kept = strip(child, cutoff, `${path}.${key}`, excluded);
      if (kept !== REMOVED) out[key] = kept;
    }
    return out;
  }
  if (typeof value === "string" && ISO_PREFIX.test(value)) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && ms > cutoff) {
      excluded.push({ path, reason: "FUTURE_TIMESTAMP", knownAt: iso(ms) });
      return REMOVED;
    }
  }
  return value;
}

const ELIGIBLE_STAGES = new Set(["RISK_PASSED", "RESERVED", "ORDERED", "FILLED"]);
const REJECT_STAGES = new Set(["FILTERED", "REJECTED", "DROPPED"]);

function lastAtOrBefore<T extends { availableAt: number }>(bars: T[], t: number): T | null {
  let lo = 0;
  let hi = bars.length - 1;
  let found: T | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.availableAt <= t) {
      found = bars[mid]!;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** Forward outcome from bars that closed after the decision. Labelled HYPOTHETICAL; never a decision input. */
export function counterfactualOutcome(series: CounterfactualSeries, decisionAt: number, horizonsMs: number[]): HypotheticalOutcome {
  const bars = [...series.bars].sort((a, b) => a.availableAt - b.availableAt);
  const reference = lastAtOrBefore(bars, decisionAt);
  const base: HypotheticalOutcome = {
    label: HYPOTHETICAL,
    basis: "close of the last bar closed at decisionAt vs close of the last bar closed by decisionAt + horizon; no costs, no fill model",
    datasetId: series.datasetId,
    interval: series.interval,
    referenceClose: null,
    referenceAvailableAt: null,
    reason: null,
    horizons: [],
  };
  if (!reference) return { ...base, reason: "NO_REFERENCE_BAR", horizons: horizonsMs.map((h) => ({ horizonMs: h, exitClose: null, exitAvailableAt: null, forwardReturn: null, reason: "NO_REFERENCE_BAR" })) };
  if (decisionAt - reference.availableAt > 2 * series.intervalMs) {
    return { ...base, reason: "REFERENCE_STALE", referenceAvailableAt: iso(reference.availableAt), horizons: horizonsMs.map((h) => ({ horizonMs: h, exitClose: null, exitAvailableAt: null, forwardReturn: null, reason: "REFERENCE_STALE" })) };
  }
  // The dataset's own end (when known) decides BEYOND_DATA, not the last bar a bounded read happened to load:
  // a sparse pool can have no bar between the exit bar and the load bound and still have data after it.
  const lastAvailable = Math.max(bars.at(-1)!.availableAt, series.dataEndAvailableAt ?? Number.NEGATIVE_INFINITY);
  const ref = Number(reference.close);
  return {
    ...base,
    referenceClose: reference.close,
    referenceAvailableAt: iso(reference.availableAt),
    horizons: horizonsMs.map((h) => {
      const target = decisionAt + h;
      if (target > lastAvailable) return { horizonMs: h, exitClose: null, exitAvailableAt: null, forwardReturn: null, reason: "BEYOND_DATA" };
      const exit = lastAtOrBefore(bars, target);
      if (!exit || exit.availableAt <= decisionAt) return { horizonMs: h, exitClose: null, exitAvailableAt: null, forwardReturn: null, reason: "NO_FORWARD_BAR" };
      const ret = Number(exit.close) / ref - 1;
      return { horizonMs: h, exitClose: exit.close, exitAvailableAt: iso(exit.availableAt), forwardReturn: Number.isFinite(ret) ? Number(ret.toFixed(8)) : null, reason: null };
    }),
  };
}

/** Build point-in-time rows for one window. Cycle-level decisions (empty pairAddress) are not opportunities. */
export function buildOpportunityRows(input: {
  cycles: CycleContext[];
  funnel: FunnelEventRow[];
  decisions: AgentDecisionRow[];
  intents: TradeIntentRow[];
  options?: BuildOpportunityOptions;
}): OpportunityRow[] {
  const span = input.options?.maxCycleSpanMs ?? 10 * 60_000;
  const cycles = new Map(input.cycles.map((c) => [c.cycleId, c]));
  type Group = { funnel: FunnelEventRow[]; decisions: AgentDecisionRow[]; intents: TradeIntentRow[] };
  const groups = new Map<string, Group>();
  const group = (cycleId: string, pair: string) => {
    const key = `${cycleId}|${pair}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { funnel: [], decisions: [], intents: [] }));
    return g;
  };
  for (const row of input.funnel) if (row.pairAddress) group(row.cycleId, row.pairAddress).funnel.push(row);
  for (const row of input.decisions) if (row.pairAddress) group(row.cycleId, row.pairAddress).decisions.push(row);
  for (const row of input.intents) if (row.pairAddress) group(row.cycleId, row.pairAddress).intents.push(row);

  const rows: OpportunityRow[] = [];
  for (const [key, g] of groups) {
    const [cycleId, pairAddress] = key.split("|") as [string, string];
    const cycle = cycles.get(cycleId);
    const writeTimes = [...g.funnel.map((r) => toMs(r.createdAt)), ...g.decisions.map((r) => toMs(r.updatedAt)), ...g.intents.map((r) => toMs(r.createdAt))];
    const anchor = Math.min(...writeTimes, cycle ? toMs(cycle.startedAt) : Number.POSITIVE_INFINITY);
    const cutoff = anchor + span;
    const excluded: ExcludedField[] = [];
    const late = (path: string, at: number) => excluded.push({ path, reason: "LATE_WRITE", knownAt: iso(at) });

    const funnel = g.funnel
      .filter((r) => (toMs(r.createdAt) <= cutoff ? true : (late(`funnel.${r.stage}`, toMs(r.createdAt)), false)))
      .sort((a, b) => toMs(a.createdAt) - toMs(b.createdAt) || a.stage.localeCompare(b.stage));
    const decisions = g.decisions
      .filter((r) => (toMs(r.updatedAt) <= cutoff ? true : (late(`agents.${r.agent}`, toMs(r.updatedAt)), false)))
      .sort((a, b) => a.agent.localeCompare(b.agent));
    const intents = g.intents
      .filter((r) => (toMs(r.createdAt) <= cutoff ? true : (late(`intents.${r.id}`, toMs(r.createdAt)), false)))
      .sort((a, b) => toMs(a.createdAt) - toMs(b.createdAt) || a.id.localeCompare(b.id));
    if (funnel.length + decisions.length + intents.length === 0) continue;

    const included = [...funnel.map((r) => toMs(r.createdAt)), ...decisions.map((r) => toMs(r.updatedAt)), ...intents.map((r) => toMs(r.createdAt))];
    // Intent mutable fields count toward decisionAt only when written inside the window.
    for (const r of intents) if (toMs(r.updatedAt) <= cutoff) included.push(toMs(r.updatedAt));
    const decisionAt = Math.max(...included);

    const agents: OpportunityRow["agents"] = {};
    for (const d of decisions) {
      agents[d.agent] = {
        decision: d.decision,
        confidence: d.confidence,
        modelVersion: d.modelVersion,
        reasonCodes: [...d.reasonCodes],
        inputSource: d.inputSource,
        knownAt: iso(toMs(d.updatedAt)),
        // Each record is cut at its own write time, not at the row's latest write: a feature cannot carry
        // a time later than the moment it was stored.
        features: {
          input: stripFutureTimestamps(d.input ?? null, toMs(d.updatedAt), `agents.${d.agent}.input`, excluded),
          output: stripFutureTimestamps(d.output ?? null, toMs(d.updatedAt), `agents.${d.agent}.output`, excluded),
        },
      };
    }
    const intentRows = intents.map((r) => {
      const mutableKnown = toMs(r.updatedAt) <= decisionAt;
      if (!mutableKnown) excluded.push({ path: `intents.${r.id}.status`, reason: "MUTABLE_AFTER_DECISION", knownAt: iso(toMs(r.updatedAt)) });
      const obsAt = r.observationAt === null ? null : toMs(r.observationAt);
      if (obsAt !== null && obsAt > decisionAt) excluded.push({ path: `intents.${r.id}.observationAt`, reason: "FUTURE_TIMESTAMP", knownAt: iso(obsAt) });
      return {
        id: r.id,
        action: r.action,
        side: r.side,
        source: r.source,
        strategyInstanceId: r.strategyInstanceId,
        strategyVersion: r.strategyVersion,
        configHash: r.configHash,
        requestedQty: r.requestedQty,
        observationId: r.observationId,
        observationAt: obsAt !== null && obsAt <= decisionAt ? iso(obsAt) : null,
        reasonCodes: [...r.reasonCodes],
        knownAt: iso(toMs(r.createdAt)),
        status: mutableKnown ? r.status : null,
        statusReason: mutableKnown ? r.statusReason : null,
        sizedQty: mutableKnown ? r.sizedQty : null,
        sizedNotionalUsd: mutableKnown ? r.sizedNotionalUsd : null,
      };
    });
    const funnelRows = funnel.map((r) => ({
      stage: r.stage,
      reasonCodes: [...r.reasonCodes],
      detail: stripFutureTimestamps(r.detail ?? null, toMs(r.createdAt), `funnel.${r.stage}.detail`, excluded),
      knownAt: iso(toMs(r.createdAt)),
    }));

    const stages = [...new Set(funnel.map((r) => r.stage))].sort();
    const eligible = stages.some((s) => ELIGIBLE_STAGES.has(s)) || intentRows.some((i) => i.action === "ENTER" && (i.status === "ADMITTED" || i.status === "FILLED" || i.status === "PARTIALLY_FILLED"));
    const rejected =
      stages.some((s) => REJECT_STAGES.has(s)) || decisions.some((d) => d.decision === "REJECT") || intentRows.some((i) => i.status === "REJECTED" || i.status === "DEFERRED");
    const outcome: OpportunityOutcome = eligible ? "ELIGIBLE" : rejected ? "REJECTED" : "NON_TRADE";
    const reasonCodes = [...new Set([...funnel.flatMap((r) => r.reasonCodes), ...decisions.flatMap((r) => r.reasonCodes), ...intentRows.flatMap((r) => r.reasonCodes)])].sort();
    const instrumentId = funnel.find((r) => r.instrumentId)?.instrumentId ?? intents[0]?.instrumentId ?? null;

    const row: OpportunityRow = {
      schema: OPPORTUNITY_HISTORY_SCHEMA,
      rowId: `${cycleId}:${pairAddress}`,
      cycleId,
      pairAddress,
      instrumentId,
      accountId: cycle?.accountId ?? funnel[0]?.accountId ?? intents[0]?.accountId ?? null,
      tradingEnvironment: cycle?.tradingEnvironment ?? null,
      dataMode: cycle?.dataMode ?? null,
      cycleStartedAt: cycle ? iso(toMs(cycle.startedAt)) : null,
      decisionAt: iso(decisionAt),
      outcome,
      stages,
      reasonCodes,
      agents,
      funnel: funnelRows,
      intents: intentRows,
      excluded: excluded.sort((a, b) => a.path.localeCompare(b.path) || a.reason.localeCompare(b.reason)),
    };
    const cf = input.options?.counterfactual;
    const series = cf?.series.get(pairAddress);
    if (cf && series) row.hypothetical = counterfactualOutcome(series, decisionAt, cf.horizonsMs);
    rows.push(row);
  }
  return rows.sort((a, b) => a.decisionAt.localeCompare(b.decisionAt) || a.rowId.localeCompare(b.rowId));
}

/** Canonical JSON (keys in code-point order, locale-independent) so equal rows serialise and hash identically. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function opportunityRowHash(row: OpportunityRow): string {
  return createHash("sha256").update(stableJson(row)).digest("hex");
}

export type OpportunityManifest = {
  schema: typeof OPPORTUNITY_HISTORY_SCHEMA;
  rowCount: number;
  timeRange: { firstDecisionAt: string | null; lastDecisionAt: string | null };
  /** sha256 over the sorted row hashes: independent of window size and row order. */
  contentHash: string;
  queryBounds: Record<string, unknown>;
  outcomes: Record<OpportunityOutcome, number>;
  excludedFields: Record<ExcludedField["reason"], number>;
  counterfactual: { included: boolean; label: typeof HYPOTHETICAL; horizonsMs: number[]; rowsWithOutcome: number };
  format: string;
};

/** Streaming manifest: feed rows window by window, then `finish()`. */
export class OpportunityManifestBuilder {
  private readonly hashes: string[] = [];
  private first: string | null = null;
  private last: string | null = null;
  private readonly outcomes: Record<OpportunityOutcome, number> = { ELIGIBLE: 0, REJECTED: 0, NON_TRADE: 0 };
  private readonly excluded: Record<ExcludedField["reason"], number> = { LATE_WRITE: 0, FUTURE_TIMESTAMP: 0, MUTABLE_AFTER_DECISION: 0 };
  private withOutcome = 0;

  add(row: OpportunityRow): void {
    this.hashes.push(opportunityRowHash(row));
    if (this.first === null || row.decisionAt < this.first) this.first = row.decisionAt;
    if (this.last === null || row.decisionAt > this.last) this.last = row.decisionAt;
    this.outcomes[row.outcome] += 1;
    for (const e of row.excluded) this.excluded[e.reason] += 1;
    if (row.hypothetical?.horizons.some((h) => h.forwardReturn !== null)) this.withOutcome += 1;
  }

  finish(input: { queryBounds: Record<string, unknown>; counterfactualHorizonsMs: number[] | null; format: string }): OpportunityManifest {
    const h = createHash("sha256");
    for (const rowHash of [...this.hashes].sort()) h.update(rowHash);
    return {
      schema: OPPORTUNITY_HISTORY_SCHEMA,
      rowCount: this.hashes.length,
      timeRange: { firstDecisionAt: this.first, lastDecisionAt: this.last },
      contentHash: h.digest("hex"),
      queryBounds: input.queryBounds,
      outcomes: { ...this.outcomes },
      excludedFields: { ...this.excluded },
      counterfactual: { included: input.counterfactualHorizonsMs !== null, label: HYPOTHETICAL, horizonsMs: input.counterfactualHorizonsMs ?? [], rowsWithOutcome: this.withOutcome },
      format: input.format,
    };
  }
}

export const OPPORTUNITY_CSV_COLUMNS = [
  "rowId",
  "cycleId",
  "pairAddress",
  "instrumentId",
  "accountId",
  "tradingEnvironment",
  "dataMode",
  "decisionAt",
  "outcome",
  "stages",
  "reasonCodes",
  "agents_json",
  "funnel_json",
  "intents_json",
  "excluded_json",
  "hypothetical_json",
] as const;

function csvCell(value: string | null): string {
  if (value === null) return "";
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function opportunityCsvHeader(): string {
  return OPPORTUNITY_CSV_COLUMNS.join(",");
}

export function opportunityRowToCsv(row: OpportunityRow): string {
  return [
    row.rowId,
    row.cycleId,
    row.pairAddress,
    row.instrumentId,
    row.accountId,
    row.tradingEnvironment,
    row.dataMode,
    row.decisionAt,
    row.outcome,
    row.stages.join("|"),
    row.reasonCodes.join("|"),
    stableJson(row.agents),
    stableJson(row.funnel),
    stableJson(row.intents),
    stableJson(row.excluded),
    row.hypothetical ? stableJson(row.hypothetical) : null,
  ]
    .map(csvCell)
    .join(",");
}
