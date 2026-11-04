import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static guard: the GENESIS registry/shadow module and its worker job have no import path (value or type) to
 * order submission, execution, risk, venue/broker or promotion code. Walks the real transitive import graph.
 */
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const WORKSPACE: Record<string, string> = {
  "@odin/backtest/ml2": "packages/backtest/src/ml2-runtime.ts",
  "@odin/evolution/genesis": "packages/evolution/src/genesis/index.ts",
  "@odin/shared/db": "packages/shared/src/db.ts",
};
const ALLOWED_EXTERNAL = [/^node:/, /^zod$/, /^@prisma\/client$/, /^@nestjs\/(bullmq|common)$/, /^bullmq$/, /^pino$/];
const FORBIDDEN_FILE = /(trading-engine|risk-engine|market-data|execution|venue|broker|promotion|order|fill|ledger|engine\.ts$)/i;

function importsOf(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g)) out.push(m[1]!);
  for (const m of src.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)) out.push(m[1]!);
  for (const m of src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]!);
  return out;
}

function walk(entries: string[]) {
  const seen = new Set<string>();
  const external = new Set<string>();
  const problems: string[] = [];
  const stack = entries.map((e) => resolve(repo, e));
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of importsOf(file)) {
      let target: string | null = null;
      if (spec.startsWith(".")) target = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
      else if (WORKSPACE[spec]) target = resolve(repo, WORKSPACE[spec]);
      else if (spec.startsWith("@odin/")) problems.push(`${relative(repo, file)} imports ${spec}`);
      else if (!ALLOWED_EXTERNAL.some((re) => re.test(spec))) problems.push(`${relative(repo, file)} imports external ${spec}`);
      else external.add(spec);
      if (target) {
        if (!existsSync(target)) problems.push(`${relative(repo, file)} imports missing ${spec}`);
        else stack.push(target);
      }
    }
  }
  for (const f of seen) if (FORBIDDEN_FILE.test(relative(repo, f).replace(/\\/g, "/"))) problems.push(`reachable: ${relative(repo, f)}`);
  return { seen: [...seen].map((f) => relative(repo, f).replace(/\\/g, "/")), external: [...external], problems };
}

describe("GENESIS shadow import boundary", () => {
  it("the genesis module and the worker job reach no trading, order, risk, execution or promotion code", () => {
    const graph = walk(["packages/evolution/src/genesis/index.ts", "apps/worker/src/genesis-shadow.ts"]);
    expect(graph.problems).toEqual([]);
    expect(graph.seen).toContain("packages/backtest/src/research/ml2.ts");
    expect(graph.seen).not.toContain("packages/backtest/src/index.ts");
    expect(graph.seen).not.toContain("packages/evolution/src/index.ts");
  });

  it("the walker does catch a forbidden import (self-test)", () => {
    const graph = walk(["packages/backtest/src/index.ts"]);
    expect(graph.problems.some((p) => p.includes("@odin/trading-engine") || p.includes("engine.ts"))).toBe(true);
  });
});
