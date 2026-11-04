import type { PrismaClient } from "@odin/shared/db";
import { describe, expect, it } from "vitest";
import { canonicalHash, canonicalJson } from "./canonical.js";
import { parseMl2Artefact } from "./model-artefact.js";
import { modelArtefactHash, prepareModelRegistration, registerModel, verifyStoredArtefact, type ModelVersionRow } from "./model-registry.js";
import { fixtureArtefact, fixtureRegistration, HOUR, syntheticBars } from "./test-fixtures.js";
import { runMlPipeline } from "@odin/backtest";

const cutoff = Date.parse("2026-10-01T00:00:00Z");

function storedRow(input = fixtureRegistration({ family: "lr", version: "1", artefact: fixtureArtefact({ trainedThroughTime: cutoff, kind: "logistic" }) })): ModelVersionRow {
  const { data } = prepareModelRegistration(input);
  // Simulate a jsonb round trip: key order is not preserved.
  const reorder = (v: unknown): unknown => (Array.isArray(v) ? v.map(reorder) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reorder(x)])) : v);
  return { ...data, id: "mv_1", createdAt: new Date(), artefact: reorder(JSON.parse(JSON.stringify(data.artefact))), labelDefinition: reorder(data.labelDefinition) } as unknown as ModelVersionRow;
}

describe("GENESIS canonical hashing", () => {
  it("is independent of key order and refuses values JSON cannot round-trip", () => {
    expect(canonicalHash({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(canonicalHash({ b: [1, { d: 3, c: 2 }], a: 1 }));
    expect(canonicalJson({ z: -0 })).toBe('{"z":0}');
    expect(() => canonicalJson({ x: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ x: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
    expect(() => canonicalJson({ x: undefined })).toThrow(/undefined/);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(/unsupported/);
    expect(() => canonicalJson({ m: new Map() })).toThrow(/plain object/);
  });
});

describe("GENESIS model artefacts are data only", () => {
  const artefact = fixtureArtefact({ trainedThroughTime: cutoff, kind: "logistic" });

  it("accepts a valid artefact and refuses extra keys, code-like values and bad shapes", () => {
    expect(parseMl2Artefact(JSON.parse(JSON.stringify(artefact)))).toEqual(artefact);
    expect(() => parseMl2Artefact({ ...artefact, predict: "return 1" })).toThrow(/invalid ML2 artefact/);
    expect(() => parseMl2Artefact({ ...artefact, calibrator: { method: "EVAL", source: "x" } })).toThrow(/invalid ML2 artefact/);
    expect(() => parseMl2Artefact({ ...artefact, protocol: "ml-wf-9.9.9" })).toThrow(/invalid ML2 artefact/);
    expect(() => parseMl2Artefact({ ...artefact, preprocessor: { ...artefact.preprocessor, sd: artefact.preprocessor.sd.slice(1) } })).toThrow(/width/);
    expect(() => parseMl2Artefact({ ...artefact, family: "BASE_RATE" })).toThrow(/does not match family/);
  });

  it("refuses forest trees whose child indices could loop", () => {
    const forest = {
      ...fixtureArtefact({ trainedThroughTime: cutoff }),
      family: "RANDOM_FOREST",
      model: { family: "RANDOM_FOREST", forest: { family: "RANDOM_FOREST", trees: [[{ f: 0, th: 0, l: 0, r: 1, v: 0.5 }, { f: -1, th: 0, l: -1, r: -1, v: 0.5 }]], params: { trees: 1, maxDepth: 2, minLeaf: 1, sampleFraction: 1, featuresPerSplit: 1, thresholds: 3, seed: 1 } } },
    };
    expect(() => parseMl2Artefact(forest)).toThrow(/invalid split or child index/);
  });
});

describe("GENESIS registry accepts genuine ML 2.0 artefacts", () => {
  it("parses and hashes every final artefact of a real pipeline run (logistic, stumps, forest; Platt and isotonic)", () => {
    const bars = syntheticBars(1500, Date.parse("2026-10-01T00:00:00Z"), HOUR, 5);
    for (const calibration of ["PLATT", "ISOTONIC"] as const) {
      const report = runMlPipeline({ bars, barMs: HOUR, labelSpec: { horizon: 2, feeBpsPerSide: 5, slippageBpsPerSide: 5 }, config: { folds: 2, bootstrapResamples: 20, randomControls: 10, calibration } });
      const finals = Object.values(report.finalArtefacts);
      expect(finals.map((a) => a.family).sort()).toEqual(["BASE_RATE", "BOOSTED_STUMPS", "LOGISTIC_L2", "RANDOM_FOREST"]);
      for (const artefact of finals) {
        const roundTripped = JSON.parse(JSON.stringify(artefact)) as unknown;
        const reg = prepareModelRegistration(fixtureRegistration({ family: "real", version: artefact.family, artefact: roundTripped }));
        expect(reg.data.artefactHash).toBe(modelArtefactHash(artefact));
        expect(reg.artefact.family).toBe(artefact.family);
      }
    }
  }, 120_000);
});

describe("GENESIS registry hash verification", () => {
  it("verifies the claimed hash on registration", () => {
    const artefact = fixtureArtefact({ trainedThroughTime: cutoff });
    const input = fixtureRegistration({ family: "base", version: "1", artefact });
    expect(prepareModelRegistration({ ...input, artefactHash: modelArtefactHash(artefact) }).data.artefactHash).toBe(modelArtefactHash(artefact));
    expect(() => prepareModelRegistration({ ...input, artefactHash: "0".repeat(64) })).toThrow(/HASH_MISMATCH/);
    expect(() => prepareModelRegistration({ ...input, datasetHashes: ["nothex"] })).toThrow(/BAD_DATASET_HASHES/);
    expect(() => prepareModelRegistration({ ...input, codeCommit: "main" })).toThrow(/BAD_CODE_COMMIT/);
    expect(() => prepareModelRegistration({ ...input, validation: { brier: Number.NaN } })).toThrow(/BAD_JSON/);
  });

  it("re-verifies on load: a jsonb round trip passes, any tampering fails", () => {
    const row = storedRow();
    expect(verifyStoredArtefact(row).family).toBe("LOGISTIC_L2");
    const tampered = structuredClone(row) as unknown as { artefact: { calibrator: { a: number } } };
    tampered.artefact.calibrator.a = 2;
    expect(() => verifyStoredArtefact(tampered as unknown as ModelVersionRow)).toThrow(/HASH_MISMATCH/);
    expect(() => verifyStoredArtefact({ ...row, trainingCutoff: new Date(cutoff + 1) })).toThrow(/IDENTITY_MISMATCH/);
    expect(() => verifyStoredArtefact({ ...row, labelSpecHash: "d".repeat(64) })).toThrow(/IDENTITY_MISMATCH/);
  });

  it("returns the existing row for identical content and refuses different content", async () => {
    const existing = storedRow();
    const prisma = { modelVersion: { findUnique: async () => existing } } as unknown as PrismaClient;
    const same = fixtureRegistration({ family: "lr", version: "1", artefact: fixtureArtefact({ trainedThroughTime: cutoff, kind: "logistic" }) });
    await expect(registerModel(prisma, same)).resolves.toMatchObject({ status: "ALREADY_REGISTERED" });
    await expect(registerModel(prisma, { ...same, hyperparameters: { lambda: 0.02 } })).rejects.toThrow(/REGISTRATION_CONFLICT/);
    await expect(registerModel(prisma, { ...same, artefact: fixtureArtefact({ trainedThroughTime: cutoff }) })).rejects.toThrow(/REGISTRATION_CONFLICT/);
  });
});
