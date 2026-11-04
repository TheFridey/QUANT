import { ML2_PROTOCOL_VERSION, type Ml2Artefact } from "@odin/backtest/ml2";
import { z } from "zod";

/**
 * Strict data-only schema for an ML 2.0 artefact. Loading a model only parses JSON numbers and strings into
 * this shape: unknown keys are refused, nothing is evaluated, and tree indices are checked so prediction
 * always terminates. Anything that is not coefficients, trees or calibrator parameters is rejected.
 */
const num = z.number();
const nums = z.array(num).max(100_000);
const featureNames = z.array(z.string().min(1).max(128)).min(1).max(512);

const standardiser = z.strictObject({ mean: nums, sd: nums });

const v1Artefact = z.discriminatedUnion("family", [
  z.strictObject({ family: z.literal("BASE_RATE"), featureSet: z.string().max(256), p: num.min(0).max(1) }),
  z.strictObject({ family: z.literal("LOGISTIC_L2"), featureSet: z.string().max(256), features: featureNames, standardiser, weights: nums, bias: num, lambda: num }),
  z.strictObject({
    family: z.literal("BOOSTED_STUMPS"),
    featureSet: z.string().max(256),
    features: featureNames,
    standardiser,
    base: num,
    rate: num,
    stumps: z.array(z.strictObject({ feature: z.int().min(0), threshold: num, left: num, right: num })).max(10_000),
  }),
]);

const treeNode = z.strictObject({ f: z.int().min(-1), th: num, l: z.int().min(-1), r: z.int().min(-1), v: num });

const forest = z.strictObject({
  family: z.literal("RANDOM_FOREST"),
  trees: z.array(z.array(treeNode).min(1).max(20_000)).min(1).max(2_000),
  params: z.strictObject({ trees: z.int(), maxDepth: z.int(), minLeaf: num, sampleFraction: num, featuresPerSplit: num, thresholds: num, seed: num }),
});

const calibrator = z.discriminatedUnion("method", [
  z.strictObject({ method: z.literal("NONE") }),
  z.strictObject({ method: z.literal("PLATT"), a: num, b: num }),
  z.strictObject({ method: z.literal("ISOTONIC"), x: nums, y: nums }),
]);

const ml2ArtefactSchema = z.strictObject({
  protocol: z.literal(ML2_PROTOCOL_VERSION),
  family: z.enum(["BASE_RATE", "LOGISTIC_L2", "BOOSTED_STUMPS", "RANDOM_FOREST"]),
  featureSetHash: z.string().regex(/^[a-f0-9]{64}$/),
  features: featureNames,
  preprocessor: z.strictObject({ nullPolicy: z.enum(["DROP_ROW", "IMPUTE_TRAIN_MEDIAN"]), medians: nums, mean: nums, sd: nums, rows: z.int().min(0) }),
  model: z.discriminatedUnion("family", [
    z.strictObject({ family: z.literal("BASE_RATE"), p: num.min(0).max(1) }),
    z.strictObject({ family: z.literal("V1"), artefact: v1Artefact }),
    z.strictObject({ family: z.literal("RANDOM_FOREST"), forest }),
  ]),
  calibrator,
  trainedThroughIndex: z.int().min(0),
  trainedThroughTime: num,
});

export class ArtefactValidationError extends Error {
  constructor(message: string) {
    super(`invalid ML2 artefact: ${message}`);
    this.name = "ArtefactValidationError";
  }
}

/** Parses untrusted JSON into an Ml2Artefact, or throws ArtefactValidationError. Never evaluates anything. */
export function parseMl2Artefact(value: unknown): Ml2Artefact {
  const parsed = ml2ArtefactSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ArtefactValidationError(`${first?.path.join(".") || "(root)"}: ${first?.message ?? "schema mismatch"}`);
  }
  const a = parsed.data as Ml2Artefact;
  const d = a.features.length;
  const p = a.preprocessor;
  if (p.medians.length !== d || p.mean.length !== d || p.sd.length !== d) throw new ArtefactValidationError("preprocessor width differs from features");
  if (p.sd.some((s) => !(s > 0))) throw new ArtefactValidationError("preprocessor sd must be positive");
  if (a.model.family === "V1") {
    const v1 = a.model.artefact;
    if (v1.family === "LOGISTIC_L2" && (v1.weights.length !== d || v1.standardiser.mean.length !== d || v1.standardiser.sd.length !== d)) {
      throw new ArtefactValidationError("logistic width differs from features");
    }
    if (v1.family === "BOOSTED_STUMPS" && (v1.standardiser.mean.length !== d || v1.standardiser.sd.length !== d || v1.stumps.some((s) => s.feature >= d))) {
      throw new ArtefactValidationError("stump feature index out of range");
    }
  }
  if (a.model.family === "RANDOM_FOREST") {
    a.model.forest.trees.forEach((nodes, t) => {
      nodes.forEach((n, id) => {
        if (n.f === -1) return;
        // Children always come after their parent (pre-order growth), so a walk from the root terminates.
        if (n.f >= d || n.l <= id || n.r <= id || n.l >= nodes.length || n.r >= nodes.length) {
          throw new ArtefactValidationError(`tree ${t} node ${id} has an invalid split or child index`);
        }
      });
    });
  }
  if (a.calibrator.method === "ISOTONIC" && a.calibrator.x.length !== a.calibrator.y.length) throw new ArtefactValidationError("isotonic x and y differ in length");
  if (a.family === "BASE_RATE" ? a.model.family !== "BASE_RATE" : a.family === "RANDOM_FOREST" ? a.model.family !== "RANDOM_FOREST" : a.model.family !== "V1") {
    throw new ArtefactValidationError(`model body ${a.model.family} does not match family ${a.family}`);
  }
  return a;
}
