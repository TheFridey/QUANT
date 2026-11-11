import { defaultFeatureSetSpec, featureSetSpecHash, type LabelSpec } from "@odin/backtest/ml2";
import type { PrismaClient } from "@odin/shared/db";
import { isOperatorActor } from "../genesis/model-lifecycle.js";
import { currentModelState, registerModel, transitionModel, type ModelVersionRow } from "../genesis/model-registry.js";
import { verifyStoredPrediction } from "../genesis/shadow.js";
import { prospectiveEvidence, TARGET_EFFECTIVE_SIGNALS_BOUNDS, type ProspectiveEvidence, type ProspectiveRow } from "./stages.js";
import { CampaignError, logEvent } from "./store.js";

/**
 * OPERATION EVIDENCE bridge from a frozen research result to GENESIS shadow observation. It adds no scoring
 * code: it registers the artefact that passed its holdout in the existing immutable model registry, and an
 * operator moves it to SHADOW_CANDIDATE through the existing lifecycle. The existing shadow service (off unless
 * GENESIS_SHADOW_ENABLED=true) then scores it. Nothing here creates orders, intents or strategy instances.
 */

export const CAMPAIGN_MODEL_FAMILY = "campaign-ml2";
export const SYNTHETIC_MODEL_FAMILY = "campaign-ml2-synthetic";
/**
 * A frozen artefact was fitted before its holdout, so it is already as old as the holdout when observation
 * starts, and the shadow service abstains on a model older than its staleness limit (30 days unless the model
 * declares otherwise). Refitting would produce a model the holdout never tested. So the registrant must state
 * the limit explicitly; it is stored in the immutable model row. Upper bound below.
 */
export const MAX_STALENESS_DAYS = 730;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The model identity a unit's holdout result maps to (deterministic, so lookups need no extra table). */
export function campaignModelIdentity(holdoutResultHash: string, synthetic: boolean): { family: string; version: string } {
  return { family: synthetic ? SYNTHETIC_MODEL_FAMILY : CAMPAIGN_MODEL_FAMILY, version: holdoutResultHash.slice(0, 24) };
}

/**
 * Why a frozen result cannot be observed by the shadow service, or null when it can. The shadow service scores
 * ML 2.0 artefacts on the default feature set of a 24/7 calendar only; anything else would be scored on
 * features that differ from the ones it was trained on.
 */
export function shadowBlocker(input: { hypothesisKind: string; calendar: string | null; featureSetHash: string | null; barMs: number | null }): string | null {
  if (input.hypothesisKind !== "ML2") return "the shadow service scores ML 2.0 artefacts only; rule-based strategies have no prospective scorer yet";
  if (input.calendar !== "CRYPTO_24_7") return `the shadow service builds features on a 24/7 grid; this model was trained on the ${input.calendar ?? "unknown"} calendar, so its features would differ`;
  if (!input.barMs || input.featureSetHash !== featureSetSpecHash(defaultFeatureSetSpec(input.barMs))) return "the model was not trained on the default feature set the shadow service computes (for example, a source without traded volume)";
  return null;
}

/**
 * Registers the frozen champion of a unit whose holdout passed. Idempotent: the same result always maps to
 * the same model version. The model starts EXPERIMENTAL and is not observed until an operator says so.
 */
export async function registerCampaignModel(prisma: PrismaClient, input: { unitId: string; registeredBy: string; instrumentKeys: string[]; maxStalenessDays: number; targetEffectiveSignals: number }): Promise<{ status: "REGISTERED" | "ALREADY_REGISTERED"; model: ModelVersionRow }> {
  if (!(Number.isInteger(input.targetEffectiveSignals) && input.targetEffectiveSignals >= TARGET_EFFECTIVE_SIGNALS_BOUNDS.min && input.targetEffectiveSignals <= TARGET_EFFECTIVE_SIGNALS_BOUNDS.max)) throw new CampaignError("OBSERVATION_LENGTH_REQUIRED", `declare, before observation starts, how many independent signals the evidence will be judged on (${TARGET_EFFECTIVE_SIGNALS_BOUNDS.min} to ${TARGET_EFFECTIVE_SIGNALS_BOUNDS.max}); there is no default`);
  if (!(Number.isFinite(input.maxStalenessDays) && input.maxStalenessDays >= 1 && input.maxStalenessDays <= MAX_STALENESS_DAYS)) throw new CampaignError("STALENESS_REQUIRED", `state how old the frozen model may be while it is observed (1 to ${MAX_STALENESS_DAYS} days); there is no default`);
  const unit = await prisma.researchCampaignUnit.findUnique({ where: { id: input.unitId }, include: { run: { include: { campaign: true } }, results: true } });
  if (!unit) throw new CampaignError("NOT_FOUND", `unit ${input.unitId}`);
  const holdout = unit.results.find((r) => r.phase === "HOLDOUT");
  const wf = unit.results.find((r) => r.phase === "WALK_FORWARD");
  if (!holdout || !wf) throw new CampaignError("NOT_ELIGIBLE", `unit ${unit.id} has no evaluated holdout; only a result that passed its holdout can be observed prospectively`);
  if (holdout.holdoutStatus !== "EVALUATED" || holdout.verdict !== "CANDIDATE") throw new CampaignError("NOT_ELIGIBLE", `unit ${unit.id}: holdout verdict is ${holdout.verdict} (${holdout.reasons.at(-1) ?? "no reason"}); eligibility is not relaxed for a failed or lost holdout`);
  const model = obj(obj(JSON.parse(holdout.detailCanonical)).model);
  const dataset = obj(holdout.dataset);
  const barMs = typeof dataset.barMs === "number" ? dataset.barMs : null;
  const blocker = shadowBlocker({ hypothesisKind: unit.hypothesisKind, calendar: typeof model.calendar === "string" ? model.calendar : null, featureSetHash: typeof model.featureSetHash === "string" ? model.featureSetHash : null, barMs });
  if (blocker) throw new CampaignError("SHADOW_UNSUPPORTED", blocker);
  if (!model.artefact || !model.labelSpec || barMs === null || typeof dataset.contentHash !== "string") throw new CampaignError("NOT_ELIGIBLE", `unit ${unit.id}: the holdout result carries no frozen artefact`);
  const synthetic = unit.run.campaign.synthetic;
  const keys = input.instrumentKeys.map((k) => k.trim()).filter(Boolean);
  if (!keys.length) throw new CampaignError("INSTRUMENT_REQUIRED", "name the warehouse instrument key(s) the model is to be observed on");
  // A model fitted on a constructed series must never be pointed at a real instrument.
  if (synthetic && keys.some((k) => !/^SYNTHETIC:SYN[A-Z0-9-]{1,40}$/.test(k))) throw new CampaignError("SYNTHETIC_ONLY", "a synthetic campaign's model may only be observed on SYNTHETIC:SYN… instrument keys");
  if (!synthetic && keys.some((k) => /^SYNTHETIC:/i.test(k))) throw new CampaignError("SYNTHETIC_ONLY", "SYNTHETIC: instrument keys are reserved for synthetic campaigns");
  const identity = campaignModelIdentity(holdout.resultHash, synthetic);
  const summary = obj(holdout.summary);
  const registered = await registerModel(prisma, {
    ...identity,
    artefact: model.artefact,
    datasetHashes: [dataset.contentHash],
    labelDefinition: model.labelSpec as LabelSpec,
    hyperparameters: { learnerFamily: String(model.family ?? "unknown"), searchSpaceHash: String(obj(holdout.provenance).searchSpaceHash ?? "") },
    trainingProtocol: { protocol: String(obj(obj(holdout.provenance).versions).ml2Protocol ?? ""), target: "NET_POSITIVE", shadow: { barMs, instrumentKeys: keys, maxStalenessMs: Math.round(input.maxStalenessDays * 86_400_000) }, campaign: { campaignId: unit.run.campaignId, specHash: unit.run.campaign.specHash, runId: unit.runId, runNumber: unit.run.runNumber, unitId: unit.id, synthetic, targetEffectiveSignals: input.targetEffectiveSignals } },
    validation: { verdict: "CANDIDATE", walkForwardBrier: typeof summary.walkForwardBrier === "number" ? summary.walkForwardBrier : null, walkForwardResultHash: wf.resultHash, holdoutResultHash: holdout.resultHash, programmeTrials: holdout.priorTrials + holdout.trialCount, synthetic },
    evidenceLinks: [`campaign:${unit.run.campaignId}/run:${unit.run.runNumber}/unit:${unit.seq}`],
    codeCommit: unit.run.codeVersion,
    registeredBy: input.registeredBy,
  });
  if (registered.status === "REGISTERED") await logEvent(prisma, { runId: unit.runId, unitId: unit.id, kind: "MODEL_REGISTERED", actor: input.registeredBy, detail: { modelVersionId: registered.model.id, ...identity, artefactHash: registered.model.artefactHash, instrumentKeys: keys } });
  return registered;
}

/**
 * Operator-controlled start of prospective observation: EXPERIMENTAL -> HISTORICALLY_ELIGIBLE -> SHADOW_CANDIDATE.
 * Requires an operator actor (stricter than the registry, which lets any actor write these two labels).
 */
export async function startProspectiveObservation(prisma: PrismaClient, input: { modelVersionId: string; operator: string; reason: string }): Promise<{ state: string }> {
  const actor = `operator:${input.operator.trim()}`;
  if (!isOperatorActor(actor) || !/^[A-Za-z0-9_.@-]{1,120}$/.test(input.operator.trim())) throw new CampaignError("OPERATOR_REQUIRED", "prospective observation is started by an operator");
  if (!input.reason.trim()) throw new CampaignError("REASON_REQUIRED", "say why this model is to be observed");
  const model = await prisma.modelVersion.findUnique({ where: { id: input.modelVersionId }, select: { family: true } });
  if (!model) throw new CampaignError("NOT_FOUND", `model ${input.modelVersionId}`);
  if (model.family !== CAMPAIGN_MODEL_FAMILY && model.family !== SYNTHETIC_MODEL_FAMILY) throw new CampaignError("NOT_A_CAMPAIGN_MODEL", "this command only moves models registered from a campaign result");
  let head = await currentModelState(prisma, input.modelVersionId);
  if (head.state === "EXPERIMENTAL") {
    await transitionModel(prisma, { modelVersionId: input.modelVersionId, to: "HISTORICALLY_ELIGIBLE", actor, reason: `campaign holdout passed: ${input.reason.trim()}`, expectedFrom: "EXPERIMENTAL" });
    head = await currentModelState(prisma, input.modelVersionId);
  }
  if (head.state === "HISTORICALLY_ELIGIBLE") {
    await transitionModel(prisma, { modelVersionId: input.modelVersionId, to: "SHADOW_CANDIDATE", actor, reason: input.reason.trim(), expectedFrom: "HISTORICALLY_ELIGIBLE" });
    head = await currentModelState(prisma, input.modelVersionId);
  }
  if (head.state !== "SHADOW_CANDIDATE" && head.state !== "SHADOW_VALIDATED") throw new CampaignError("ILLEGAL_STATE", `model is ${head.state}; it cannot be put under observation`);
  return { state: head.state };
}

export const PROSPECTIVE_ROW_LIMIT = 5_000;

/** Prospective evidence of one registered model from its stored shadow rows (newest rows, bounded). */
export async function modelProspectiveEvidence(prisma: PrismaClient, model: Pick<ModelVersionRow, "id" | "validation" | "trainingProtocol" | "artefact" | "labelDefinition">, now: Date = new Date()): Promise<ProspectiveEvidence> {
  // The EARLIEST rows of the cohort, in order: the judged sample is a fixed prefix, so later rows must not push it out.
  const rows = await prisma.shadowPrediction.findMany({ where: { modelVersionId: model.id }, include: { outcome: true }, orderBy: { decisionTime: "asc" }, take: PROSPECTIVE_ROW_LIMIT });
  const shadow = obj(obj(model.trainingProtocol).shadow);
  const validation = obj(model.validation);
  let featureNames: string[] = [];
  try {
    const parsed = JSON.parse(model.artefact) as { features?: unknown };
    if (Array.isArray(parsed.features)) featureNames = parsed.features.filter((f): f is string => typeof f === "string");
  } catch {
    // Integrity is judged when the model is loaded; without names drift is simply not assessed.
  }
  const mapped: ProspectiveRow[] = rows.map((r) => {
    const verified = verifyStoredPrediction(r);
    return {
      decisionTime: r.decisionTime.getTime(),
      horizonEndsAt: r.horizonEndsAt.getTime(),
      status: r.status as "PREDICTED" | "ABSTAINED",
      probability: verified ? verified.probability : r.probability,
      abstainReasons: r.abstainReasons,
      hashOk: verified !== null,
      outcome: r.outcome && { available: r.outcome.hypotheticalFillAvailable, net: r.outcome.realisedNetReturn, positive: r.outcome.positive },
      costBpsApplied: r.outcome?.costBpsApplied ?? null,
      estimatedCostBps: r.estimatedCostBps,
      features: r.features as Record<string, number | null> | null,
    };
  });
  return prospectiveEvidence({
    rows: mapped,
    entryThreshold: typeof shadow.entryThreshold === "number" ? shadow.entryThreshold : 0.55,
    horizonBars: rows[0]?.horizonBars ?? Number(obj(model.labelDefinition).horizon ?? 1),
    barMs: rows[0]?.barMs ?? Number(shadow.barMs ?? 0),
    referenceBrier: typeof validation.walkForwardBrier === "number" ? validation.walkForwardBrier : null,
    featureNames,
    now: now.getTime(),
    targetEffectiveSignals: Number(obj(obj(model.trainingProtocol).campaign).targetEffectiveSignals ?? TARGET_EFFECTIVE_SIGNALS_BOUNDS.max),
  });
}
