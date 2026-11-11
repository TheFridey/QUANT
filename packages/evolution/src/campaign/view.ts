import type { PrismaClient } from "@odin/shared/db";
import { modelStates } from "../genesis/model-registry.js";
import { programmeTrials } from "./accounting.js";
import { campaignModelIdentity, modelProspectiveEvidence, shadowBlocker } from "./bridge.js";
import { normaliseInstrument } from "./spec.js";
import { evidenceStage, type ProspectiveEvidence, type StageView } from "./stages.js";
import { specOf } from "./store.js";

/**
 * OPERATION EVIDENCE read models (read only). Every query is bounded by VIEW_BOUNDS; nothing here writes.
 * Research tables are global (not per paper account), like the model registry and the warehouse.
 */
export const VIEW_BOUNDS = { campaigns: 50, runs: 20, units: 400, events: 100, trials: 500, instrumentResults: 300, datasets: 2_000 } as const;

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export async function listCampaigns(prisma: PrismaClient) {
  const campaigns = await prisma.researchCampaign.findMany({ orderBy: { createdAt: "desc" }, take: VIEW_BOUNDS.campaigns, include: { runs: { orderBy: { runNumber: "desc" }, take: 1, include: { state: true } } } });
  const latestRunIds = campaigns.map((c) => c.runs[0]?.id).filter((id): id is string => Boolean(id));
  const counts = latestRunIds.length ? await prisma.researchCampaignUnit.groupBy({ by: ["runId", "state"], where: { runId: { in: latestRunIds } }, _count: true }) : [];
  return {
    bounds: VIEW_BOUNDS,
    programmeTrials: await programmeTrials(prisma),
    campaigns: campaigns.map((c) => {
      const run = c.runs[0] ?? null;
      const { spec } = specOf(c);
      return {
        id: c.id,
        name: c.name,
        synthetic: c.synthetic,
        specHash: c.specHash,
        createdAt: c.createdAt.toISOString(),
        createdBy: c.createdBy,
        datasets: spec.datasets.map((d) => ({ key: d.key, market: d.market, instrument: d.instrument, interval: d.interval, source: d.source.kind, asOf: d.asOf })),
        hypotheses: spec.hypotheses.length,
        latestRun: run && { id: run.id, runNumber: run.runNumber, state: run.state?.state ?? "UNKNOWN", codeVersion: run.codeVersion, units: Object.fromEntries(counts.filter((x) => x.runId === run.id).map((x) => [x.state, x._count])) },
      };
    }),
  };
}

export type UnitView = {
  id: string;
  seq: number;
  datasetKey: string;
  hypothesisKind: string;
  hypothesisId: string;
  state: string;
  attempts: number;
  lastError: string | null;
  plannedTrials: number;
  trials: { reserved: number | null; settled: number | null; priorTrials: number | null };
  walkForward: null | { phase: string; verdict: string; reasons: string[]; walkForwardPassed: boolean; holdoutStatus: string; trialCount: number; resultHash: string; runtimeMs: number; peakRssMb: number; summary: unknown; dataset: unknown; provenance: unknown };
  holdout: null | { verdict: string; reasons: string[]; holdoutStatus: string; resultHash: string; summary: unknown; createdAt: string };
  holdoutLedger: Array<{ kind: string; actor: string; createdAt: string; expiresAt: string | null; note: string | null }>;
  model: null | { id: string; family: string; version: string; state: string; stateReason: string | null; artefactHash: string };
  prospective: ProspectiveEvidence | null;
  stage: StageView;
};

/** One run with every unit, its results, ledgers, model and evidence stage. */
export async function runDetail(prisma: PrismaClient, runId: string, now: Date = new Date()) {
  const run = await prisma.researchCampaignRun.findUnique({ where: { id: runId }, include: { campaign: true, state: true } });
  if (!run) return null;
  const { spec, units: plan } = specOf(run.campaign);
  const units = await prisma.researchCampaignUnit.findMany({
    where: { runId },
    orderBy: { seq: "asc" },
    take: VIEW_BOUNDS.units,
    include: { results: { select: { phase: true, verdict: true, reasons: true, walkForwardPassed: true, holdoutStatus: true, trialCount: true, priorTrials: true, resultHash: true, runtimeMs: true, peakRssMb: true, summary: true, dataset: true, provenance: true, createdAt: true } } },
  });
  const ids = units.map((u) => u.id);
  const [trialRows, holdoutRows, events, otherRuns] = await Promise.all([
    prisma.researchTrialLedger.findMany({ where: { unitId: { in: ids } } }),
    prisma.researchHoldoutLedger.findMany({ where: { unitId: { in: ids } }, orderBy: { createdAt: "asc" } }),
    prisma.researchCampaignEvent.findMany({ where: { runId }, orderBy: { createdAt: "desc" }, take: VIEW_BOUNDS.events }),
    prisma.researchCampaignRun.findMany({ where: { campaignId: run.campaignId }, orderBy: { runNumber: "desc" }, take: VIEW_BOUNDS.runs, include: { state: true } }),
  ]);
  // Models registered from these units, found by their deterministic identity.
  const identities = units.flatMap((u) => {
    const h = u.results.find((r) => r.phase === "HOLDOUT");
    return h && h.verdict === "CANDIDATE" ? [{ unitId: u.id, ...campaignModelIdentity(h.resultHash, run.campaign.synthetic) }] : [];
  });
  const models = identities.length ? await prisma.modelVersion.findMany({ where: { OR: identities.map((i) => ({ family: i.family, version: i.version })) } }) : [];
  const states = models.length ? await modelStates(prisma, models.map((m) => m.id)) : new Map<string, { state: string; seq: number }>();
  const unitViews: UnitView[] = [];
  for (const u of units) {
    const wf = u.results.find((r) => r.phase !== "HOLDOUT") ?? null;
    const holdout = u.results.find((r) => r.phase === "HOLDOUT") ?? null;
    const ledger = holdoutRows.filter((r) => r.unitId === u.id);
    const identity = identities.find((i) => i.unitId === u.id);
    const modelRow = identity ? models.find((m) => m.family === identity.family && m.version === identity.version) ?? null : null;
    const head = modelRow ? states.get(modelRow.id) : undefined;
    const lastEvent = modelRow && head ? await prisma.modelLifecycleEvent.findUnique({ where: { modelVersionId_seq: { modelVersionId: modelRow.id, seq: head.seq } }, select: { reason: true } }) : null;
    const prospective = modelRow ? await modelProspectiveEvidence(prisma, modelRow, now) : null;
    const planned = plan.find((p) => p.seq === u.seq);
    const wfDataset = obj(wf?.dataset);
    const wfProvenance = obj(wf?.provenance);
    const blocker = shadowBlocker({ hypothesisKind: u.hypothesisKind, calendar: typeof wfDataset.calendar === "string" ? wfDataset.calendar : null, featureSetHash: typeof wfProvenance.featureSetHash === "string" ? wfProvenance.featureSetHash : null, barMs: typeof wfDataset.barMs === "number" ? wfDataset.barMs : null });
    const authorised = ledger.some((l) => l.kind === "AUTHORIZED" && l.expiresAt !== null && l.expiresAt.getTime() > now.getTime());
    const model = modelRow ? { id: modelRow.id, family: modelRow.family, version: modelRow.version, state: head?.state ?? "UNKNOWN", stateReason: lastEvent?.reason ?? null, artefactHash: modelRow.artefactHash } : null;
    unitViews.push({
      id: u.id,
      seq: u.seq,
      datasetKey: u.datasetKey,
      hypothesisKind: u.hypothesisKind,
      hypothesisId: u.hypothesisId,
      state: u.state,
      attempts: u.attempts,
      lastError: u.lastError,
      plannedTrials: planned?.plannedTrials ?? u.plannedTrials,
      trials: { reserved: trialRows.find((t) => t.unitId === u.id && t.kind === "RESERVED")?.trials ?? null, settled: trialRows.find((t) => t.unitId === u.id && t.kind === "SETTLED")?.trials ?? null, priorTrials: trialRows.find((t) => t.unitId === u.id && t.kind === "RESERVED")?.priorTrials ?? null },
      walkForward: wf && { phase: wf.phase, verdict: wf.verdict, reasons: wf.reasons, walkForwardPassed: wf.walkForwardPassed, holdoutStatus: wf.holdoutStatus, trialCount: wf.trialCount, resultHash: wf.resultHash, runtimeMs: wf.runtimeMs, peakRssMb: wf.peakRssMb, summary: wf.summary, dataset: wf.dataset, provenance: wf.provenance },
      holdout: holdout && { verdict: holdout.verdict, reasons: holdout.reasons, holdoutStatus: holdout.holdoutStatus, resultHash: holdout.resultHash, summary: holdout.summary, createdAt: holdout.createdAt.toISOString() },
      holdoutLedger: ledger.map((l) => ({ kind: l.kind, actor: l.actor, createdAt: l.createdAt.toISOString(), expiresAt: l.expiresAt?.toISOString() ?? null, note: l.note })),
      model,
      prospective,
      stage: evidenceStage({ hypothesisKind: u.hypothesisKind as "STRATEGY" | "ML2", unitState: u.state, lastError: u.lastError, walkForward: wf, holdout, holdoutAuthorised: authorised, holdoutIntentOpen: ledger.some((l) => l.kind === "CONSUME_INTENT") && !holdout, model, prospective, shadowBlocker: blocker }),
    });
  }
  return {
    bounds: VIEW_BOUNDS,
    generatedAt: now.toISOString(),
    campaign: { id: run.campaign.id, name: run.campaign.name, synthetic: run.campaign.synthetic, specHash: run.campaign.specHash, createdBy: run.campaign.createdBy, createdAt: run.campaign.createdAt.toISOString(), spec },
    run: { id: run.id, runNumber: run.runNumber, reason: run.reason, requestedBy: run.requestedBy, codeVersion: run.codeVersion, versions: run.versions, createdAt: run.createdAt.toISOString(), state: run.state?.state ?? "UNKNOWN", cancelRequestedAt: run.state?.cancelRequestedAt?.toISOString() ?? null, startedAt: run.state?.startedAt?.toISOString() ?? null, finishedAt: run.state?.finishedAt?.toISOString() ?? null },
    runs: otherRuns.map((r) => ({ id: r.id, runNumber: r.runNumber, reason: r.reason, state: r.state?.state ?? "UNKNOWN", createdAt: r.createdAt.toISOString() })),
    progress: { total: units.length, byState: Object.fromEntries([...new Set(units.map((u) => u.state))].map((s) => [s, units.filter((u) => u.state === s).length])) },
    units: unitViews,
    events: events.map((e) => ({ kind: e.kind, unitId: e.unitId, actor: e.actor, detail: e.detail, createdAt: e.createdAt.toISOString() })),
    programmeTrials: await programmeTrials(prisma),
  };
}

/** Every trial of one unit result (bounded), for drill-down. */
export async function unitTrials(prisma: PrismaClient, unitId: string) {
  const results = await prisma.researchCampaignResult.findMany({ where: { unitId }, select: { phase: true, detailCanonical: true, resultHash: true } });
  if (!results.length) return null;
  return results.map((r) => {
    const detail = obj(JSON.parse(r.detailCanonical));
    const trials = (obj(detail.strategy).trials ?? obj(detail.ml).trials ?? []) as unknown[];
    return { phase: r.phase, resultHash: r.resultHash, totalTrials: trials.length, trials: trials.slice(0, VIEW_BOUNDS.trials), truncated: trials.length > VIEW_BOUNDS.trials };
  });
}

export type InstrumentResearch = {
  instrumentKey: string;
  /** Historical bars held in the research warehouse (research-data readiness; unrelated to live quotes or execution). */
  history: Array<{ datasetId: string; sourceId: string; interval: string; bars: number; firstOpen: string | null; lastOpen: string | null }>;
  /** Campaign results on real (non-synthetic) data. Empty means no campaign has run: unknown, not zero. */
  results: Array<{ campaignId: string; campaignName: string; runId: string; unitId: string; hypothesisId: string; interval: string; stage: string | null; status: string; verdict: string; why: string; createdAt: string }>;
  summary: { hypothesesTested: number; rejected: number; pendingHoldout: number; holdoutPassed: number; underObservation: number; latestAt: string | null };
};

/**
 * Research evidence per instrument for the Market Scanner: warehouse history and campaign outcomes, keyed by
 * normalised instrument. Synthetic campaigns are excluded: a constructed series says nothing about a market.
 */
export async function instrumentResearch(prisma: PrismaClient, instruments: Array<{ id: string; aliases: string[] }>, now: Date = new Date()): Promise<Map<string, InstrumentResearch>> {
  const keyToId = new Map<string, string>();
  for (const i of instruments) for (const alias of i.aliases) {
    try {
      keyToId.set(normaliseInstrument(alias), i.id);
    } catch {
      // An alias with no letters or digits identifies nothing.
    }
  }
  const out = new Map<string, InstrumentResearch>(instruments.map((i) => [i.id, { instrumentKey: i.id, history: [], results: [], summary: { hypothesesTested: 0, rejected: 0, pendingHoldout: 0, holdoutPassed: 0, underObservation: 0, latestAt: null } }]));
  const datasets = await prisma.historicalDataset.findMany({ select: { id: true, sourceId: true, instrumentKey: true, interval: true, barCount: true, firstOpenTime: true, lastOpenTime: true }, orderBy: { updatedAt: "desc" }, take: VIEW_BOUNDS.datasets });
  for (const d of datasets) {
    let key: string;
    try {
      key = normaliseInstrument(d.instrumentKey);
    } catch {
      continue;
    }
    const id = keyToId.get(key);
    if (id) out.get(id)!.history.push({ datasetId: d.id, sourceId: d.sourceId, interval: d.interval, bars: d.barCount, firstOpen: d.firstOpenTime?.toISOString() ?? null, lastOpen: d.lastOpenTime?.toISOString() ?? null });
  }
  const results = await prisma.researchCampaignResult.findMany({
    where: { unit: { run: { campaign: { synthetic: false } } } },
    orderBy: { createdAt: "desc" },
    take: VIEW_BOUNDS.instrumentResults,
    select: { phase: true, verdict: true, reasons: true, walkForwardPassed: true, holdoutStatus: true, dataset: true, createdAt: true, unit: { select: { id: true, hypothesisId: true, hypothesisKind: true, state: true, lastError: true, runId: true, run: { select: { campaign: { select: { id: true, name: true } } } } } } },
  });
  const byUnit = new Map<string, typeof results>();
  for (const r of results) byUnit.set(r.unit.id, [...(byUnit.get(r.unit.id) ?? []), r]);
  for (const [unitId, rows] of byUnit) {
    const wf = rows.find((r) => r.phase !== "HOLDOUT") ?? null;
    const holdout = rows.find((r) => r.phase === "HOLDOUT") ?? null;
    const dataset = obj((wf ?? holdout)!.dataset);
    const id = typeof dataset.instrumentKey === "string" ? keyToId.get(dataset.instrumentKey) : undefined;
    if (!id || !wf) continue;
    const unit = rows[0]!.unit;
    // The scanner shows the research stage only; a model under observation is reported by the shadow evidence column.
    const stage = evidenceStage({ hypothesisKind: unit.hypothesisKind as "STRATEGY" | "ML2", unitState: unit.state, lastError: unit.lastError, walkForward: wf, holdout, holdoutAuthorised: false, model: null, prospective: null, shadowBlocker: null });
    const entry = out.get(id)!;
    entry.results.push({ campaignId: unit.run.campaign.id, campaignName: unit.run.campaign.name, runId: unit.runId, unitId, hypothesisId: unit.hypothesisId, interval: String(dataset.interval ?? ""), stage: stage.stage, status: stage.status, verdict: (holdout ?? wf).verdict, why: stage.why, createdAt: (holdout ?? wf).createdAt.toISOString() });
    entry.summary.hypothesesTested += 1;
    if (stage.stage === "HISTORICAL_RESULT" || stage.status === "HOLDOUT_FAILED" || stage.status === "RESULT_LOST") entry.summary.rejected += 1;
    if (stage.stage === "PENDING_HOLDOUT") entry.summary.pendingHoldout += 1;
    if (stage.status === "HOLDOUT_PASSED_RESEARCH_ONLY") entry.summary.holdoutPassed += 1;
    const at = (holdout ?? wf).createdAt.toISOString();
    if (!entry.summary.latestAt || at > entry.summary.latestAt) entry.summary.latestAt = at;
  }
  void now;
  return out;
}
