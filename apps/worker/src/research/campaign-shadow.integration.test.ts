import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResearchBar } from "@odin/backtest/ml2";
import { authorizeHoldout, barsToCsv, createCampaign, evaluateUnit, registerCampaignModel, runDetail, startProspectiveObservation, startRun, syntheticVolumeSpikeBars } from "@odin/evolution/campaign";
import { currentModelState, loadModel, runShadowCycle, type ShadowBarSource } from "@odin/evolution/genesis";
import { PrismaClient } from "@odin/shared/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluateHoldout, workRun, type Evaluator, type RunnerDeps } from "./campaign-runner.js";

const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));

/**
 * SYNTHETIC end-to-end path: campaign -> walk-forward -> authorised holdout -> frozen model -> operator starts
 * observation -> the existing GENESIS shadow service scores it. The series is constructed with a planted
 * volume signal; nothing here is market evidence.
 */
const BAR = 14_400_000;
const CODE = "abc1234";
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
const dir = mkdtempSync(join(tmpdir(), "odin-campaign-shadow-"));

describe.skipIf(!enabled)("campaign result to prospective shadow observation (Postgres, synthetic)", () => {
  let prisma: PrismaClient;
  const inProcess: Evaluator = async (job) => ({ evaluation: evaluateUnit(job), runtimeMs: 1, peakRssMb: 1 });
  const deps = (owner: string): RunnerDeps => ({ owner, baseDir: dir, codeVersion: CODE, evaluator: inProcess });
  const snapshot = async () => {
    const [orders, intents, fills, ledger, promotions] = await Promise.all([prisma.order.count(), prisma.tradeIntent.count(), prisma.fill.count(), prisma.ledgerEntry.count(), prisma.strategyPromotion.count()]);
    const engine = await prisma.engineControl.findMany({ orderBy: { id: "asc" } });
    const instances = await prisma.strategyInstance.findMany({ orderBy: { id: "asc" } });
    return JSON.stringify({ orders, intents, fills, ledger, promotions, engine, instances });
  };

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRaw`SELECT pg_advisory_lock(641099)`;
  });
  afterAll(async () => {
    await prisma.$executeRaw`SELECT pg_advisory_unlock(641099)`;
    await prisma.$disconnect();
  });

  it("walks every evidence state in order and creates no orders", async () => {
    const before = await snapshot();
    // The last bar closed 30 s ago, so the shadow service may predict on it under its real-time rule.
    const n = 7000;
    const lastOpen = Date.now() - BAR - 30_000;
    const bars: ResearchBar[] = syntheticVolumeSpikeBars({ start: new Date(lastOpen - (n - 1) * BAR).toISOString(), bars: n, seed: 31, barMs: BAR, boostBars: 6 });
    const csv = barsToCsv(bars);
    writeFileSync(join(dir, "spike.csv"), csv);
    const instrument = `SYN${tag}/USD`;
    const { campaign } = await createCampaign(prisma, {
      specVersion: "campaign-spec-1",
      name: `SYNTHETIC shadow bridge ${tag}`,
      synthetic: true,
      datasets: [{ key: "spike", source: { kind: "FILE", path: "spike.csv", sha256: createHash("sha256").update(csv).digest("hex") }, market: "CRYPTO", instrument, interval: "4h", asOf: new Date().toISOString() }],
      hypotheses: [{ kind: "ML2" }],
      validation: { seed: 1 },
      ml: { seed: 1, bootstrapResamples: 200, randomControls: 100 },
      limits: { maxTrials: 100, maxRuntimeMsPerUnit: 600_000, maxMemoryMbPerUnit: 2048, maxConcurrency: 1, maxAttemptsPerUnit: 2 },
      holdoutPolicy: "WITHHELD_UNLESS_AUTHORIZED",
    }, "it");
    const { run } = await startRun(prisma, { campaignId: campaign.id, requestedBy: "it", codeVersion: CODE });
    const stageOf = async () => (await runDetail(prisma, run.id))!.units[0]!;

    // 0. Declared, not run: unknown, not zero.
    expect((await stageOf()).stage).toMatchObject({ stage: null, status: "QUEUED", executable: false });

    // 1 -> 2. Historical result that passed every pre-holdout test: pending, holdout unread.
    await workRun(prisma, run.id, deps("bridge"));
    let unit = await stageOf();
    expect(unit.walkForward).toMatchObject({ walkForwardPassed: true, holdoutStatus: "WITHHELD", verdict: "INSUFFICIENT_EVIDENCE" });
    expect(unit.stage).toMatchObject({ stage: "PENDING_HOLDOUT", status: "WITHHELD", executable: false });
    // Not eligible for observation before its holdout: eligibility is not relaxed.
    await expect(registerCampaignModel(prisma, { unitId: unit.id, registeredBy: "it", instrumentKeys: [`SYNTHETIC:SYN${tag}`], maxStalenessDays: 730, targetEffectiveSignals: 30 })).rejects.toThrow(/NOT_ELIGIBLE/);

    // 3. Holdout evaluated once, under authorisation.
    await authorizeHoldout(prisma, { unitId: unit.id, operator: "rhys", ttlMs: 3_600_000 });
    expect((await stageOf()).stage.status).toBe("AUTHORISED_NOT_EVALUATED");
    expect(await evaluateHoldout(prisma, unit.id, deps("bridge"))).toMatchObject({ status: "RECORDED", verdict: "CANDIDATE" });
    unit = await stageOf();
    expect(unit.stage).toMatchObject({ stage: "HOLDOUT_EVALUATED", status: "HOLDOUT_PASSED_RESEARCH_ONLY", executable: false });
    expect(unit.stage.missing.join(" ")).toMatch(/prospective observation/);

    // A synthetic model can never be pointed at a real instrument, and the staleness limit has no default.
    await expect(registerCampaignModel(prisma, { unitId: unit.id, registeredBy: "it", instrumentKeys: ["EUR_USD"], maxStalenessDays: 730, targetEffectiveSignals: 30 })).rejects.toThrow(/SYNTHETIC_ONLY/);
    await expect(registerCampaignModel(prisma, { unitId: unit.id, registeredBy: "it", instrumentKeys: [`SYNTHETIC:SYN${tag}`], maxStalenessDays: Number.NaN, targetEffectiveSignals: 30 })).rejects.toThrow(/STALENESS_REQUIRED/);
    // The observation length is declared before observation starts; there is no default and no small value.
    await expect(registerCampaignModel(prisma, { unitId: unit.id, registeredBy: "it", instrumentKeys: [`SYNTHETIC:SYN${tag}`], maxStalenessDays: 730, targetEffectiveSignals: 5 })).rejects.toThrow(/OBSERVATION_LENGTH_REQUIRED/);
    const key = `SYNTHETIC:SYN${tag}`;
    const registered = await registerCampaignModel(prisma, { unitId: unit.id, registeredBy: "it", instrumentKeys: [key], maxStalenessDays: 730, targetEffectiveSignals: 30 });
    expect(registered.status).toBe("REGISTERED");
    expect(registered.model.family).toBe("campaign-ml2-synthetic");
    expect((await registerCampaignModel(prisma, { unitId: unit.id, registeredBy: "it", instrumentKeys: [key], maxStalenessDays: 730, targetEffectiveSignals: 30 })).status).toBe("ALREADY_REGISTERED");
    // Registered but not observed: the shadow service ignores it until an operator acts.
    expect((await currentModelState(prisma, registered.model.id)).state).toBe("EXPERIMENTAL");
    const source: ShadowBarSource = {
      async latestBars(_k, barMs, asOf, limit) {
        return bars.filter((b) => b.t + barMs <= asOf.getTime()).slice(-limit);
      },
      async barsBetween(_k, barMs, from, to, asOf) {
        return bars.filter((b) => b.t >= from.getTime() && b.t <= to.getTime() && b.t + barMs <= asOf.getTime());
      },
    };
    const idle = await runShadowCycle(prisma, { bars: source, modelIds: [registered.model.id] });
    expect(idle.models).toEqual([]);
    expect((await stageOf()).stage).toMatchObject({ stage: "HOLDOUT_EVALUATED", status: "MODEL_EXPERIMENTAL" });

    // 4. Operator starts observation; the existing shadow service scores the frozen artefact.
    await expect(startProspectiveObservation(prisma, { modelVersionId: registered.model.id, operator: "", reason: "x" })).rejects.toThrow(/OPERATOR_REQUIRED/);
    expect(await startProspectiveObservation(prisma, { modelVersionId: registered.model.id, operator: "rhys", reason: "synthetic bridge demonstration" })).toEqual({ state: "SHADOW_CANDIDATE" });
    const first = await runShadowCycle(prisma, { bars: source, modelIds: [registered.model.id] });
    expect(first.failed).toEqual([]);
    expect(first.models).toEqual([registered.model.id]);
    expect(first.predicted + first.abstained).toBe(1);
    // A restart or a second delivery of the same cycle cannot add a second prediction for the bar.
    const second = await runShadowCycle(prisma, { bars: source, modelIds: [registered.model.id] });
    expect(second.predicted + second.abstained).toBe(0);
    expect(second.duplicates).toBe(1);
    const rows = await prisma.shadowPrediction.findMany({ where: { modelVersionId: registered.model.id }, include: { outcome: true } });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // Prediction-time availability: the decision bar had closed, and only bars up to it were hashed as input.
    expect(row.decisionBarOpenTime.getTime()).toBe(bars.at(-1)!.t);
    expect(row.predictedAt.getTime()).toBeGreaterThanOrEqual(row.decisionTime.getTime());
    // The outcome is resolved only after the declared horizon (6 bars = 24 h): not now.
    expect(row.horizonEndsAt.getTime()).toBe(bars.at(-1)!.t + 7 * BAR);
    expect(row.outcome).toBeNull();
    expect(first.resolved + second.resolved).toBe(0);
    // The cohort is frozen: the stored artefact still hashes to the registered identity.
    const loaded = await loadModel(prisma, registered.model.id);
    expect(loaded.model.artefactHash).toBe(registered.model.artefactHash);
    await expect(prisma.$executeRawUnsafe(`UPDATE "ModelVersion" SET "trainingProtocol" = '{}' WHERE "id" = $1`, registered.model.id)).rejects.toThrow(/append-only/);

    unit = await stageOf();
    expect(unit.model).toMatchObject({ id: registered.model.id, state: "SHADOW_CANDIDATE" });
    expect(unit.stage).toMatchObject({ stage: "PROSPECTIVE_OBSERVATION", executable: false });
    expect(unit.prospective).toMatchObject({ evidence: "HYPOTHETICAL_SHADOW", resolved: 0, effectiveOutcomes: 0, sufficient: false });
    // Unknown stays unknown: no outcome yet means no net figure, not a zero.
    expect(unit.prospective!.meanNetSignals).toBeNull();
    expect(unit.prospective!.netAdvantage).toBeNull();
    expect(unit.stage.missing.join(" ")).toMatch(/0 independent resolved outcomes \(need 30\)/);
    expect(unit.stage.missing.join(" ")).toMatch(/0 of the 30 independent signals declared at registration/);
    expect(unit.prospective!.observation).toEqual({ targetEffectiveSignals: 30, reached: false, judgedOn: "NOT_YET_JUDGED" });

    // Nothing on the trading path was created or changed anywhere along the way.
    expect(await snapshot()).toBe(before);
  }, 600_000);
});
