/**
 * `@odin/backtest/ml2`: the pure ML 2.0 inference and labelling surface, without the backtest engine.
 *
 * The package root re-exports `engine.ts`, which imports `@odin/trading-engine`. GENESIS shadow code imports
 * this entry instead, so it has no import path to order or execution code (asserted by
 * packages/evolution/src/genesis/shadow-imports.test.ts). Keep every export here free of such imports.
 */
export { ML2_PROTOCOL_VERSION, ml2Abstention, predictMl2, type Ml2Artefact, type LearnerFamily } from "./research/ml2.js";
export { blockBootstrapInterval, type BootstrapInterval } from "./research/ml2-eval.js";
export { transformRow, type Calibrator, type ForestArtefact, type Preprocessor } from "./research/ml2-learners.js";
export { buildTradeLabels, costPerSideFraction, labelSpecHash, LABELS_VERSION, type LabelSpec, type TradeLabel } from "./research/labels.js";
export { buildDefaultFeatureRows, defaultFeatureSetSpec, featureSetSpecHash, validateResearchBars, type FeatureSetSpec } from "./research/feature-set.js";
export { calibration, psi, type ModelArtefact } from "./research/ml.js";
export type { ResearchBar } from "./research/simulate.js";
