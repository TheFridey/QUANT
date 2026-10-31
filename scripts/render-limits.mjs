// Audit F4: rewrite the generated limits tables in README.md and docs/ARCHITECTURE.md from
// DEFAULT_STRATEGY. Run `pnpm build:packages` first. CI fails on drift (limits-table.test.ts).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { replaceLimitsBlock } from "../packages/shared/dist/limits-table.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const file of ["README.md", "docs/ARCHITECTURE.md"]) {
  const path = resolve(root, file);
  const original = readFileSync(path, "utf8");
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const next = replaceLimitsBlock(original.replace(/\r\n/g, "\n")).replace(/\n/g, eol);
  if (next !== original) {
    writeFileSync(path, next);
    console.log(`updated ${file}`);
  }
}
