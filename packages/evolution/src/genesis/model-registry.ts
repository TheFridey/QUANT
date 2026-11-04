import { labelSpecHash, type LabelSpec, type Ml2Artefact } from "@odin/backtest/ml2";
import { Prisma, toJson, type PrismaClient } from "@odin/shared/db";
import { canonicalHash, canonicalJson, HEX64 } from "./canonical.js";
import { parseMl2Artefact } from "./model-artefact.js";
import { checkModelTransition, isModelState, type ModelState } from "./model-lifecycle.js";

/**
 * GENESIS Phase 5 model registry. Writes only ModelVersion, ModelLifecycleEvent and ModelPaperApproval.
 * Never writes EngineControl, risk configuration, strategy instances, promotions or execution permissions,
 * and never creates orders. Lifecycle states are evidence labels only (see model-lifecycle.ts).
 */
export type Db = PrismaClient | Prisma.TransactionClient;

export class ModelRegistryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "ModelRegistryError";
  }
}

const MAX_ARTEFACT_BYTES = 4 * 1024 * 1024;

export type RegisterModelInput = {
  family: string;
  version: string;
  /** Untrusted JSON; parsed against the strict data-only schema. */
  artefact: unknown;
  /** Hash the caller computed; must equal the registry's own canonical hash of `artefact` when given. */
  artefactHash?: string;
  datasetHashes: string[];
  labelDefinition: LabelSpec;
  hyperparameters: Record<string, unknown>;
  trainingProtocol: Record<string, unknown>;
  validation: Record<string, unknown>;
  evidenceLinks?: string[];
  codeCommit: string;
  hypothesisId?: string | null;
  registeredBy: string;
};

export type ModelVersionRow = Prisma.ModelVersionGetPayload<object>;

/** Canonical SHA-256 of an artefact (key-sorted JSON). Not `ml2ArtefactHash`, which hashes insertion order. */
export function modelArtefactHash(artefact: Ml2Artefact | unknown): string {
  return canonicalHash(artefact);
}

/** Validates and normalises a registration without touching the database. */
export function prepareModelRegistration(input: RegisterModelInput) {
  const artefact = parseMl2Artefact(input.artefact);
  const artefactJson = canonicalJson(artefact);
  if (Buffer.byteLength(artefactJson) > MAX_ARTEFACT_BYTES) throw new ModelRegistryError("ARTEFACT_TOO_LARGE", `artefact is ${Buffer.byteLength(artefactJson)} bytes (max ${MAX_ARTEFACT_BYTES})`);
  const artefactHash = canonicalHash(artefact);
  if (input.artefactHash !== undefined && input.artefactHash !== artefactHash) {
    throw new ModelRegistryError("HASH_MISMATCH", `claimed artefact hash ${input.artefactHash} differs from computed ${artefactHash}`);
  }
  if (!input.datasetHashes.length || input.datasetHashes.some((h) => !HEX64.test(h))) throw new ModelRegistryError("BAD_DATASET_HASHES", "datasetHashes must be one or more sha256 hex strings");
  if (!/^[a-f0-9]{7,40}$/.test(input.codeCommit)) throw new ModelRegistryError("BAD_CODE_COMMIT", "codeCommit must be a git commit hash");
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(input.family) || !/^[A-Za-z0-9_.:+-]{1,64}$/.test(input.version)) throw new ModelRegistryError("BAD_IDENTITY", "family/version have invalid characters");
  if (!input.registeredBy.trim()) throw new ModelRegistryError("ACTOR_REQUIRED", "registeredBy is required");
  const labelDefinition = { ...input.labelDefinition, stopPct: input.labelDefinition.stopPct ?? null, targetPct: input.labelDefinition.targetPct ?? null };
  // Every JSON field must survive canonical JSON exactly (no NaN, Infinity, undefined or class instances).
  for (const [name, value] of Object.entries({ labelDefinition, hyperparameters: input.hyperparameters, trainingProtocol: input.trainingProtocol, validation: input.validation })) {
    try {
      canonicalJson(value);
    } catch (error) {
      throw new ModelRegistryError("BAD_JSON", `${name}: ${(error as Error).message}`);
    }
  }
  return {
    artefact,
    data: {
      family: input.family,
      version: input.version,
      protocol: artefact.protocol,
      trainingCutoff: new Date(artefact.trainedThroughTime),
      registeredBy: input.registeredBy,
      datasetHashes: [...input.datasetHashes],
      featureSetHash: artefact.featureSetHash,
      labelSpecHash: labelSpecHash(labelDefinition),
      codeCommit: input.codeCommit,
      hyperparameters: input.hyperparameters,
      labelDefinition,
      trainingProtocol: input.trainingProtocol,
      validation: input.validation,
      evidenceLinks: [...(input.evidenceLinks ?? [])],
      artefact,
      artefactHash,
      hypothesisId: input.hypothesisId ?? null,
    },
  };
}

type Prepared = ReturnType<typeof prepareModelRegistration>["data"];

/** Fields that define a model version; a re-registration must match every one of them. */
function registrationFingerprint(row: Pick<Prepared, "artefactHash" | "datasetHashes" | "labelSpecHash" | "codeCommit" | "hyperparameters" | "labelDefinition" | "trainingProtocol" | "validation" | "evidenceLinks" | "hypothesisId" | "protocol" | "featureSetHash">): string {
  return canonicalHash({
    artefactHash: row.artefactHash,
    datasetHashes: row.datasetHashes,
    labelSpecHash: row.labelSpecHash,
    codeCommit: row.codeCommit,
    hyperparameters: row.hyperparameters,
    labelDefinition: row.labelDefinition,
    trainingProtocol: row.trainingProtocol,
    validation: row.validation,
    evidenceLinks: row.evidenceLinks,
    hypothesisId: row.hypothesisId,
    protocol: row.protocol,
    featureSetHash: row.featureSetHash,
  });
}

function fingerprintOfRow(row: ModelVersionRow): string {
  return registrationFingerprint({
    artefactHash: row.artefactHash,
    datasetHashes: row.datasetHashes,
    labelSpecHash: row.labelSpecHash,
    codeCommit: row.codeCommit,
    hyperparameters: row.hyperparameters as Record<string, unknown>,
    labelDefinition: row.labelDefinition as Prepared["labelDefinition"],
    trainingProtocol: row.trainingProtocol as Record<string, unknown>,
    validation: row.validation as Record<string, unknown>,
    evidenceLinks: row.evidenceLinks,
    hypothesisId: row.hypothesisId,
    protocol: row.protocol,
    featureSetHash: row.featureSetHash,
  });
}

export type RegisterModelResult = { status: "REGISTERED" | "ALREADY_REGISTERED"; model: ModelVersionRow };

/**
 * Registers a model version and its EXPERIMENTAL lifecycle event in one transaction. Registering the same
 * (family, version) again with identical content returns the existing row; with any different content it is
 * refused (`REGISTRATION_CONFLICT`).
 */
export async function registerModel(prisma: PrismaClient, input: RegisterModelInput): Promise<RegisterModelResult> {
  const { data } = prepareModelRegistration(input);
  const compareExisting = async (): Promise<RegisterModelResult | null> => {
    const existing = await prisma.modelVersion.findUnique({ where: { family_version: { family: data.family, version: data.version } } });
    if (!existing) return null;
    verifyStoredArtefact(existing);
    if (fingerprintOfRow(existing) !== registrationFingerprint(data)) {
      throw new ModelRegistryError("REGISTRATION_CONFLICT", `${data.family}@${data.version} is already registered with different content`);
    }
    return { status: "ALREADY_REGISTERED", model: existing };
  };
  const already = await compareExisting();
  if (already) return already;
  try {
    const model = await prisma.$transaction(async (tx) => {
      const row = await tx.modelVersion.create({
        data: {
          ...data,
          hyperparameters: toJson(data.hyperparameters),
          labelDefinition: toJson(data.labelDefinition),
          trainingProtocol: toJson(data.trainingProtocol),
          validation: toJson(data.validation),
          artefact: toJson(data.artefact),
        },
      });
      const evidence = { artefactHash: row.artefactHash, labelSpecHash: row.labelSpecHash, featureSetHash: row.featureSetHash, datasetHashes: row.datasetHashes, codeCommit: row.codeCommit };
      await tx.modelLifecycleEvent.create({
        data: { modelVersionId: row.id, seq: 0, fromState: null, toState: "EXPERIMENTAL", actor: input.registeredBy, reason: "registered", evidence: toJson(evidence), evidenceHash: canonicalHash(evidence) },
      });
      return row;
    });
    return { status: "REGISTERED", model };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await compareExisting();
      if (raced) return raced;
    }
    throw error;
  }
}

/** Throws unless the stored artefact re-hashes to its artefactHash and matches its identity columns. */
export function verifyStoredArtefact(row: Pick<ModelVersionRow, "id" | "artefact" | "artefactHash" | "featureSetHash" | "protocol" | "trainingCutoff" | "labelDefinition" | "labelSpecHash">): Ml2Artefact {
  const recomputed = canonicalHash(row.artefact);
  if (recomputed !== row.artefactHash) throw new ModelRegistryError("HASH_MISMATCH", `model ${row.id}: stored artefact hashes to ${recomputed}, row says ${row.artefactHash}`);
  const artefact = parseMl2Artefact(row.artefact);
  if (artefact.featureSetHash !== row.featureSetHash || artefact.protocol !== row.protocol || artefact.trainedThroughTime !== row.trainingCutoff.getTime()) {
    throw new ModelRegistryError("IDENTITY_MISMATCH", `model ${row.id}: artefact disagrees with its featureSetHash, protocol or training cutoff`);
  }
  if (labelSpecHash(row.labelDefinition as LabelSpec) !== row.labelSpecHash) throw new ModelRegistryError("IDENTITY_MISMATCH", `model ${row.id}: labelDefinition does not hash to labelSpecHash`);
  return artefact;
}

export type ModelLifecycleEventRow = Prisma.ModelLifecycleEventGetPayload<object>;

export type LoadedModel = { model: ModelVersionRow; artefact: Ml2Artefact; state: ModelState; seq: number; labelSpec: LabelSpec };

/** Loads a model, re-verifying its artefact hash and parsing (never evaluating) its parameters. */
export async function loadModel(db: Db, id: string): Promise<LoadedModel> {
  const model = await db.modelVersion.findUnique({ where: { id } });
  if (!model) throw new ModelRegistryError("NOT_FOUND", `model ${id} not found`);
  const artefact = verifyStoredArtefact(model);
  const head = await currentModelState(db, id);
  return { model, artefact, state: head.state, seq: head.seq, labelSpec: model.labelDefinition as LabelSpec };
}

export async function currentModelState(db: Db, modelVersionId: string): Promise<{ state: ModelState; seq: number }> {
  const head = await db.modelLifecycleEvent.findFirst({ where: { modelVersionId }, orderBy: { seq: "desc" } });
  if (!head || !isModelState(head.toState)) throw new ModelRegistryError("NO_LIFECYCLE", `model ${modelVersionId} has no lifecycle`);
  return { state: head.toState, seq: head.seq };
}

/** Current state of many models (latest seq of each). */
export async function modelStates(db: Db, ids?: string[]): Promise<Map<string, { state: ModelState; seq: number }>> {
  const rows = ids
    ? await db.$queryRaw<Array<{ modelVersionId: string; toState: string; seq: number }>>`
        SELECT DISTINCT ON ("modelVersionId") "modelVersionId", "toState", "seq"
        FROM "ModelLifecycleEvent" WHERE "modelVersionId" = ANY(${ids})
        ORDER BY "modelVersionId", "seq" DESC`
    : await db.$queryRaw<Array<{ modelVersionId: string; toState: string; seq: number }>>`
        SELECT DISTINCT ON ("modelVersionId") "modelVersionId", "toState", "seq"
        FROM "ModelLifecycleEvent"
        ORDER BY "modelVersionId", "seq" DESC`;
  const out = new Map<string, { state: ModelState; seq: number }>();
  for (const r of rows) if (isModelState(r.toState)) out.set(r.modelVersionId, { state: r.toState, seq: r.seq });
  return out;
}

export type TransitionInput = {
  modelVersionId: string;
  to: ModelState;
  actor: string;
  reason: string;
  evidence?: Record<string, unknown>;
  approvalId?: string | null;
  /** Refuse unless the model is currently in this state (compare-and-set). */
  expectedFrom?: ModelState;
  now?: Date;
};

/**
 * Appends one lifecycle event. Checks the transition table, actor and approval in app code; the database
 * re-checks the same rules and refuses a stale `seq` (a concurrent writer) via the unique index.
 */
export async function transitionModel(db: Db, input: TransitionInput): Promise<ModelLifecycleEventRow> {
  const model = await db.modelVersion.findUnique({ where: { id: input.modelVersionId }, select: { id: true, artefactHash: true } });
  if (!model) throw new ModelRegistryError("NOT_FOUND", `model ${input.modelVersionId} not found`);
  const head = await currentModelState(db, input.modelVersionId);
  if (input.expectedFrom && head.state !== input.expectedFrom) throw new ModelRegistryError("STATE_CHANGED", `model is ${head.state}, expected ${input.expectedFrom}`);
  const approval = input.approvalId ? await db.modelPaperApproval.findUnique({ where: { id: input.approvalId } }) : null;
  if (input.approvalId && !approval) throw new ModelRegistryError("APPROVAL_REQUIRED", `approval ${input.approvalId} not found`);
  const check = checkModelTransition({ modelVersionId: model.id, artefactHash: model.artefactHash, from: head.state, to: input.to, actor: input.actor, reason: input.reason, approval, now: input.now ?? new Date() });
  if (!check.ok) throw new ModelRegistryError(check.code, check.error);
  const evidence = input.evidence ?? {};
  try {
    return await db.modelLifecycleEvent.create({
      data: {
        modelVersionId: model.id,
        seq: head.seq + 1,
        fromState: head.state,
        toState: input.to,
        actor: input.actor,
        reason: input.reason,
        evidence: toJson(evidence),
        evidenceHash: canonicalHash(evidence),
        approvalId: approval?.id ?? null,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ModelRegistryError("CONCURRENT_TRANSITION", `model ${model.id} changed while transitioning from ${head.state}`);
    }
    throw error;
  }
}

export async function retireModel(db: Db, input: { modelVersionId: string; actor: string; reason: string }): Promise<ModelLifecycleEventRow> {
  return transitionModel(db, { ...input, to: "RETIRED" });
}

const MAX_APPROVAL_TTL_MS = 7 * 86_400_000;

/**
 * Operator approval for the PAPER_APPROVED evidence label, bound to the model's artefact hash. It grants no
 * trading authority. Meant for an operator tool; nothing automated calls it.
 */
export async function recordModelPaperApproval(db: Db, input: { modelVersionId: string; approvedBy: string; ttlMs: number; note?: string; now?: Date }) {
  if (!/^operator:.+/.test(input.approvedBy)) throw new ModelRegistryError("OPERATOR_REQUIRED", "approvals are recorded by an operator actor (operator:<identity>)");
  if (!(input.ttlMs > 0 && input.ttlMs <= MAX_APPROVAL_TTL_MS)) throw new ModelRegistryError("BAD_TTL", `ttlMs must be in (0, ${MAX_APPROVAL_TTL_MS}]`);
  const model = await db.modelVersion.findUnique({ where: { id: input.modelVersionId }, select: { artefactHash: true } });
  if (!model) throw new ModelRegistryError("NOT_FOUND", `model ${input.modelVersionId} not found`);
  const now = input.now ?? new Date();
  return db.modelPaperApproval.create({
    data: { modelVersionId: input.modelVersionId, approvedBy: input.approvedBy, approvedAt: now, expiresAt: new Date(now.getTime() + input.ttlMs), subjectHash: model.artefactHash, note: input.note ?? null },
  });
}

export type ModelComparison = {
  a: { id: string; family: string; version: string; trainingCutoff: string; artefactHash: string };
  b: { id: string; family: string; version: string; trainingCutoff: string; artefactHash: string };
  /** Same label definition and feature set: shadow metrics are directly comparable. */
  comparable: boolean;
  differences: string[];
};

/** Provenance diff of two registered models (verifies both artefacts). Combine with `shadowLeaderboard` for evidence. */
export async function compareModels(db: Db, aId: string, bId: string): Promise<ModelComparison> {
  const [a, b] = await Promise.all([loadModel(db, aId), loadModel(db, bId)]);
  const differences: string[] = [];
  const fields = ["family", "protocol", "featureSetHash", "labelSpecHash", "codeCommit", "artefactHash", "hypothesisId"] as const;
  for (const f of fields) if (a.model[f] !== b.model[f]) differences.push(f);
  if (a.model.trainingCutoff.getTime() !== b.model.trainingCutoff.getTime()) differences.push("trainingCutoff");
  if (canonicalJson([...a.model.datasetHashes].sort()) !== canonicalJson([...b.model.datasetHashes].sort())) differences.push("datasetHashes");
  for (const f of ["hyperparameters", "trainingProtocol", "validation", "labelDefinition"] as const) if (canonicalJson(a.model[f]) !== canonicalJson(b.model[f])) differences.push(f);
  const summary = (m: LoadedModel) => ({ id: m.model.id, family: m.model.family, version: m.model.version, trainingCutoff: m.model.trainingCutoff.toISOString(), artefactHash: m.model.artefactHash });
  return { a: summary(a), b: summary(b), comparable: a.model.labelSpecHash === b.model.labelSpecHash && a.model.featureSetHash === b.model.featureSetHash, differences };
}
