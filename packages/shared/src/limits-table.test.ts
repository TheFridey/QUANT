import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY } from "./strategy.js";
import { renderLimitsTable, replaceLimitsBlock } from "./limits-table.js";

/** Audit F4: docs limits tables must match DEFAULT_STRATEGY. Fix drift with `node scripts/render-limits.mjs`. */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("generated limits tables (audit F4)", () => {
  for (const file of ["README.md", "docs/ARCHITECTURE.md"]) {
    it(`${file} matches DEFAULT_STRATEGY`, () => {
      const markdown = readFileSync(resolve(root, file), "utf8").replace(/\r\n/g, "\n");
      expect(replaceLimitsBlock(markdown), `${file} is stale: run node scripts/render-limits.mjs`).toBe(markdown);
    });
  }

  it("renders the authoritative values", () => {
    const table = renderLimitsTable();
    expect(table).toContain(`| \`maxPositions\` | \`${DEFAULT_STRATEGY.maxPositions}\` |`);
    expect(table).toContain(`| \`startingBalanceUsd\` | \`${DEFAULT_STRATEGY.startingBalanceUsd}\` |`);
  });
});
