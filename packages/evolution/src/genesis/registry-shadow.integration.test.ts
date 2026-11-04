import { createHash } from "node:crypto";
import type { ResearchBar } from "@odin/backtest/ml2";
import { PrismaClient, toJson } from "@odin/shared/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordModelPaperApproval, registerModel, transitionModel, currentModelState } from "./model-registry.js";
import { runShadowCycle, runShadowTick, type ShadowBarSource } from "./shadow.js";
import { shadowLeaderboard } from "./shadow-leaderboard.js";
import { fixtureArtefact, fixtureRegistration, syntheticBars } from "./test-fixtures.js";

const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));

/** 5-second bars keep the real-time timing rules (latency ≤ one bar, outcome after the horizon) testable. */
const BAR = 5_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function memorySource(bars: ResearchBar[]): ShadowBarSource {
  return {
    async latestBars(_key, barMs, asOf, limit) {
      return bars.filter((b) => b.t + barMs <= asOf.getTime()).slice(-limit);
    },
    async barsBetween(_key, barMs, from, to, asOf) {
      return bars.filter((b) => b.t >= from.getTime() && b.t <= to.getTime() && b.t + barMs <= asOf.getTime());
    },
  };
}

describe.skipIf(!enabled)("GENESIS model registry and shadow predictions (database)", () => {
  let prisma: PrismaClient;
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  /** Rows on the trading path that the shadow cycle must never create or change. */
  const tradingSnapshot = async () => {
    const [orders, intents, fills, ledger] = await Promise.all([prisma.order.count(), prisma.tradeIntent.count(), prisma.fill.count(), prisma.ledgerEntry.count()]);
    const engine = await prisma.engineControl.findMany({ orderBy: { id: "asc" } });
    const instances = await prisma.strategyInstance.findMany({ orderBy: { id: "asc" } });
    const hash = createHash("sha256").update(JSON.stringify({ engine, instances })).digest("hex");
    return { orders, intents, fills, ledger, hash };
  };

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRaw`SELECT pg_advisory_lock(641099)`;
  });

  afterAll(async () => {
    await prisma.$executeRaw`SELECT pg_advisory_unlock(641099)`;
    await prisma.$disconnect();
  });

  it("registers immutably: triggers refuse UPDATE, DELETE and TRUNCATE; re-registration must match", async () => {
    const artefact = fixtureArtefact({ trainedThroughTime: Date.now() - 86_400_000, barMs: BAR });
    const input = fixtureRegistration({ family: `it-${suffix}`, version: "1", artefact, barMs: BAR, horizon: 1 });
    const first = await registerModel(prisma, input);
    expect(first.status).toBe("REGISTERED");
    expect(await currentModelState(prisma, first.model.id)).toEqual({ state: "EXPERIMENTAL", seq: 0 });
    await expect(registerModel(prisma, input)).resolves.toMatchObject({ status: "ALREADY_REGISTERED", model: { id: first.model.id } });
    await expect(registerModel(prisma, { ...input, codeCommit: "b".repeat(40) })).rejects.toThrow(/REGISTRATION_CONFLICT/);

    const id = first.model.id;
    await expect(prisma.$executeRawUnsafe(`UPDATE "ModelVersion" SET "artefactHash" = $1 WHERE "id" = $2`, "0".repeat(64), id)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`UPDATE "ModelVersion" SET "validation" = '{}' WHERE "id" = $1`, id)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "ModelVersion" WHERE "id" = $1`, id)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`TRUNCATE "ModelVersion" CASCADE`)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`UPDATE "ModelLifecycleEvent" SET "reason" = 'x' WHERE "modelVersionId" = $1`, id)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "ModelLifecycleEvent" WHERE "modelVersionId" = $1`, id)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`TRUNCATE "ModelLifecycleEvent"`)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`TRUNCATE "ShadowPrediction" CASCADE`)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`TRUNCATE "ShadowOutcome"`)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`TRUNCATE "ModelPaperApproval" CASCADE`)).rejects.toThrow(/append-only/);
  });

  it("enforces the lifecycle in the database: chain, transition table, operator approval", async () => {
    const artefact = fixtureArtefact({ trainedThroughTime: Date.now() - 86_400_000, barMs: BAR, p: 0.61 });
    const { model } = await registerModel(prisma, fixtureRegistration({ family: `it-${suffix}`, version: "lifecycle", artefact, barMs: BAR, horizon: 1 }));
    const raw = (seq: number, from: string, to: string, actor = "genesis-test", approvalId: string | null = null) =>
      prisma.$executeRawUnsafe(
        `INSERT INTO "ModelLifecycleEvent" ("id","modelVersionId","seq","fromState","toState","actor","reason","evidence","evidenceHash","approvalId") VALUES ($1,$2,$3,$4,$5,$6,'raw','{}',$7,$8)`,
        `raw_${suffix}_${seq}_${to}`, model.id, seq, from, to, actor, "e".repeat(64), approvalId,
      );
    await expect(raw(1, "EXPERIMENTAL", "SHADOW_CANDIDATE")).rejects.toThrow(/not allowed/);
    await expect(raw(1, "HISTORICALLY_ELIGIBLE", "SHADOW_CANDIDATE")).rejects.toThrow(/starts from/);
    await expect(raw(5, "EXPERIMENTAL", "HISTORICALLY_ELIGIBLE")).rejects.toThrow(/no predecessor/);
    // The insert trigger runs before CHECKs, so an unknown state is refused by the transition table first.
    await expect(raw(1, "EXPERIMENTAL", "BOGUS")).rejects.toThrow(/not allowed|ModelLifecycleEvent_state_known/);
    await expect(raw(0, null as unknown as string, "BOGUS")).rejects.toThrow(/ModelLifecycleEvent_state_known|ModelLifecycleEvent_sequence/);

    await transitionModel(prisma, { modelVersionId: model.id, to: "HISTORICALLY_ELIGIBLE", actor: "genesis-test", reason: "walk-forward CANDIDATE" });
    await expect(raw(1, "EXPERIMENTAL", "REJECTED")).rejects.toThrow(/Unique constraint|duplicate key|23505/);
    for (const to of ["SHADOW_CANDIDATE", "SHADOW_VALIDATED"] as const) await transitionModel(prisma, { modelVersionId: model.id, to, actor: "genesis-test", reason: "test" });
    await expect(transitionModel(prisma, { modelVersionId: model.id, to: "PAPER_CANDIDATE", actor: "genesis-test", reason: "test" })).rejects.toThrow(/OPERATOR_REQUIRED/);
    await expect(raw(4, "SHADOW_VALIDATED", "PAPER_CANDIDATE")).rejects.toThrow(/ModelLifecycleEvent_operator_states/);
    await transitionModel(prisma, { modelVersionId: model.id, to: "PAPER_CANDIDATE", actor: "operator:ops@odin.local", reason: "operator review" });
    await expect(raw(5, "PAPER_CANDIDATE", "PAPER_APPROVED", "operator:ops@odin.local")).rejects.toThrow(/ModelLifecycleEvent_operator_states/);
    await expect(
      prisma.$executeRawUnsafe(`INSERT INTO "ModelPaperApproval" ("id","modelVersionId","approvedBy","expiresAt","subjectHash") VALUES ($1,$2,'operator:ops@odin.local', now() + interval '1 hour', $3)`, `apr_${suffix}`, model.id, "f".repeat(64)),
    ).rejects.toThrow(/subject does not match/);
    const approval = await recordModelPaperApproval(prisma, { modelVersionId: model.id, approvedBy: "operator:ops@odin.local", ttlMs: 3_600_000 });
    await expect(raw(5, "PAPER_CANDIDATE", "PAPER_APPROVED", "operator:other", approval.id)).rejects.toThrow(/current operator approval/);
    await transitionModel(prisma, { modelVersionId: model.id, to: "PAPER_APPROVED", actor: "operator:ops@odin.local", reason: "evidence label only", approvalId: approval.id });
    expect((await currentModelState(prisma, model.id)).state).toBe("PAPER_APPROVED");
    await transitionModel(prisma, { modelVersionId: model.id, to: "RETIRED", actor: "operator:ops@odin.local", reason: "test done" });
    await expect(transitionModel(prisma, { modelVersionId: model.id, to: "SHADOW_CANDIDATE", actor: "genesis-test", reason: "x" })).rejects.toThrow(/ILLEGAL_TRANSITION/);
  });

  it("runs a shadow cycle end to end: predict before outcome, resolve after the horizon, suspend, rank; no trading rows", async () => {
    const before = await tradingSnapshot();
    const artefact = fixtureArtefact({ trainedThroughTime: Date.now() - 86_400_000, barMs: BAR, kind: "logistic" });
    const { model } = await registerModel(prisma, fixtureRegistration({ family: `it-${suffix}`, version: "shadow", artefact, barMs: BAR, horizon: 1, instrumentKeys: [`TEST:${suffix}`] }));
    for (const to of ["HISTORICALLY_ELIGIBLE", "SHADOW_CANDIDATE"] as const) await transitionModel(prisma, { modelVersionId: model.id, to, actor: "genesis-test", reason: "test" });

    // Disabled by default: the worker entry point does nothing.
    await expect(runShadowTick(prisma, { bars: memorySource([]), env: {} })).resolves.toEqual({ status: "DISABLED" });

    // Start just after a bar boundary so the decision bar has closed moments ago.
    await sleep(BAR - (Date.now() % BAR) + 200);
    const lastOpen = Math.floor(Date.now() / BAR) * BAR - BAR;
    const bars = syntheticBars(300, lastOpen, BAR, 11);
    const source = memorySource(bars);
    const first = await runShadowCycle(prisma, { bars: source, modelIds: [model.id], monitor: { minResolved: 1 } });
    expect(first.skipped).toEqual([]);
    expect(first.predicted).toBe(1);
    const prediction = await prisma.shadowPrediction.findFirstOrThrow({ where: { modelVersionId: model.id } });
    expect(prediction.decisionBarOpenTime.getTime()).toBe(lastOpen);
    expect(prediction.createdAt.getTime()).toBeLessThan(prediction.horizonEndsAt.getTime());

    // Idempotent per decision bar.
    expect((await runShadowCycle(prisma, { bars: source, modelIds: [model.id] })).duplicates).toBe(1);
    // Append-only, no backdating, no outcome before the horizon ends.
    await expect(prisma.$executeRawUnsafe(`UPDATE "ShadowPrediction" SET "probability" = 0.99 WHERE "id" = $1`, prediction.id)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "ShadowPrediction" WHERE "id" = $1`, prediction.id)).rejects.toThrow(/append-only/);
    await expect(
      prisma.shadowOutcome.create({ data: { predictionId: prediction.id, resolvedAt: prediction.horizonEndsAt, hypotheticalFillAvailable: false, costBpsApplied: 30, barsHash: "a".repeat(64), recordHash: "a".repeat(64) } }),
    ).rejects.toThrow(/before its horizon ended/);
    const old = lastOpen - 100 * BAR;
    await expect(
      prisma.shadowPrediction.create({
        data: { ...prediction, id: `bd_${suffix}`, decisionBarOpenTime: new Date(old), decisionTime: new Date(old + BAR), horizonEndsAt: new Date(old + 2 * BAR), predictedAt: new Date(old + BAR + 1), features: toJson(prediction.features), createdAt: undefined },
      }),
    ).rejects.toThrow(/after its horizon ended|backdated/);

    // After the horizon: resolve from later bars only, then the monitor judges the evidence.
    await sleep(Math.max(0, prediction.horizonEndsAt.getTime() - Date.now()) + 300);
    bars.push(...syntheticBars(1, lastOpen + BAR, BAR, 12));
    const second = await runShadowCycle(prisma, { bars: source, modelIds: [model.id], monitor: { minResolved: 1, maxEce: 0.0001 } });
    expect({ resolved: second.resolved, pending: second.pending, skipped: second.skipped, failed: second.failed, stoppedEarly: second.stoppedEarly }).toMatchObject({ resolved: 1, pending: [] });
    const outcome = await prisma.shadowOutcome.findUniqueOrThrow({ where: { predictionId: prediction.id } });
    expect(outcome.source).toBe("HYPOTHETICAL_SHADOW");
    expect(outcome.hypotheticalFillAvailable).toBe(true);
    expect(outcome.resolvedAt.getTime()).toBeGreaterThanOrEqual(prediction.horizonEndsAt.getTime());
    await expect(
      prisma.shadowOutcome.create({ data: { predictionId: prediction.id, resolvedAt: new Date(), hypotheticalFillAvailable: false, costBpsApplied: 30, barsHash: "a".repeat(64), recordHash: "a".repeat(64) } }),
    ).rejects.toThrow(/Unique constraint|P2002/);
    await expect(prisma.$executeRawUnsafe(`UPDATE "ShadowOutcome" SET "realisedNetReturn" = 1 WHERE "id" = $1`, outcome.id)).rejects.toThrow(/append-only/);
    // positive must agree with the realised net return (CHECK runs before the unique index).
    await expect(
      prisma.shadowOutcome.create({ data: { predictionId: prediction.id, resolvedAt: new Date(), hypotheticalFillAvailable: true, realisedNetReturn: 0.01, positive: false, mae: -0.01, mfe: 0.02, exitReason: "HORIZON", costBpsApplied: 30, barsHash: "a".repeat(64), recordHash: "a".repeat(64) } }),
    ).rejects.toThrow(/ShadowOutcome_fill/);
    // Guards are ENABLE ALWAYS: replica mode does not bypass them.
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
        await tx.$executeRawUnsafe(`UPDATE "ShadowOutcome" SET "realisedNetReturn" = 1 WHERE "id" = $1`, outcome.id);
      }),
    ).rejects.toThrow(/append-only/);

    expect(second.suspended.map((s) => s.modelVersionId)).toEqual([model.id]);
    const head = await currentModelState(prisma, model.id);
    expect(head.state).toBe("REJECTED");
    const events = await prisma.modelLifecycleEvent.findMany({ where: { modelVersionId: model.id }, orderBy: { seq: "asc" } });
    expect(events.map((e) => e.toState)).toEqual(["EXPERIMENTAL", "HISTORICALLY_ELIGIBLE", "SHADOW_CANDIDATE", "REJECTED"]);
    expect(events[3]!.reason).toMatch(/^SUSPENDED_BY_MONITOR: CALIBRATION/);

    // A suspended model is no longer run; its history stays.
    expect((await runShadowCycle(prisma, { bars: source, modelIds: [model.id] })).models).toEqual([]);
    const [entry] = await shadowLeaderboard(prisma, { modelIds: [model.id] });
    expect(entry).toMatchObject({ modelVersionId: model.id, state: "REJECTED", resolved: 1, evidence: "HYPOTHETICAL_SHADOW" });
    expect(entry!.failureReasons).not.toHaveProperty("RECORD_HASH_MISMATCH");

    expect(await tradingSnapshot()).toEqual(before);
  }, 60_000);
});
