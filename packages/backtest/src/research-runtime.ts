/**
 * `@odin/backtest/research`: the pure HORIZON / ASCEND / ML 2.0 research surface, without the backtest engine.
 *
 * The package root re-exports `engine.ts`, which imports `@odin/trading-engine`. Research campaign code imports
 * this entry instead, so a campaign evaluation has no import path to order or execution code (asserted by
 * packages/evolution/src/campaign/campaign-imports.test.ts). Keep every export here free of such imports.
 */
export * from "./research/simulate.js";
export * from "./research/metrics.js";
export * from "./research/strategies.js";
export * from "./research/validate.js";
export * from "./research/regime.js";
export * from "./research/features.js";
export * from "./research/labels.js";
export * from "./research/feature-set.js";
export * from "./research/ml2-learners.js";
export * from "./research/ml2-eval.js";
export * from "./research/ml2.js";
export * from "./research/sessions.js";
export * from "./research/market-config.js";
export * from "./research/horizon-strategies.js";
export * from "./research/horizon-verdict.js";
export * from "./research/horizon.js";
export { seededRng } from "./stats.js";
