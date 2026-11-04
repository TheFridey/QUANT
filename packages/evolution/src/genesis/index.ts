/**
 * `@odin/evolution/genesis`: GENESIS Phase 5 model registry and Phase 6 shadow predictions. Research only.
 * Imported by the worker through this subpath (not the package root) so the shadow job's import graph stays
 * free of order, execution, risk and promotion code (shadow-imports.test.ts).
 */
export * from "./canonical.js";
export * from "./model-lifecycle.js";
export * from "./model-artefact.js";
export * from "./model-registry.js";
export * from "./shadow-config.js";
export * from "./shadow.js";
export * from "./shadow-leaderboard.js";
export * from "./warehouse-bars.js";
