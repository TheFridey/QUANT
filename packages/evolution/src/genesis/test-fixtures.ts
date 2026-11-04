import { defaultFeatureSetSpec, featureSetSpecHash, ML2_PROTOCOL_VERSION, type Ml2Artefact, type ResearchBar } from "@odin/backtest/ml2";
import type { RegisterModelInput } from "./model-registry.js";

/** Deterministic fixtures for GENESIS tests (no I/O). */
export const HOUR = 3_600_000;

export function syntheticBars(count: number, lastOpen: number, barMs = HOUR, seed = 7): ResearchBar[] {
  let s = seed >>> 0;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const bars: ResearchBar[] = [];
  let close = 100;
  for (let i = 0; i < count; i += 1) {
    const open = close;
    close = Math.max(1, open * (1 + (rnd() - 0.5) * 0.02));
    const high = Math.max(open, close) * (1 + rnd() * 0.003);
    const low = Math.min(open, close) * (1 - rnd() * 0.003);
    bars.push({ t: lastOpen - (count - 1 - i) * barMs, open, high, low, close, volume: 1_000 + Math.floor(rnd() * 500) });
  }
  return bars;
}

/** A data-only artefact over the default feature set. `kind: "logistic"` uses one non-zero weight. */
export function fixtureArtefact(input: { barMs?: number; trainedThroughTime: number; kind?: "base" | "logistic"; p?: number; nullPolicy?: "DROP_ROW" | "IMPUTE_TRAIN_MEDIAN" }): Ml2Artefact {
  const barMs = input.barMs ?? HOUR;
  const spec = defaultFeatureSetSpec(barMs);
  const d = spec.features.length;
  const zeros = new Array<number>(d).fill(0);
  const ones = new Array<number>(d).fill(1);
  const preprocessor = { nullPolicy: input.nullPolicy ?? "IMPUTE_TRAIN_MEDIAN", medians: zeros, mean: zeros, sd: ones, rows: 500 } as const;
  const common = { protocol: ML2_PROTOCOL_VERSION, featureSetHash: featureSetSpecHash(spec), features: spec.features, preprocessor: { ...preprocessor, medians: [...zeros], mean: [...zeros], sd: [...ones] }, trainedThroughIndex: 499, trainedThroughTime: input.trainedThroughTime };
  if (input.kind === "logistic") {
    const weights = [...zeros];
    weights[0] = 0.01;
    return {
      ...common,
      family: "LOGISTIC_L2",
      model: { family: "V1", artefact: { family: "LOGISTIC_L2", featureSet: spec.name, features: spec.features, standardiser: { mean: [...zeros], sd: [...ones] }, weights, bias: 0.2, lambda: 0.01 } },
      calibrator: { method: "PLATT", a: 1, b: 0 },
    };
  }
  return { ...common, family: "BASE_RATE", model: { family: "BASE_RATE", p: input.p ?? 0.6 }, calibrator: { method: "NONE" } };
}

export const FIXTURE_DATASET_HASH = "a".repeat(64);

export function fixtureRegistration(input: { family: string; version: string; artefact: unknown; instrumentKeys?: string[]; barMs?: number; horizon?: number; entryThreshold?: number }): RegisterModelInput {
  return {
    family: input.family,
    version: input.version,
    artefact: input.artefact,
    datasetHashes: [FIXTURE_DATASET_HASH],
    labelDefinition: { horizon: input.horizon ?? 2, feeBpsPerSide: 10, slippageBpsPerSide: 5, stopPct: null, targetPct: null },
    hyperparameters: { lambda: 0.01 },
    trainingProtocol: { protocol: ML2_PROTOCOL_VERSION, target: "NET_POSITIVE", shadow: { barMs: input.barMs ?? HOUR, instrumentKeys: input.instrumentKeys ?? ["TEST:GENESIS"], entryThreshold: input.entryThreshold ?? 0.55, lookbackBars: 600, maxAbsZ: 1e12 } },
    validation: { verdict: "CANDIDATE", walkForwardBrier: 0.24, shadowPayoff: { meanNetIfPositive: 0.01, meanNetIfNotPositive: -0.008 } },
    evidenceLinks: ["docs/genesis/DEPLOY_REGISTRY_SHADOW.md"],
    codeCommit: "a4e7b52",
    hypothesisId: null,
    registeredBy: "genesis-test",
  };
}
