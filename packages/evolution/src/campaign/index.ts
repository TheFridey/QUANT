/**
 * `@odin/evolution/campaign`: OPERATION EVIDENCE research campaigns. Research only. Imported through this
 * subpath (not the package root) so a campaign has no import path to order, execution, risk or promotion code
 * (campaign-imports.test.ts).
 */
export * from "./spec.js";
export * from "./accounting.js";
export * from "./evaluate.js";
export * from "./store.js";
export * from "./holdout.js";
export * from "./synthetic-fixtures.js";
export * from "./stages.js";
export * from "./bridge.js";
export * from "./view.js";
