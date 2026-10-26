import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
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
    ],
  },
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
