import { Prisma, toJson, type PrismaClient } from "@odin/shared/db";
import { canonicalHash } from "../genesis/canonical.js";
import type { UnitEvaluation } from "./evaluate.js";
import { marketFor, normaliseInstrument } from "./spec.js";
import { CampaignError, insertHoldoutResult, logEvent, specOf } from "./store.js";
import { campaignTx } from "./tx.js";

/**
 * OPERATION EVIDENCE holdout accounting.
 *
 * A holdout is a period of one instrument at one bar size. Reading its outcomes once, for one frozen
 * hypothesis, is a test; reading it again after seeing the answer is tuning. So:
 *  - a campaign never reads a holdout by itself: the walk-forward phase always withholds it;
 *  - an operator authorises one read for one frozen walk-forward result (AUTHORIZED: who, when, until when,
 *    bound by hash to that result and that period);
 *  - the read is preceded by a committed CONSUME_INTENT. From that commit on the period is spent for the
 *    hypothesis lineage, whatever happens next: a crash, a rollback of the result write, a timeout;
 *  - the intent is closed by RESULT_RECORDED (with the stored result) or RESULT_LOST. A lost result is never
 *    recomputed: the answer may have been seen, so the lineage needs bars after that period.
 * Identity is deliberately wider than names: the instrument is normalised, the lineage is the strategy family
 * (or the ML label horizon), and a period matches by time overlap. Renaming a strategy, re-importing or
 * appending to a dataset, or bumping a version therefore meets the earlier access again.
 * Residual: a hypothesis deliberately filed under another family, or an instrument under an unrelated name,
 * is not recognised. `priorLooks` (every earlier read of an overlapping period on the instrument, any lineage)
 * is shown to the operator at authorisation and stored with the intent so that multiplicity stays visible.
 */

type Tx = Prisma.TransactionClient;
type Db = PrismaClient | Tx;

export const MAX_HOLDOUT_AUTHORISATION_MS = 7 * 86_400_000;
/** Closing an open intent as lost is irreversible, so the wait is generous: twice the runtime limit plus this. */
const HOLDOUT_RESULT_GRACE_MS = 600_000;

export type HoldoutContext = {
  unitId: string;
  runId: string;
  hypothesisKind: string;
  hypothesisId: string;
  lineageKey: string;
  instrumentKey: string;
  barMs: number;
  interval: string;
  periodStart: Date;
  periodEnd: Date;
  datasetHash: string;
  warehouseDatasetId: string | null;
  walkForwardHash: string;
  walkForwardResultHash: string;
  priorTrials: number;
  subjectHash: string;
  maxRuntimeMs: number;
  /** Why this unit may not start a holdout read (below the market minimum sample), or null. */
  underSampled: string | null;
};

export function holdoutSubjectHash(c: Omit<HoldoutContext, "subjectHash" | "runId" | "priorTrials" | "maxRuntimeMs" | "interval" | "warehouseDatasetId" | "hypothesisKind" | "underSampled">): string {
  return canonicalHash({ unitId: c.unitId, hypothesisId: c.hypothesisId, lineageKey: c.lineageKey, instrumentKey: c.instrumentKey, barMs: c.barMs, periodStart: c.periodStart, periodEnd: c.periodEnd, datasetHash: c.datasetHash, walkForwardHash: c.walkForwardHash, walkForwardResultHash: c.walkForwardResultHash });
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Loads the frozen walk-forward result a holdout read would be for, and refuses anything not eligible. */
export async function holdoutContext(db: Db, unitId: string): Promise<HoldoutContext> {
  const unit = await db.researchCampaignUnit.findUnique({ where: { id: unitId }, include: { run: { include: { campaign: true } }, results: true } });
  if (!unit) throw new CampaignError("NOT_FOUND", `unit ${unitId}`);
  const wf = unit.results.find((r) => r.phase === "WALK_FORWARD");
  if (!wf) throw new CampaignError("NOT_ELIGIBLE", `unit ${unitId} has no walk-forward result (state ${unit.state})`);
  if (!wf.walkForwardPassed) throw new CampaignError("NOT_ELIGIBLE", `unit ${unitId} did not pass walk-forward (${wf.verdict}): ${wf.reasons[0] ?? "no reason recorded"}. A holdout is read only for a hypothesis that passed every earlier test`);
  const summary = obj(wf.summary);
  const dataset = obj(wf.dataset);
  const provenance = obj(wf.provenance);
  const period = obj(summary.holdoutPeriod);
  const source = obj(dataset.source);
  if (typeof period.start !== "string" || typeof period.end !== "string" || typeof summary.walkForwardHash !== "string" || typeof dataset.instrumentKey !== "string" || typeof dataset.barMs !== "number" || typeof dataset.contentHash !== "string" || typeof provenance.lineageKey !== "string") {
    throw new CampaignError("NOT_ELIGIBLE", `unit ${unitId}: the walk-forward result lacks a holdout period or identity`);
  }
  const { spec } = specOf(unit.run.campaign);
  // A hypothesis below its market's minimum sample can never be a candidate, so it must not spend the period.
  // Checked where a read is authorised or started, not here: this context also serves closing an existing read.
  const declared = spec.datasets.find((d) => d.key === unit.datasetKey);
  const minTrades = declared ? marketFor(declared).minimumSample.minOosTrades : 0;
  const oosTrades = obj(summary.oos).trades;
  const underSampled = unit.hypothesisKind === "STRATEGY" && typeof oosTrades === "number" && oosTrades < minTrades ? `unit ${unitId} has ${oosTrades} out-of-sample trades, below the market minimum of ${minTrades}; it could not become a candidate, so its holdout is not read` : null;
  const base = {
    unitId,
    hypothesisId: unit.hypothesisId,
    lineageKey: provenance.lineageKey,
    instrumentKey: dataset.instrumentKey,
    barMs: dataset.barMs,
    periodStart: new Date(period.start),
    periodEnd: new Date(period.end),
    datasetHash: dataset.contentHash,
    walkForwardHash: summary.walkForwardHash,
    walkForwardResultHash: wf.resultHash,
  };
  return { ...base, runId: unit.runId, hypothesisKind: unit.hypothesisKind, interval: String(dataset.interval), warehouseDatasetId: source.kind === "WAREHOUSE" && typeof source.datasetId === "string" ? source.datasetId : null, priorTrials: wf.priorTrials, subjectHash: holdoutSubjectHash(base), maxRuntimeMs: spec.limits.maxRuntimeMsPerUnit, underSampled };
}

export type PriorAccess = { source: "CAMPAIGN_LEDGER" | "LEGACY_REGISTRY" | "WALK_FORWARD_SEEN"; unitId: string | null; lineageKey: string; periodStart: string | null; periodEnd: string | null; consumedAt: string; why: string };

/**
 * Earlier use of this instrument that stands in the way of reading `c`'s holdout. Identity is the normalised
 * instrument, the lineage and the calendar period: the bar size is deliberately NOT part of it, because 1h and
 * 4h bars over the same weeks are the same market history and a second interval would be a free second look.
 * `blocking`:
 *  - an earlier holdout read by the same lineage whose period overlaps;
 *  - an earlier walk-forward by the same lineage (another unit) that already tested bars inside this period
 *    as in-sample or walk-forward data: declaring an earlier as-of instant must not turn bars the lineage has
 *    already been scored on into a "holdout";
 *  - an ASCEND-registry access by the same strategy id on any dataset of the instrument (no period recorded).
 * `priorLooks` counts every earlier read of an overlapping period on the instrument, any lineage, any interval.
 */
export async function priorHoldoutAccess(db: Db, c: HoldoutContext): Promise<{ priorLooks: number; blocking: PriorAccess[] }> {
  const overlap = { kind: "CONSUME_INTENT", instrumentKey: c.instrumentKey, unitId: { not: c.unitId }, periodStart: { lt: c.periodEnd }, periodEnd: { gt: c.periodStart } };
  const [priorLooks, sameLineage] = await Promise.all([
    db.researchHoldoutLedger.count({ where: overlap }),
    db.researchHoldoutLedger.findMany({ where: { ...overlap, lineageKey: c.lineageKey }, orderBy: { createdAt: "asc" }, take: 100 }),
  ]);
  const blocking: PriorAccess[] = sameLineage.map((r) => ({ source: "CAMPAIGN_LEDGER" as const, unitId: r.unitId, lineageKey: r.lineageKey, periodStart: r.periodStart.toISOString(), periodEnd: r.periodEnd.toISOString(), consumedAt: r.createdAt.toISOString(), why: `already read an overlapping holdout of ${c.instrumentKey} (${r.periodStart.toISOString()} to ${r.periodEnd.toISOString()}); only bars after that period can confirm this hypothesis` }));
  // Bars this lineage has already been walked forward on, in another unit, are not a holdout.
  const seen = await db.researchCampaignResult.findMany({
    where: { phase: "WALK_FORWARD", unitId: { not: c.unitId }, dataset: { path: ["instrumentKey"], equals: c.instrumentKey }, provenance: { path: ["lineageKey"], equals: c.lineageKey } },
    // Newest first: the most recent results are the ones most likely to reach furthest forward.
    orderBy: { createdAt: "desc" },
    take: 2_000,
    select: { unitId: true, summary: true, createdAt: true },
  });
  for (const row of seen) {
    const start = obj(obj(row.summary).holdoutPeriod).start;
    if (typeof start === "string" && Date.parse(start) > c.periodStart.getTime()) {
      blocking.push({ source: "WALK_FORWARD_SEEN", unitId: row.unitId, lineageKey: c.lineageKey, periodStart: null, periodEnd: start, consumedAt: row.createdAt.toISOString(), why: `was already walked forward on ${c.instrumentKey} bars up to ${start} (unit ${row.unitId}), which lie inside this holdout period; those bars are not unseen` });
      break;
    }
  }
  // The ASCEND registry records no period, so an access by this strategy id on any dataset of the instrument blocks.
  // Rows written by campaign units are covered, with their periods, by the ledger above.
  const datasets = await db.historicalDataset.findMany({ select: { id: true, instrumentKey: true }, orderBy: { id: "asc" }, take: 5_000 });
  const siblings = datasets.filter((d) => normaliseInstrument(d.instrumentKey) === c.instrumentKey).map((d) => d.id);
  const legacy = siblings.length
    ? await db.researchHoldoutAccess.findMany({ where: { strategyId: c.hypothesisId, datasetId: { in: siblings }, NOT: { runId: { startsWith: "campaign-unit:" } } }, take: 100 })
    : [];
  for (const row of legacy) blocking.push({ source: "LEGACY_REGISTRY", unitId: null, lineageKey: `strategyId:${row.strategyId}`, periodStart: null, periodEnd: null, consumedAt: row.consumedAt.toISOString(), why: `strategy ${row.strategyId} already consumed a holdout on ${c.instrumentKey} in the ASCEND registry (no period recorded, so every period is treated as spent)` });
  return { priorLooks: priorLooks + legacy.length, blocking };
}

/** Operator authorisation of one holdout read for one frozen walk-forward result. Append-only; expires. */
export async function authorizeHoldout(prisma: PrismaClient, input: { unitId: string; operator: string; ttlMs: number; note?: string; now?: Date }) {
  const operator = input.operator.trim();
  if (!/^[A-Za-z0-9_.@+-]{1,120}$/.test(operator)) throw new CampaignError("OPERATOR_REQUIRED", "authorisation needs an operator identity");
  if (!(input.ttlMs >= 60_000 && input.ttlMs <= MAX_HOLDOUT_AUTHORISATION_MS)) throw new CampaignError("BAD_TTL", `authorisation lifetime must be between 1 minute and ${MAX_HOLDOUT_AUTHORISATION_MS / 86_400_000} days`);
  const c = await holdoutContext(prisma, input.unitId);
  if (c.underSampled) throw new CampaignError("NOT_ELIGIBLE", c.underSampled);
  const intent = await prisma.researchHoldoutLedger.findFirst({ where: { unitId: c.unitId, kind: "CONSUME_INTENT" } });
  if (intent) throw new CampaignError("ALREADY_CONSUMED", `unit ${c.unitId} already consumed its holdout at ${intent.createdAt.toISOString()}`);
  const prior = await priorHoldoutAccess(prisma, c);
  if (prior.blocking.length) throw new CampaignError("HOLDOUT_ALREADY_CONSUMED", `${c.lineageKey} ${prior.blocking[0]!.why}`);
  const now = input.now ?? new Date();
  // createdAt is written explicitly so the lifetime check does not depend on two clocks.
  const row = await prisma.researchHoldoutLedger.create({
    data: { kind: "AUTHORIZED", unitId: c.unitId, lineageKey: c.lineageKey, instrumentKey: c.instrumentKey, barMs: c.barMs, periodStart: c.periodStart, periodEnd: c.periodEnd, datasetHash: c.datasetHash, subjectHash: c.subjectHash, actor: `operator:${operator}`, createdAt: now, expiresAt: new Date(now.getTime() + input.ttlMs), note: `${input.note?.trim() ?? ""}${input.note ? " | " : ""}prior looks at an overlapping period of this instrument (any hypothesis, any interval): ${prior.priorLooks}`.slice(0, 2000) },
  });
  await logEvent(prisma, { runId: c.runId, unitId: c.unitId, kind: "HOLDOUT_AUTHORIZED", actor: row.actor, detail: { expiresAt: row.expiresAt, subjectHash: c.subjectHash, priorLooks: prior.priorLooks, period: { start: c.periodStart, end: c.periodEnd } } });
  return { authorisation: row, priorLooks: prior.priorLooks, context: c };
}

export type BeginHoldout =
  | { status: "INTENT_COMMITTED"; context: HoldoutContext; priorLooks: number }
  | { status: "ALREADY_CLOSED"; closedAs: string }
  | { status: "IN_PROGRESS"; since: string }
  | { status: "RESULT_LOST" };

/**
 * Commits the intent to read a holdout. Serialised per instrument, so two executors cannot both
 * consume, and a second call for a unit whose intent exists never reads again: it reports the stored close,
 * or (once the runtime limit has passed without a result) records the result as lost.
 */
export async function beginHoldout(prisma: PrismaClient, input: { unitId: string; actor: string; now?: Date }): Promise<BeginHoldout> {
  const c = await holdoutContext(prisma, input.unitId);
  const now = input.now ?? new Date();
  return campaignTx(prisma, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`holdout:${c.instrumentKey}`}))`;
    const rows = await tx.researchHoldoutLedger.findMany({ where: { unitId: c.unitId }, orderBy: { createdAt: "asc" } });
    const intent = rows.find((r) => r.kind === "CONSUME_INTENT");
    if (intent) {
      const close = rows.find((r) => r.kind === "RESULT_RECORDED" || r.kind === "RESULT_LOST");
      if (close) return { status: "ALREADY_CLOSED" as const, closedAs: close.kind };
      // Both instants come from the database clock, so two hosts with different clocks agree on the window.
      const clock = await tx.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`;
      const dbNow = clock[0]?.now ?? now;
      if (dbNow.getTime() < intent.createdAt.getTime() + 2 * c.maxRuntimeMs + HOLDOUT_RESULT_GRACE_MS) return { status: "IN_PROGRESS" as const, since: intent.createdAt.toISOString() };
      await closeLost(tx, c, input.actor, `no result was stored within the runtime limit after the intent of ${intent.createdAt.toISOString()}`);
      return { status: "RESULT_LOST" as const };
    }
    const authorisation = [...rows].reverse().find((r) => r.kind === "AUTHORIZED" && r.subjectHash === c.subjectHash && r.expiresAt !== null && r.createdAt.getTime() <= now.getTime() && now.getTime() < r.expiresAt.getTime());
    if (!authorisation) {
      const stale = rows.some((r) => r.kind === "AUTHORIZED");
      throw new CampaignError("NOT_AUTHORIZED", stale ? `unit ${c.unitId}: its holdout authorisation has expired or was given for a different result` : `unit ${c.unitId}: no operator has authorised a holdout read; the holdout stays withheld`);
    }
    if (c.underSampled) throw new CampaignError("NOT_ELIGIBLE", c.underSampled);
    const prior = await priorHoldoutAccess(tx, c);
    if (prior.blocking.length) throw new CampaignError("HOLDOUT_ALREADY_CONSUMED", `${c.lineageKey} ${prior.blocking[0]!.why}`);
    await tx.researchHoldoutLedger.create({
      data: { kind: "CONSUME_INTENT", unitId: c.unitId, lineageKey: c.lineageKey, instrumentKey: c.instrumentKey, barMs: c.barMs, periodStart: c.periodStart, periodEnd: c.periodEnd, datasetHash: c.datasetHash, subjectHash: c.subjectHash, actor: input.actor, note: `authorised by ${authorisation.actor} (${authorisation.id}); prior looks ${prior.priorLooks}` },
    });
    // Shared with the ASCEND CLIs and the research loop, so they also see this instrument's holdout as spent.
    if (c.warehouseDatasetId) {
      await tx.researchHoldoutAccess.create({ data: { strategyId: c.hypothesisId, strategyVersion: `campaign-unit:${c.unitId}`, datasetId: c.warehouseDatasetId, runId: `campaign-unit:${c.unitId}` } });
    }
    await logEvent(tx, { runId: c.runId, unitId: c.unitId, kind: "HOLDOUT_INTENT_COMMITTED", actor: input.actor, detail: { authorisedBy: authorisation.actor, priorLooks: prior.priorLooks, period: { start: c.periodStart, end: c.periodEnd } } });
    return { status: "INTENT_COMMITTED" as const, context: c, priorLooks: prior.priorLooks };
  });
}

async function closeLost(tx: Tx, c: HoldoutContext, actor: string, why: string): Promise<void> {
  // Only a committed read can be lost. Without an intent nothing was consumed and nothing may be closed.
  const intent = await tx.researchHoldoutLedger.findFirst({ where: { unitId: c.unitId, kind: "CONSUME_INTENT" }, select: { id: true } });
  if (!intent) throw new CampaignError("NO_INTENT", `unit ${c.unitId} has no committed consume intent; there is no holdout read to close`);
  const wf = await tx.researchCampaignResult.findUniqueOrThrow({ where: { unitId_phase: { unitId: c.unitId, phase: "WALK_FORWARD" } } });
  const reason = `Holdout consumed but its result was not stored (${why}). The outcome may have been seen, so it is not recomputed: this hypothesis needs bars after ${c.periodEnd.toISOString()}`;
  await tx.researchHoldoutLedger.create({ data: { kind: "RESULT_LOST", unitId: c.unitId, lineageKey: c.lineageKey, instrumentKey: c.instrumentKey, barMs: c.barMs, periodStart: c.periodStart, periodEnd: c.periodEnd, datasetHash: c.datasetHash, subjectHash: c.subjectHash, actor, note: why.slice(0, 2000) } });
  const summary = { lost: true, holdoutPeriod: { start: c.periodStart.toISOString(), end: c.periodEnd.toISOString() }, requires: "fresh evidence: bars after the consumed period" };
  await tx.researchCampaignResult.create({
    data: { unitId: c.unitId, phase: "HOLDOUT", verdict: "HOLDOUT_CONSUMED_RESULT_LOST", reasons: [reason], walkForwardPassed: true, holdoutStatus: "CONSUMED_RESULT_LOST", trialCount: wf.trialCount, priorTrials: wf.priorTrials, dataset: toJson(wf.dataset), provenance: toJson(wf.provenance), summary: toJson(summary), detailCanonical: "{}", resultHash: canonicalHash({ lost: true, subjectHash: c.subjectHash, why }), runtimeMs: 0, peakRssMb: 0 },
  });
  await logEvent(tx, { runId: c.runId, unitId: c.unitId, kind: "HOLDOUT_RESULT_LOST", actor, detail: { why } });
}

/** Records that a consumed holdout produced no storable result (evaluator crash, timeout, mismatch). */
export async function recordHoldoutLost(prisma: PrismaClient, input: { unitId: string; actor: string; why: string }): Promise<"RESULT_LOST" | "ALREADY_CLOSED"> {
  const c = await holdoutContext(prisma, input.unitId);
  try {
    await campaignTx(prisma, (tx) => closeLost(tx, c, input.actor, input.why));
    return "RESULT_LOST";
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return "ALREADY_CLOSED";
    throw error;
  }
}

/** Stores the holdout result and closes the intent in one transaction. A second close is refused by the database. */
export async function recordHoldoutResult(prisma: PrismaClient, input: { unitId: string; actor: string; evaluation: UnitEvaluation; metrics: { runtimeMs: number; peakRssMb: number } }): Promise<"RECORDED" | "ALREADY_CLOSED"> {
  const c = await holdoutContext(prisma, input.unitId);
  const e = input.evaluation;
  if (e.phase !== "HOLDOUT") throw new CampaignError("WRONG_PHASE", `expected a HOLDOUT evaluation, got ${e.phase}`);
  if (e.walkForwardHash !== c.walkForwardHash) throw new CampaignError("WALK_FORWARD_MISMATCH", "the holdout evaluation was computed for a different walk-forward result");
  try {
    await campaignTx(prisma, async (tx) => {
      const intent = await tx.researchHoldoutLedger.findFirst({ where: { unitId: c.unitId, kind: "CONSUME_INTENT" } });
      if (!intent) throw new CampaignError("NO_INTENT", `unit ${c.unitId} has no committed consume intent; a holdout result cannot be recorded`);
      await tx.researchHoldoutLedger.create({ data: { kind: "RESULT_RECORDED", unitId: c.unitId, lineageKey: c.lineageKey, instrumentKey: c.instrumentKey, barMs: c.barMs, periodStart: c.periodStart, periodEnd: c.periodEnd, datasetHash: c.datasetHash, subjectHash: c.subjectHash, actor: input.actor, resultHash: e.resultHash } });
      await insertHoldoutResult(tx, c.unitId, e, input.metrics);
      await logEvent(tx, { runId: c.runId, unitId: c.unitId, kind: "HOLDOUT_RESULT_RECORDED", actor: input.actor, detail: { verdict: e.verdict, reasons: e.reasons.slice(0, 5), resultHash: e.resultHash } });
    });
    return "RECORDED";
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return "ALREADY_CLOSED";
    throw error;
  }
}
