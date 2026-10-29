#!/usr/bin/env node
/**
 * §33 Engine soak entrypoint.
 * Prefer the Vitest integration (resolves @odin/* aliases):
 *
 *   DATABASE_URL_TEST=postgresql://odin:odin@127.0.0.1:5432/odin_test \
 *   SOAK_SECONDS=10 pnpm exec vitest run apps/worker/src/engine-soak.integration.test.ts
 */
console.log(
  JSON.stringify(
    {
      ok: false,
      redirect: true,
      command:
        "SOAK_SECONDS=10 pnpm exec vitest run apps/worker/src/engine-soak.integration.test.ts",
      note: "Use the Vitest StageRunner+Postgres soak; this wrapper does not execute the engine.",
    },
    null,
    2,
  ),
);
process.exit(2);
