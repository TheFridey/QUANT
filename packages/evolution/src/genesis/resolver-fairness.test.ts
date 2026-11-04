import type { PrismaClient } from "@odin/shared/db";
import { describe, expect, it } from "vitest";
import { MAX_APPROVAL_TTL_MS, prepareModelRegistration, recordModelPaperApproval } from "./model-registry.js";
import { predictionCanonical, predictionRecordHash, resolveShadowPredictions, verifyStoredPrediction, type PredictionRecord, type ShadowBarSource } from "./shadow.js";
import { fixtureArtefact, fixtureRegistration, HOUR, syntheticBars } from "./test-fixtures.js";

/**
 * In-memory stand-in for the few Prisma calls the resolver makes, so head-of-queue fairness can be tested
 * without a database. It mirrors the filters the resolver passes (status, no outcome, horizon window, model).
 */
type Row = PredictionRecord & { id: string; recordCanonical: string; recordHash: string; createdAt: Date };

function fakeDb(input: { models: Array<{ id: string; state: string; row: Record<string, unknown> }>; predictions: Row[] }) {
  const events = new Map(input.models.map((m) => [m.id, [{ modelVersionId: m.id, seq: 0, toState: m.state }]]));
  const outcomes: Array<{ predictionId: string }> = [];
  const due = (where: Record<string, unknown>) => {
    const h = where.horizonEndsAt as { lte: Date; gte: Date };
    const mv = where.modelVersionId as string | { in: string[] } | undefined;
    return input.predictions
      .filter((p) => p.status === "PREDICTED" && !outcomes.some((o) => o.predictionId === p.id))
      .filter((p) => p.horizonEndsAt <= h.lte && p.horizonEndsAt >= h.gte)
      .filter((p) => (mv === undefined ? true : typeof mv === "string" ? p.modelVersionId === mv : mv.in.includes(p.modelVersionId)))
      .sort((a, b) => a.horizonEndsAt.getTime() - b.horizonEndsAt.getTime() || a.id.localeCompare(b.id));
  };
  const head = (id: string) => events.get(id)!.at(-1)!;
  const prisma = {
    shadowPrediction: {
      findMany: async (args: { where: Record<string, unknown>; distinct?: string[]; take?: number }) => {
        const rows = due(args.where);
        if (args.distinct) return [...new Set(rows.map((r) => r.modelVersionId))].sort().map((modelVersionId) => ({ modelVersionId }));
        return rows.slice(0, args.take ?? rows.length);
      },
    },
    $queryRaw: async (_s: TemplateStringsArray, ids?: string[]) => (ids ?? [...events.keys()]).filter((id) => events.has(id)).map((id) => head(id)),
    modelVersion: { findUnique: async ({ where }: { where: { id: string } }) => input.models.find((m) => m.id === where.id)?.row ?? null },
    modelLifecycleEvent: {
      findFirst: async ({ where }: { where: { modelVersionId: string } }) => head(where.modelVersionId),
      create: async ({ data }: { data: { modelVersionId: string; seq: number; toState: string } }) => {
        events.get(data.modelVersionId)!.push(data);
        return data;
      },
    },
    shadowOutcome: { create: async ({ data }: { data: { predictionId: string } }) => void outcomes.push(data) },
  } as unknown as PrismaClient;
  return { prisma, outcomes, state: (id: string) => head(id).toState };
}

const decisionBase = Date.parse("2026-10-20T00:00:00Z");
const bars = syntheticBars(400, decisionBase + 399 * HOUR, HOUR, 3);
const source: ShadowBarSource = {
  latestBars: async () => [],
  barsBetween: async (_k, barMs, from, to, asOf) => bars.filter((b) => b.t >= from.getTime() && b.t <= to.getTime() && b.t + barMs <= asOf.getTime()),
};

function prediction(modelVersionId: string, k: number, tamper = false): Row {
  const t = decisionBase + k * HOUR;
  const record: PredictionRecord = {
    modelVersionId,
    instrumentKey: "TEST:FAIR",
    status: "PREDICTED",
    predictedAt: new Date(t + HOUR),
    decisionBarOpenTime: new Date(t),
    decisionTime: new Date(t + HOUR),
    barMs: HOUR,
    horizonBars: 2,
    horizonEndsAt: new Date(t + 3 * HOUR),
    features: { f: k },
    featureHash: "a".repeat(64),
    probability: 0.6,
    expectedNetReturn: null,
    confidenceBasis: "test",
    estimatedCostBps: 30,
    abstainReasons: [],
    inputHash: "b".repeat(64),
  };
  return { ...record, id: `${modelVersionId}_${String(k).padStart(4, "0")}`, recordCanonical: predictionCanonical(record), recordHash: tamper ? "0".repeat(64) : predictionRecordHash(record), createdAt: record.predictedAt };
}

function modelRow(id: string) {
  const { data } = prepareModelRegistration(fixtureRegistration({ family: "fair", version: id, artefact: fixtureArtefact({ trainedThroughTime: decisionBase - HOUR }) }));
  return { ...data, id, createdAt: new Date(decisionBase) } as unknown as Record<string, unknown>;
}

describe("GENESIS resolver fairness", () => {
  const now = new Date(decisionBase + 380 * HOUR);

  it("a poisoned model holding more than the budget of the oldest rows cannot starve a healthy one", async () => {
    // The poisoned model's 50 rows all mature before any healthy row; budget is 10.
    const poisoned = Array.from({ length: 50 }, (_, k) => prediction("mv_bad", k, true));
    const healthy = Array.from({ length: 5 }, (_, k) => prediction("mv_good", 100 + k));
    const db = fakeDb({ models: [{ id: "mv_bad", state: "SHADOW_CANDIDATE", row: modelRow("mv_bad") }, { id: "mv_good", state: "SHADOW_CANDIDATE", row: modelRow("mv_good") }], predictions: [...poisoned, ...healthy] });
    const r = await resolveShadowPredictions(db.prisma, { bars: source, now, maxResolutions: 10 });
    expect(r.resolved).toBe(5);
    expect(db.outcomes.map((o) => o.predictionId).sort()).toEqual(healthy.map((p) => p.id).sort());
    expect(r.excludedModels).toEqual(["mv_bad"]);
    expect(r.pending.filter((p) => p.reason === "RECORD_HASH_MISMATCH")).toHaveLength(1);
    // The integrity failure moves the model to FAILED, so its rows leave the queue on later cycles.
    expect(db.state("mv_bad")).toBe("FAILED");
    const next = await resolveShadowPredictions(db.prisma, { bars: source, now, maxResolutions: 10 });
    expect(next.pending).toEqual([]);
    expect(next.excludedModels).toEqual([]);
  });

  it("a terminal model with permanently pending rows still gets only its fair share", async () => {
    const stuck = Array.from({ length: 50 }, (_, k) => prediction("mv_stuck", k, true));
    const healthy = Array.from({ length: 8 }, (_, k) => prediction("mv_ok", 100 + k));
    const db = fakeDb({ models: [{ id: "mv_stuck", state: "REJECTED", row: modelRow("mv_stuck") }, { id: "mv_ok", state: "SHADOW_VALIDATED", row: modelRow("mv_ok") }], predictions: [...stuck, ...healthy] });
    const r = await resolveShadowPredictions(db.prisma, { bars: source, now, maxResolutions: 10 });
    expect(r.resolved).toBe(5);
    expect(db.state("mv_stuck")).toBe("REJECTED");
    const again = await resolveShadowPredictions(db.prisma, { bars: source, now, maxResolutions: 10 });
    expect(again.resolved).toBe(3);
  });
});

describe("GENESIS stored prediction verification", () => {
  it("trusts the hashed text, tolerates a one-ulp float column, and refuses disagreeing columns", () => {
    const row = prediction("mv_v", 1);
    expect(verifyStoredPrediction(row)).toEqual({ probability: 0.6 });
    expect(verifyStoredPrediction({ ...row, probability: 0.6 + Number.EPSILON })).toEqual({ probability: 0.6 });
    expect(verifyStoredPrediction({ ...row, probability: 0.7 })).toBeNull();
    expect(verifyStoredPrediction({ ...row, horizonBars: 3 })).toBeNull();
    expect(verifyStoredPrediction({ ...row, recordCanonical: row.recordCanonical.replace('"f":1', '"f":2') })).toBeNull();
  });
});

describe("GENESIS paper approval TTL", () => {
  it("caps the TTL below the database's 7-day CHECK, leaving room for clock skew", async () => {
    const created: Array<{ approvedAt: Date; expiresAt: Date }> = [];
    const prisma = {
      modelVersion: { findUnique: async () => ({ artefactHash: "c".repeat(64) }) },
      modelPaperApproval: { create: async ({ data }: { data: { approvedAt: Date; expiresAt: Date } }) => {
          created.push(data);
          return data;
        },
      },
    } as unknown as PrismaClient;
    expect(MAX_APPROVAL_TTL_MS).toBe(7 * 86_400_000 - 3_600_000);
    await expect(recordModelPaperApproval(prisma, { modelVersionId: "m", approvedBy: "operator:ops", ttlMs: 7 * 86_400_000 })).rejects.toThrow(/BAD_TTL/);
    await expect(recordModelPaperApproval(prisma, { modelVersionId: "m", approvedBy: "genesis", ttlMs: 1_000 })).rejects.toThrow(/OPERATOR_REQUIRED/);
    await recordModelPaperApproval(prisma, { modelVersionId: "m", approvedBy: "operator:ops", ttlMs: MAX_APPROVAL_TTL_MS });
    expect(created[0]!.expiresAt.getTime() - created[0]!.approvedAt.getTime()).toBe(MAX_APPROVAL_TTL_MS);
  });
});
