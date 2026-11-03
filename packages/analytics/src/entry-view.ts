import { canonicalJson, sha256 } from "@odin/shared";
import { exitReasonFor, lotExcursion, type LotEventKind, type LotExcursion, type MarkObservation } from "./lot-history.js";

/**
 * ASCEND-09 point-in-time trade memory. `buildPointInTimeView` turns candidate rows into the view of a
 * lot as it was known at one fill (the entry fill for ENTRY, a reducing fill for EXIT). Every candidate
 * is filtered by its own timestamp against `asOf` (the fill time), so rows recorded later — later
 * observations, decisions, config revisions, fills — cannot enter the view, whatever the caller passes.
 * The view never carries counts of excluded rows (that would leak the future) and never copies free-form
 * JSON that could hold forward-dated values (decision input/output, observation raw payloads).
 *
 * `entryView` is the ENTRY view. `assertNoPostAsOfTimestamps` walks a view and throws on any ISO
 * timestamp later than asOf; the worker calls it before every write.
 */

export const TRADE_MEMORY_BUILDER_VERSION = "trade-memory-1.0.0";

export type PitObservation = {
  id: string;
  pairAddress: string;
  receivedAt: string;
  eventTime: string | null;
  freshness: string;
  dataOrigin: string | null;
  priceUsd: string | null;
  liquidityUsd: string | null;
  volume24hUsd: string | null;
  priceChangeM5: string | null;
  priceChangeH1: string | null;
  pairCreatedAt: string | null;
};

export type PitDecision = {
  id: string;
  cycleId: string;
  agent: string;
  modelVersion: string;
  pairAddress: string;
  decision: string;
  confidence: string;
  reasonCodes: string[];
  inputSource: string | null;
  createdAt: string;
  /**
   * Time of the row's last write. Upserts overwrite content but keep createdAt, so a row whose
   * updatedAt is after asOf (or unknown) may show content changed after the fill and is excluded.
   */
  updatedAt: string | null;
  /** Only numeric cost fields are read from the EXECUTOR output (see costFieldsFrom). */
  output: unknown;
};

export type PitPlanOrder = {
  clientOrderId: string;
  qty?: string;
  estimatedCostUsd?: string;
  estimatedNotionalUsd?: string;
  /** Reason codes as planned (immutable CyclePlan, written before the fill). */
  reasonCodes?: string[];
};

export type PitConfigRevision = { configHash: string; engineUpdatedAt: string; createdAt: string };

export type PitFill = {
  id: string;
  orderId: string;
  pairAddress: string;
  side: "BUY" | "SELL";
  qty: string;
  priceUsd: string;
  notionalUsd: string;
  feeUsd: string;
  feeKnown: boolean;
  slippageBps: string;
  liquidityUsd: string;
  source: string;
  createdAt: string;
  observationId: string | null;
};

export type PitOrder = {
  id: string;
  clientOrderId: string;
  cycleId: string;
  intent: string;
  ownerScope: string | null;
  reasonCodes: string[];
  strategyInstanceId: string | null;
  strategyVersion: string | null;
  executionMode: string;
  venue: string;
  createdAt: string;
  decisionObservationId: string | null;
  observationId: string | null;
  fillObservationId: string | null;
};

export type PitStrategyInstance = {
  id: string;
  name: string;
  version: string;
  moduleRef: string | null;
  artifactHash: string | null;
  sourceHash: string | null;
  updatedAt: string;
};

export type SnapshotPhase = "ENTRY" | "ADD" | "EXIT";

/** ENTRY for the opening fill, ADD for an increase, EXIT for every reducing fill (REDUCE or EXIT). */
export function phaseForEvent(kind: LotEventKind): SnapshotPhase {
  return kind === "ENTRY" ? "ENTRY" : kind === "ADD" ? "ADD" : "EXIT";
}

export type PointInTimeSource = {
  phase: SnapshotPhase;
  accountId: string;
  /** Lot key = id of the fill that opened the lot. */
  entryFillId: string;
  /** Lot open time (entry fill time). */
  openedAt: string;
  /** The fill this view is anchored to (the entry fill for ENTRY). Its createdAt is asOf. */
  fill: PitFill;
  order: PitOrder;
  /** Classification from the lot history prefix (ENTRY / ADD / REDUCE / EXIT). */
  kind: LotEventKind;
  positionQtyBefore: string;
  positionQtyAfter: string;
  realizedPnlUsd: string | null;
  /** Candidate rows; anything timestamped after asOf is ignored. */
  observations: readonly PitObservation[];
  marks?: readonly MarkObservation[];
  decisions: readonly PitDecision[];
  plan: { plannedAt: string; orders: readonly PitPlanOrder[] } | null;
  configRevisions: readonly PitConfigRevision[];
  cycle: { id: string; startedAt: string; configRevision: string | null; tradingEnvironment: string | null; dataMode: string | null } | null;
  strategyInstance: PitStrategyInstance | null;
  /** EXIT only: the lot's entry fill price, the excursion reference. */
  entryPriceUsd?: string;
  /** EXIT only: true when the mark query hit its row cap (the excursion covers a prefix of the window). */
  marksTruncated?: boolean;
};

export type PointInTimeView = {
  builderVersion: string;
  phase: SnapshotPhase;
  asOf: string;
  accountId: string;
  entryFillId: string;
  openedAt: string;
  fill: {
    id: string;
    orderId: string;
    kind: LotEventKind;
    side: "BUY" | "SELL";
    qty: string;
    priceUsd: string;
    notionalUsd: string;
    feeUsd: string;
    feeKnown: boolean;
    slippageBps: string;
    liquidityUsd: string;
    source: string;
    at: string;
    positionQtyBefore: string;
    positionQtyAfter: string;
    realizedPnlUsd: string | null;
  };
  order: {
    id: string;
    clientOrderId: string;
    cycleId: string;
    intent: string;
    ownerScope: string | null;
    reasonCodes: string[];
    /**
     * CYCLE_PLAN_AT_DECISION: codes from the immutable plan, recorded before the fill.
     * ORDER_CURRENT_STATE: Order.reasonCodes as stored now (the order row is mutable; may include later codes).
     */
    reasonCodesSource: "CYCLE_PLAN_AT_DECISION" | "ORDER_CURRENT_STATE";
    exitReason: { code: string; source: string } | null;
    executionMode: string;
    venue: string;
    createdAt: string | null;
  };
  decisionObservation: ObservationView | null;
  fillObservation: ObservationView | null;
  quoteFreshness: {
    decisionObservationAgeAtOrderMs: number | null;
    decisionObservationAgeAtFillMs: number | null;
    fillObservationAgeAtFillMs: number | null;
    decisionFreshness: string | null;
    fillFreshness: string | null;
  };
  decisions: DecisionView[];
  /** True when at least one decision for this cycle and pair was rewritten after asOf (or has no known write time). */
  decisionUnavailable: boolean;
  unavailableDecisions: Array<{ id: string; agent: string; pairAddress: string; createdAt: string; reason: "UPDATED_AFTER_ASOF" | "UPDATE_TIME_UNKNOWN" }>;
  estimatedCost: {
    source: "CYCLE_PLAN" | "NONE";
    plannedAt: string | null;
    plannedQty: string | null;
    estimatedCostUsd: string | null;
    estimatedNotionalUsd: string | null;
    executorDecision: Record<string, string> | null;
    /** Realised at the fill itself (known at asOf). */
    realisedFeeUsd: string;
    realisedSlippageBps: string;
  };
  strategy: {
    strategyInstanceId: string | null;
    strategyVersion: string | null;
    instance: Omit<PitStrategyInstance, "updatedAt"> | null;
    instanceState: "AT_OR_BEFORE_ASOF" | "UPDATED_AFTER_ASOF_OMITTED" | "NOT_FOUND" | "NO_INSTANCE";
  };
  config: {
    configHash: string | null;
    method: "CYCLE_PINNED_REVISION" | "LATEST_REVISION_AT_OR_BEFORE_ASOF" | "NO_REVISION_RECORDED";
    revisionCreatedAt: string | null;
    cycleId: string | null;
    tradingEnvironment: string | null;
    dataMode: string | null;
  };
  /** EXIT views only: excursion from marks in [openedAt, asOf]. */
  excursionToDate: LotExcursion | null;
  /** EXIT views only: the mark query hit its cap; null for other phases. */
  excursionTruncated: boolean | null;
};

export type ObservationView = {
  id: string;
  receivedAt: string;
  eventTime: string | null;
  freshness: string;
  dataOrigin: string | null;
  priceUsd: string | null;
  liquidityUsd: string | null;
  volume24hUsd: string | null;
  priceChangeM5: string | null;
  priceChangeH1: string | null;
  pairCreatedAt: string | null;
};

export type DecisionView = {
  id: string;
  agent: string;
  modelVersion: string;
  pairAddress: string;
  decision: string;
  confidence: string;
  reasonCodes: string[];
  inputSource: string | null;
  createdAt: string;
};

const ms = (iso: string) => Date.parse(iso);
const atOrBefore = (iso: string | null | undefined, asOf: number) => iso != null && Number.isFinite(ms(iso)) && ms(iso) <= asOf;

function observationView(row: PitObservation): ObservationView {
  return {
    id: row.id,
    receivedAt: row.receivedAt,
    eventTime: row.eventTime,
    freshness: row.freshness,
    dataOrigin: row.dataOrigin,
    priceUsd: row.priceUsd,
    liquidityUsd: row.liquidityUsd,
    volume24hUsd: row.volume24hUsd,
    priceChangeM5: row.priceChangeM5,
    priceChangeH1: row.priceChangeH1,
    pairCreatedAt: row.pairCreatedAt,
  };
}

/** An observation is usable only if it was received (and, when known, produced) at or before asOf. */
function pickObservation(rows: readonly PitObservation[], id: string | null, pairAddress: string, asOf: number): ObservationView | null {
  if (!id) return null;
  const row = rows.find((item) => item.id === id && item.pairAddress === pairAddress);
  if (!row || !atOrBefore(row.receivedAt, asOf)) return null;
  if (row.eventTime !== null && !atOrBefore(row.eventTime, asOf)) return null;
  if (row.pairCreatedAt !== null && !atOrBefore(row.pairCreatedAt, asOf)) return { ...observationView(row), pairCreatedAt: null };
  return observationView(row);
}

const COST_KEYS = ["qty", "priceUsd", "notionalUsd", "feeUsd", "slippageBps", "estimatedCostUsd", "spreadBps", "impactBps"] as const;

/** Numeric cost estimates from an EXECUTOR decision's output; every other key (timestamps included) is dropped. */
function costFieldsFrom(output: unknown): Record<string, string> | null {
  if (!output || typeof output !== "object") return null;
  const record = output as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of COST_KEYS) {
    const value = record[key];
    if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) out[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = String(value);
  }
  return Object.keys(out).length === 0 ? null : out;
}

export function buildPointInTimeView(source: PointInTimeSource): PointInTimeView {
  const asOfIso = source.fill.createdAt;
  const asOf = ms(asOfIso);
  const pair = source.fill.pairAddress;
  const orderCreatedAt = atOrBefore(source.order.createdAt, asOf) ? source.order.createdAt : null;
  const decisionObservation = pickObservation(source.observations, source.order.decisionObservationId ?? source.order.observationId, pair, asOf);
  const fillObservation = pickObservation(source.observations, source.fill.observationId ?? source.order.fillObservationId, pair, asOf);

  const scoped = source.decisions
    .filter((row) => row.cycleId === source.order.cycleId && (row.pairAddress === pair || row.pairAddress === "") && atOrBefore(row.createdAt, asOf))
    .sort((left, right) => ms(left.createdAt) - ms(right.createdAt) || left.agent.localeCompare(right.agent) || left.id.localeCompare(right.id));
  // A row rewritten after asOf would show post-fill content under a pre-fill createdAt: exclude it.
  const decisions = scoped.filter((row) => atOrBefore(row.updatedAt, asOf));
  const unavailable = scoped
    .filter((row) => !atOrBefore(row.updatedAt, asOf))
    .map((row) => ({
      id: row.id,
      agent: row.agent,
      pairAddress: row.pairAddress,
      createdAt: row.createdAt,
      reason: row.updatedAt === null ? ("UPDATE_TIME_UNKNOWN" as const) : ("UPDATED_AFTER_ASOF" as const),
    }));
  const executor = decisions.filter((row) => row.agent === "EXECUTOR" && row.pairAddress === pair).at(-1) ?? null;

  const plan = source.plan && atOrBefore(source.plan.plannedAt, asOf) ? source.plan : null;
  const planned = plan?.orders.find((row) => row.clientOrderId === source.order.clientOrderId) ?? null;
  const plannedCodes = planned?.reasonCodes ?? null;
  const reasonCodes = plannedCodes ? [...plannedCodes] : [...source.order.reasonCodes];
  const reasonCodesSource = plannedCodes ? ("CYCLE_PLAN_AT_DECISION" as const) : ("ORDER_CURRENT_STATE" as const);

  const revisions = source.configRevisions.filter((row) => atOrBefore(row.createdAt, asOf));
  const pinned = source.cycle?.configRevision
    ? revisions.filter((row) => ms(row.engineUpdatedAt) === ms(source.cycle!.configRevision!)).sort((a, b) => ms(a.createdAt) - ms(b.createdAt)).at(-1)
    : undefined;
  const latest = [...revisions].sort((a, b) => ms(a.createdAt) - ms(b.createdAt) || a.configHash.localeCompare(b.configHash)).at(-1);
  const revision = pinned ?? latest ?? null;
  const cycle = source.cycle && atOrBefore(source.cycle.startedAt, asOf) ? source.cycle : null;

  const instanceId = source.order.strategyInstanceId;
  let instanceState: PointInTimeView["strategy"]["instanceState"] = "NO_INSTANCE";
  let instance: PointInTimeView["strategy"]["instance"] = null;
  if (instanceId) {
    const row = source.strategyInstance && source.strategyInstance.id === instanceId ? source.strategyInstance : null;
    if (!row) instanceState = "NOT_FOUND";
    else if (!atOrBefore(row.updatedAt, asOf)) instanceState = "UPDATED_AFTER_ASOF_OMITTED";
    else {
      instanceState = "AT_OR_BEFORE_ASOF";
      instance = { id: row.id, name: row.name, version: row.version, moduleRef: row.moduleRef, artifactHash: row.artifactHash, sourceHash: row.sourceHash };
    }
  }

  const age = (from: string | null | undefined, to: string | null) => (from && to ? ms(to) - ms(from) : null);
  const excursion =
    source.phase === "EXIT" && source.marks
      ? lotExcursion(
          { pairAddress: pair, openedAt: source.openedAt, closedAt: asOfIso, referencePriceUsd: entryPriceOf(source) },
          source.marks.filter((row) => atOrBefore(row.receivedAt, asOf)),
          asOfIso,
        )
      : null;

  return {
    builderVersion: TRADE_MEMORY_BUILDER_VERSION,
    phase: source.phase,
    asOf: asOfIso,
    accountId: source.accountId,
    entryFillId: source.entryFillId,
    openedAt: source.openedAt,
    fill: {
      id: source.fill.id,
      orderId: source.fill.orderId,
      kind: source.kind,
      side: source.fill.side,
      qty: source.fill.qty,
      priceUsd: source.fill.priceUsd,
      notionalUsd: source.fill.notionalUsd,
      feeUsd: source.fill.feeUsd,
      feeKnown: source.fill.feeKnown,
      slippageBps: source.fill.slippageBps,
      liquidityUsd: source.fill.liquidityUsd,
      source: source.fill.source,
      at: asOfIso,
      positionQtyBefore: source.positionQtyBefore,
      positionQtyAfter: source.positionQtyAfter,
      realizedPnlUsd: source.realizedPnlUsd,
    },
    order: {
      id: source.order.id,
      clientOrderId: source.order.clientOrderId,
      cycleId: source.order.cycleId,
      intent: source.order.intent,
      ownerScope: source.order.ownerScope,
      reasonCodes,
      reasonCodesSource,
      exitReason: source.fill.side === "SELL" ? exitReasonFor({ reasonCodes, intent: source.order.intent, ownerScope: source.order.ownerScope }) : null,
      executionMode: source.order.executionMode,
      venue: source.order.venue,
      createdAt: orderCreatedAt,
    },
    decisionObservation,
    fillObservation,
    quoteFreshness: {
      decisionObservationAgeAtOrderMs: age(decisionObservation?.receivedAt, orderCreatedAt),
      decisionObservationAgeAtFillMs: age(decisionObservation?.receivedAt, asOfIso),
      fillObservationAgeAtFillMs: age(fillObservation?.receivedAt, asOfIso),
      decisionFreshness: decisionObservation?.freshness ?? null,
      fillFreshness: fillObservation?.freshness ?? null,
    },
    decisions: decisions.map((row) => ({
      id: row.id,
      agent: row.agent,
      modelVersion: row.modelVersion,
      pairAddress: row.pairAddress,
      decision: row.decision,
      confidence: row.confidence,
      reasonCodes: [...row.reasonCodes],
      inputSource: row.inputSource,
      createdAt: row.createdAt,
    })),
    decisionUnavailable: unavailable.length > 0,
    unavailableDecisions: unavailable,
    estimatedCost: {
      source: planned ? "CYCLE_PLAN" : "NONE",
      plannedAt: planned ? plan!.plannedAt : null,
      plannedQty: planned?.qty ?? null,
      estimatedCostUsd: planned?.estimatedCostUsd ?? null,
      estimatedNotionalUsd: planned?.estimatedNotionalUsd ?? null,
      executorDecision: executor ? costFieldsFrom(executor.output) : null,
      realisedFeeUsd: source.fill.feeUsd,
      realisedSlippageBps: source.fill.slippageBps,
    },
    strategy: {
      strategyInstanceId: instanceId,
      strategyVersion: source.order.strategyVersion,
      instance,
      instanceState,
    },
    config: {
      configHash: revision?.configHash ?? null,
      method: pinned ? "CYCLE_PINNED_REVISION" : latest ? "LATEST_REVISION_AT_OR_BEFORE_ASOF" : "NO_REVISION_RECORDED",
      revisionCreatedAt: revision?.createdAt ?? null,
      cycleId: cycle?.id ?? null,
      tradingEnvironment: cycle?.tradingEnvironment ?? null,
      dataMode: cycle?.dataMode ?? null,
    },
    excursionToDate: excursion,
    excursionTruncated: excursion === null ? null : source.marksTruncated === true,
  };
}

/** EXIT excursion reference: the lot's entry fill price (known at the entry fill, before asOf). */
function entryPriceOf(source: PointInTimeSource): string {
  return source.entryPriceUsd ?? source.fill.priceUsd;
}

/** The ENTRY view of a lot: the point-in-time view at its entry fill. */
export function entryView(source: Omit<PointInTimeSource, "phase" | "kind">): PointInTimeView {
  if (source.fill.id !== source.entryFillId) throw new Error("ENTRY_VIEW_REQUIRES_ENTRY_FILL");
  return buildPointInTimeView({ ...source, phase: "ENTRY", kind: "ENTRY" });
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Every ISO timestamp anywhere in `value`, with its JSON path. */
export function collectTimestamps(value: unknown, path = "$"): Array<{ path: string; at: string }> {
  if (typeof value === "string") return ISO.test(value) ? [{ path, at: value }] : [];
  if (Array.isArray(value)) return value.flatMap((item, index) => collectTimestamps(item, `${path}[${index}]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, inner]) => collectTimestamps(inner, `${path}.${key}`));
  return [];
}

/** Throws POST_ASOF_TIMESTAMP when any timestamp in the view is later than view.asOf. */
export function assertNoPostAsOfTimestamps(view: PointInTimeView): void {
  const limit = ms(view.asOf);
  const late = collectTimestamps(view).filter((item) => ms(item.at) > limit);
  if (late.length > 0) throw new Error(`POST_ASOF_TIMESTAMP ${late.map((item) => `${item.path}=${item.at}`).join(", ")}`);
}

/** sha256 of the canonical JSON of a view (stable key order). */
export function viewHash(view: PointInTimeView): string {
  return sha256(canonicalJson(view));
}
