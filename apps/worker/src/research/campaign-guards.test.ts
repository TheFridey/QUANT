import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { campaignEveryMs, campaignMaxUnits, campaignWorkerEnabled, runCampaignTick } from "../campaign-job.js";
import { currentCodeVersion } from "./campaign-runner.js";
import { installNetworkBlock } from "./network-guard.js";

describe("evaluator network block", () => {
  const originalConnect = net.Socket.prototype.connect;
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    net.Socket.prototype.connect = originalConnect;
    globalThis.fetch = originalFetch;
  });

  it("refuses sockets and fetch once installed, and counts the attempts", async () => {
    const guard = installNetworkBlock();
    await expect(fetch("http://127.0.0.1:9/")).rejects.toThrow(/NETWORK_BLOCKED/);
    expect(() => net.connect(9, "127.0.0.1")).toThrow(/NETWORK_BLOCKED/);
    expect(() => new net.Socket().connect(5432, "127.0.0.1")).toThrow(/NETWORK_BLOCKED/);
    expect(guard.blocked()).toBe(3);
  });
});

describe("campaign worker job", () => {
  it("is off unless the flag is exactly true, and then starts nothing", async () => {
    for (const value of [undefined, "", "1", "TRUE", "yes", "false"]) expect(campaignWorkerEnabled({ RESEARCH_CAMPAIGN_WORKER_ENABLED: value })).toBe(false);
    expect(campaignWorkerEnabled({ RESEARCH_CAMPAIGN_WORKER_ENABLED: "true" })).toBe(true);
    // A CLI path that does not exist proves no process is started while disabled.
    expect(await runCampaignTick({}, { cliPath: "/nonexistent/campaign-cli.js" })).toEqual({ status: "DISABLED" });
  });

  it("clamps its cadence and units per tick", () => {
    expect(campaignEveryMs({})).toBe(60_000);
    expect(campaignEveryMs({ RESEARCH_CAMPAIGN_TICK_MS: "5" })).toBe(60_000);
    expect(campaignEveryMs({ RESEARCH_CAMPAIGN_TICK_MS: "120000" })).toBe(120_000);
    expect(campaignMaxUnits({})).toBe(1);
    expect(campaignMaxUnits({ RESEARCH_CAMPAIGN_MAX_UNITS: "500" })).toBe(1);
    expect(campaignMaxUnits({ RESEARCH_CAMPAIGN_MAX_UNITS: "3" })).toBe(3);
  });

  it("runs the campaign CLI as a separate process and stops one that overruns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "odin-campaign-job-"));
    const quick = join(dir, "quick.js");
    writeFileSync(quick, `console.log(JSON.stringify({ argv: process.argv.slice(2), pid: process.pid }));`);
    const env = { ...process.env, RESEARCH_CAMPAIGN_WORKER_ENABLED: "true", RESEARCH_CAMPAIGN_MAX_UNITS: "2" };
    const ran = await runCampaignTick(env, { cliPath: quick });
    if (ran.status !== "RAN") throw new Error("expected RAN");
    expect(ran.exitCode).toBe(0);
    const out = JSON.parse(ran.output) as { argv: string[]; pid: number };
    expect(out.argv).toEqual(["work-next", "--max-units", "2"]);
    expect(out.pid).not.toBe(process.pid);

    const hang = join(dir, "hang.js");
    writeFileSync(hang, `setInterval(() => {}, 1000);`);
    const started = Date.now();
    const killed = await runCampaignTick(env, { cliPath: hang, ceilingMs: 300 });
    expect(killed).toMatchObject({ status: "RAN", timedOut: true });
    // The child runs at low priority, so allow for a host whose cores are all busy.
    expect(Date.now() - started).toBeLessThan(60_000);
  }, 180_000);
});

describe("code version pinning", () => {
  it("accepts an explicit commit and nothing that is not one", () => {
    expect(currentCodeVersion({ GIT_COMMIT: "0123abc" }, tmpdir())).toBe("0123abc");
    // Not a git checkout and no usable GIT_COMMIT: unpinned.
    const dir = mkdtempSync(join(tmpdir(), "odin-not-git-"));
    expect(currentCodeVersion({ GIT_COMMIT: "unknown" }, dir)).toBeNull();
  });
});

/**
 * Static guard: campaign code (library, CLI, evaluator, worker job) has no import path, value or type, to order
 * submission, execution, risk, venue/broker or promotion code. Walks the real transitive import graph.
 */
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const WORKSPACE: Record<string, string> = {
  "@odin/backtest/ml2": "packages/backtest/src/ml2-runtime.ts",
  "@odin/backtest/research": "packages/backtest/src/research-runtime.ts",
  "@odin/evolution/genesis": "packages/evolution/src/genesis/index.ts",
  "@odin/evolution/campaign": "packages/evolution/src/campaign/index.ts",
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
      if (target) {
        if (!existsSync(target)) problems.push(`${relative(repo, file)} imports missing ${spec}`);
        else stack.push(target);
      }
    }
  }
  const files = [...seen].map((f) => relative(repo, f).replace(/\\/g, "/"));
  // The research ledgers are named for what they are; the trading ledger is the forbidden one.
  for (const f of files) if (FORBIDDEN_FILE.test(f)) problems.push(`reachable: ${f}`);
  return { files, problems };
}

describe("campaign import boundary", () => {
  it("campaign code reaches no trading, order, risk, execution or promotion code", () => {
    const graph = walk(["packages/evolution/src/campaign/index.ts", "apps/worker/src/research/campaign-cli.ts", "apps/worker/src/research/campaign-evaluator.ts", "apps/worker/src/campaign-job.ts"]);
    expect(graph.problems).toEqual([]);
    expect(graph.files).toContain("packages/backtest/src/research/horizon.ts");
    expect(graph.files).toContain("packages/evolution/src/genesis/shadow.ts");
    expect(graph.files).not.toContain("packages/backtest/src/index.ts");
    expect(graph.files).not.toContain("packages/evolution/src/index.ts");
  });

  it("the walker does catch a forbidden import (self-test)", () => {
    expect(walk(["packages/backtest/src/index.ts"]).problems.length).toBeGreaterThan(0);
  });
});
