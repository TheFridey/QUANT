import { defineConfig, devices } from "@playwright/test";

/**
 * Gate 1 browser E2E against a manually started stack:
 *   Postgres+Redis, `pnpm db:deploy`, `pnpm --filter @odin/api --filter @odin/worker --filter @odin/web dev`
 * baseURL web :4317 · API :4318
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:4317",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  outputDir: "test-results",
  webServer: undefined,
});
