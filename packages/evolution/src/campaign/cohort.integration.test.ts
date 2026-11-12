import { PrismaClient, toJson } from "@odin/shared/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../genesis/canonical.js";
import { registerModel } from "../genesis/model-registry.js";
import { predictionCanonical, type PredictionRecord } from "../genesis/shadow.js";
import { fixtureArtefact, fixtureRegistration } from "../genesis/test-fixtures.js";
import { modelProspectiveEvidence, readProspectiveCohort } from "./bridge.js";

/**
 * OPERATION INTEGRITY F09 on real Postgres: keyset pagination over (decisionTime, id) reads every row exactly once
 * across page boundaries with three instruments tied at every decision time, and a row inserted by another
 * connection while the cohort is being read does not appear in a later page (REPEATABLE READ snapshot).
 * The insert triggers forbid backdated predictions and early outcomes, so rows are live-timed and unresolved; the
 * cutoff logic is covered against a reference calculation in `cohort.test.ts`.
 */
const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const BAR = 3_600_000;

describe.skipIf(!enabled)("prospective cohort pagination (F09, Postgres)", () => {
  let a: PrismaClient;
  let b: PrismaClient;
  let modelId: string;
  let model: Parameters<typeof modelProspectiveEvidence>[1];
  const base = Date.now() - 30 * 60_000;
  const record = (i: number, instrument: string, now: number): PredictionRecord & { recordCanonical: string; recordHash: string } => {
    const open = base + i - BAR;
    const rec: PredictionRecord = {
      modelVersionId: modelId,
      instrumentKey: instrument,
      status: "ABSTAINED",
      predictedAt: new Date(now),
      decisionBarOpenTime: new Date(open),
      decisionTime: new Date(open + BAR),
      barMs: BAR,
      horizonBars: 1,
      horizonEndsAt: new Date(open + 2 * BAR),
      features: { f: i % 5 },
      featureHash: "f".repeat(64),
      probability: null,
      expectedNetReturn: null,
      confidenceBasis: "test",
      estimatedCostBps: 10,
      abstainReasons: ["DISAGREEMENT"],
      inputHash: "1".repeat(64),
    };
    const canonical = predictionCanonical(rec);
    return { ...rec, recordCanonical: canonical, recordHash: sha256Hex(canonical) };
  };

  beforeAll(async () => {
    a = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    b = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const registered = await registerModel(a, fixtureRegistration({ family: `f09-${suffix}`, version: "1", artefact: fixtureArtefact({ trainedThroughTime: Date.now() - 86_400_000, barMs: BAR }), barMs: BAR, instrumentKeys: ["A", "B", "C"] }));
    modelId = registered.model.id;
    model = registered.model;
    const now = Date.now();
    const data = [];
    for (let i = 0; i < 5_001; i += 1) for (const inst of ["A", "B", "C"]) data.push(record(i, inst, now));
    for (let k = 0; k < data.length; k += 2_000) await a.shadowPrediction.createMany({ data: data.slice(k, k + 2_000).map((r) => ({ ...r, features: toJson(r.features) })) });
  }, 180_000);
  afterAll(async () => {
    await a.$disconnect();
    await b.$disconnect();
  });

  it("reads all 15,003 rows exactly once in deterministic (decisionTime, id) order for several page sizes", async () => {
    const counted = await a.shadowPrediction.count({ where: { modelVersionId: modelId } });
    expect(counted).toBe(15_003);
    const reference = await a.shadowPrediction.findMany({ where: { modelVersionId: modelId }, orderBy: [{ decisionTime: "asc" }, { id: "asc" }], select: { decisionTime: true } });
    for (const pageSize of [1_000, 4_999, 5_000, 5_001, 20_000]) {
      const c = await readProspectiveCohort(a, { modelVersionId: modelId, entryThreshold: 0.55, targetEffectiveSignals: 30, pageSize });
      expect(c.rows).toHaveLength(15_003);
      expect(c.rows.map((r) => r.decisionTime)).toEqual(reference.map((r) => r.decisionTime.getTime()));
      expect(c.rows.every((r) => r.hashOk)).toBe(true);
      expect(c).toMatchObject({ reached: false, truncated: false, laterRows: 0 });
      expect(c.pages).toBe(Math.floor(15_003 / pageSize) + 1);
    }
  }, 120_000);

  it("a row inserted by another connection mid-read does not enter the snapshot", async () => {
    let injected = false;
    const cohort = await a.$transaction(
      async (tx) => {
        const db = {
          shadowPrediction: {
            findMany: async (q: Parameters<typeof tx.shadowPrediction.findMany>[0]) => {
              const page = await tx.shadowPrediction.findMany(q);
              if (!injected) {
                injected = true;
                // Committed by a different connection after the snapshot started; it sorts into a later page.
                const late = record(9_000, "A", Date.now());
                await b.shadowPrediction.create({ data: { ...late, features: toJson(late.features) } });
              }
              return page;
            },
            count: (q: Parameters<typeof tx.shadowPrediction.count>[0]) => tx.shadowPrediction.count(q),
          },
        };
        return readProspectiveCohort(db as never, { modelVersionId: modelId, entryThreshold: 0.55, targetEffectiveSignals: 30, pageSize: 2_000 });
      },
      { isolationLevel: "RepeatableRead", timeout: 120_000 },
    );
    expect(injected).toBe(true);
    expect(cohort.rows).toHaveLength(15_003);
    expect(await a.shadowPrediction.count({ where: { modelVersionId: modelId } })).toBe(15_004);
  }, 120_000);

  it("modelProspectiveEvidence reports cohort progress and an unreached, unjudged sample", async () => {
    const ev = await modelProspectiveEvidence(a, model, new Date(), { pageSize: 3_000 });
    expect(ev.cohort).toMatchObject({ rowsRead: 15_004, truncated: false, laterRows: 0, pages: 6 });
    expect(ev.abstained).toBe(15_004);
    expect(ev.observation.reached).toBe(false);
    expect(ev.sufficient).toBe(false);
    const capped = await modelProspectiveEvidence(a, model, new Date(), { pageSize: 3_000, maxRows: 10_000 });
    expect(capped.cohort).toMatchObject({ rowsRead: 10_000, truncated: true });
    expect(capped.missing.join(" ")).toMatch(/truncated cohort is never judged/);
  }, 120_000);
});
