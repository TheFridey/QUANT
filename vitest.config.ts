import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL(".", import.meta.url));

const alias = [
  { find: /^@odin\/shared\/db$/, replacement: resolve(root, "packages/shared/src/db.ts") },
  {
    find: /^@odin\/shared\/bootstrap$/,
    replacement: resolve(root, "packages/shared/src/bootstrap.ts"),
  },
  { find: /^@odin\/shared$/, replacement: resolve(root, "packages/shared/src/index.ts") },
  { find: /^@odin\/market-data$/, replacement: resolve(root, "packages/market-data/src/index.ts") },
  { find: /^@odin\/risk-engine$/, replacement: resolve(root, "packages/risk-engine/src/index.ts") },
  {
    find: /^@odin\/trading-engine$/,
    replacement: resolve(root, "packages/trading-engine/src/index.ts"),
  },
  { find: /^@odin\/agent-core$/, replacement: resolve(root, "packages/agent-core/src/index.ts") },
  { find: /^@odin\/analytics$/, replacement: resolve(root, "packages/analytics/src/index.ts") },
  { find: /^@odin\/backtest$/, replacement: resolve(root, "packages/backtest/src/index.ts") },
  { find: /^@odin\/evolution$/, replacement: resolve(root, "packages/evolution/src/index.ts") },
];

/**
 * Unit tests stay parallel. DB-mutating *.integration.test.ts files run in a
 * single-fork serial project sharing INTEGRATION_TEST_ADVISORY_LOCK (641099)
 * so suites cannot truncate EngineControl / StrategyInstance mid-assertion.
 */
export default defineConfig({
  resolve: { alias },
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          environment: "node",
          setupFiles: ["./vitest.setup.ts"],
          include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
          exclude: ["**/*.integration.test.ts", "**/node_modules/**"],
          testTimeout: 30000,
          hookTimeout: 30000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          environment: "node",
          setupFiles: ["./vitest.setup.ts"],
          include: ["packages/**/*.integration.test.ts", "apps/**/*.integration.test.ts"],
          exclude: ["**/node_modules/**"],
          fileParallelism: false,
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 60000,
          hookTimeout: 60000,
        },
      },
    ],
  },
});
