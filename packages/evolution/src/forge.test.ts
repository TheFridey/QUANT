import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hypothesis } from "@odin/shared";
import { sha256 } from "./compile-strategy.js";
import { destroyForgeWorkspace, forgeStrategyModule, staticCheck } from "./forge.js";
import { executeCompiledStrategy, isolationAvailable, probeIsolation } from "./sandbox-runner.js";
import { compileStrategySource } from "./compile-strategy.js";

const hypothesis: Hypothesis = {
  title: "Liquid M5 thrust continuation",
  market: "SPOT_CRYPTO_PAIR",
  instrumentIds: ["solana:spot:universe"],
  conditions: "LIVE quote with liquidity floor",
  claimedAdvantage: "Short-horizon continuation",
  entryRules: "M5 in band",
  exitRules: "Stop or fade",
  riskRules: "ATLAS caps",
  rationale: "Package existing pulse rule",
  successCriteria: "OOS n>=30",
  failureModes: "Regime shift",
  status: "OPEN",
  id: "hyp_test_1",
};

const holdSource = `export function onBar(input) {
  if (!input.bar.priceUsd) return { intent: "HOLD", reasonCodes: ["NO_PRICE"] };
  return { intent: "HOLD", reasonCodes: ["FLAT"] };
}
`;

const enterSource = `export function onBar(input) {
  const change = Number(input.bar.priceChangeM5Pct);
  if (Number.isFinite(change) && change > 0) return { intent: "ENTER_LONG", reasonCodes: ["UP"], confidence: 0.4 };
  return { intent: "HOLD", reasonCodes: ["FLAT"] };
}
`;

describe("static source gate", () => {
  it("rejects credentials, risk overrides, and direct order placement", () => {
    const evil = `
import fs from "fs";
process.env.DATABASE_URL;
function overrideRisk() {}
placeOrder({ real_money: true });
`;
    const findings = staticCheck(evil);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.join("\n")).toMatch(/STATIC|ENV_ACCESS|FILESYSTEM|ORDER_PLACEMENT|RISK_MUTATION|MODULE_IMPORT/);
  });

  it("names itself as a static gate and does not claim runtime isolation", async () => {
    const result = await forgeStrategyModule({
      hypothesis,
      source: `import { exec } from "node:child_process";
export function onBar() { return { intent: "HOLD", reasonCodes: ["X"] }; }`,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("STATIC_REJECT");
    expect(result.signalsClaimed).toBe(false);
    expect(result.integrity.executionResult).toBe("STATIC_REJECT");
  });
});

describe("forge execution", () => {
  it("refuses to claim signals when isolation is disabled", async () => {
    const result = await forgeStrategyModule({
      hypothesis,
      source: enterSource,
      isolation: "disabled",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ISOLATION_DISABLED");
    expect(result.signalsClaimed).toBe(false);
    expect(result.integrity.signalsClaimed).toBe(false);
    expect(result.integrity.compiledArtifactHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("runs the compiled template inside the sandbox when isolation is available", async () => {
    if (!isolationAvailable()) {
      expect(probeIsolation().available).toBe(false);
      return;
    }
    const result = await forgeStrategyModule({ hypothesis });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provenance).toBe("TEMPLATE");
    expect(result.integrity.modelIdentifier).toBe("TEMPLATE");
    expect(result.signals[0]?.reasonCodes).toContain("TEMPLATE");
    expect(result.signals[0]?.reasonCodes.join(" ")).not.toContain("TEMPLATE_M5_ENTRY");
    expect(result.integrity.compiledArtifactHash).toBe(result.artifactHash);
    expect(result.integrity.testOutcomes.find((row) => row.name === "artifact_hash_matches_execution")?.status).toBe("PASS");
    const executed = readFileSync(join(result.workspacePath, "strategy.js"), "utf8");
    expect(sha256(executed)).toBe(result.artifactHash);
    destroyForgeWorkspace(result.workspacePath);
  });

  it("changes signals when strategy decision logic changes", async () => {
    if (!isolationAvailable()) return;
    const flat = await forgeStrategyModule({ hypothesis, source: holdSource });
    const up = await forgeStrategyModule({ hypothesis, source: enterSource, version: "0.1.1" });
    expect(flat.ok && up.ok).toBe(true);
    if (!flat.ok || !up.ok) return;
    expect(flat.sourceHash).not.toBe(up.sourceHash);
    expect(flat.signals[0]?.intent).toBe("HOLD");
    expect(up.signals[0]?.intent).toBe("ENTER_LONG");
    destroyForgeWorkspace(flat.workspacePath);
    destroyForgeWorkspace(up.workspacePath);
  });

  it("withholds future bars from the strategy history", async () => {
    if (!isolationAvailable()) return;
    const source = `export function onBar(input) {
      const future = input.history.some((bar) => Date.parse(bar.receivedAt) > Date.parse(input.bar.receivedAt));
      return { intent: "HOLD", reasonCodes: [future ? "SAW_FUTURE" : "PAST_ONLY", "H" + input.history.length] };
    }`;
    const result = await forgeStrategyModule({
      hypothesis,
      source,
      bars: [
        {
          instrumentId: "solana:spot:universe",
          receivedAt: "2026-01-01T00:00:00.000Z",
          priceUsd: "1",
          liquidityUsd: "10",
          volume24hUsd: "10",
          priceChangeM5Pct: "1",
          priceChangeH1Pct: "1",
          txnsM5Buys: 1,
          txnsM5Sells: 1,
          dataState: "REPLAY",
        },
        {
          instrumentId: "solana:spot:universe",
          receivedAt: "2026-01-01T00:05:00.000Z",
          priceUsd: "2",
          liquidityUsd: "10",
          volume24hUsd: "10",
          priceChangeM5Pct: "1",
          priceChangeH1Pct: "1",
          txnsM5Buys: 1,
          txnsM5Sells: 1,
          dataState: "REPLAY",
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.signals.map((signal) => signal.reasonCodes[0])).toEqual(["PAST_ONLY", "PAST_ONLY"]);
    expect(result.signals.map((signal) => signal.reasonCodes[1])).toEqual(["H0", "H1"]);
    destroyForgeWorkspace(result.workspacePath);
  });
});

describe.skipIf(!isolationAvailable())("runtime containment", () => {
  async function run(source: string) {
    const compiled = compileStrategySource(source);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error(compiled.error);
    return executeCompiledStrategy({
      javascript: compiled.javascript,
      artifactHash: compiled.artifactHash,
      bars: [
        {
          instrumentId: "solana:spot:universe",
          receivedAt: "2026-01-01T00:00:00.000Z",
          priceUsd: "1",
          liquidityUsd: "10",
          volume24hUsd: "10",
          priceChangeM5Pct: null,
          priceChangeH1Pct: null,
          txnsM5Buys: null,
          txnsM5Sells: null,
          dataState: "REPLAY",
        },
      ],
      metadata: { strategyId: "contain", version: "0", hypothesisId: "hyp" },
      timeoutMs: 3_000,
    });
  }

  it("does not expose host environment variables inside the sandbox", async () => {
    process.env.ODIN_CANARY_SECRET = "canary-should-stay-on-host";
    const result = await run(`export function onBar() {
      return { intent: "HOLD", reasonCodes: [String(process.env.ODIN_CANARY_SECRET)] };
    }`);
    delete process.env.ODIN_CANARY_SECRET;
    expect(JSON.stringify(result)).not.toContain("canary-should-stay-on-host");
    if (result.signalsClaimed) {
      expect(result.signals[0]?.reasonCodes[0]).toBe("undefined");
    }
  });

  it("contains filesystem reads, child processes, and network connects", async () => {
    process.env.ODIN_CANARY_SECRET = "canary-should-stay-on-host";
    const result = await run(`export async function onBar() {
      const fs = await import("node:fs");
      const net = await import("node:net");
      const cp = await import("node:child_process");
      let file = "FS_BLOCKED";
      try { file = fs.readFileSync("/workspace/package.json", "utf8").slice(0, 12); } catch (error) { file = "FS_" + (error && error.code ? error.code : "BLOCKED"); }
      let child = "CHILD_BLOCKED";
      try { child = String(cp.execFileSync("/node", ["-e", "process.stdout.write(String(process.env.ODIN_CANARY_SECRET||'none'))"], { encoding: "utf8" })); } catch (error) { child = "CHILD_" + (error && error.code ? error.code : "BLOCKED"); }
      let network = "NET_BLOCKED";
      try {
        network = await new Promise((resolve, reject) => {
          const socket = net.connect(443, "1.1.1.1", () => { socket.end(); resolve("CONNECTED"); });
          socket.setTimeout(500, () => { socket.destroy(); reject(Object.assign(new Error("timeout"), { code: "TIMEOUT" })); });
          socket.on("error", reject);
        });
      } catch (error) { network = "NET_" + (error && error.code ? error.code : "BLOCKED"); }
      return { intent: "HOLD", reasonCodes: [String(file), String(child), String(network)] };
    }`);
    delete process.env.ODIN_CANARY_SECRET;
    const blob = JSON.stringify(result);
    expect(blob).not.toContain("canary-should-stay-on-host");
    expect(blob).not.toContain("odin-quant");
    expect(blob).not.toContain("CONNECTED");
    if (result.ok) {
      expect(result.signals[0]?.reasonCodes[0]?.startsWith("FS_")).toBe(true);
      expect(result.signals[0]?.reasonCodes[2]?.startsWith("NET_")).toBe(true);
    }
  });

  it("terminates infinite loops without claiming signals", async () => {
    const result = await run(`export function onBar() { while (true) {} return { intent: "HOLD", reasonCodes: ["NEVER"] }; }`);
    expect(result.ok).toBe(false);
    expect(result.signalsClaimed).toBe(false);
    expect(result.timedOut || result.contained).toBe(true);
  });

  it("contains excessive allocation", async () => {
    const result = await run(`export function onBar() {
      const bags = [];
      while (true) bags.push(new Array(1_000_000).fill("x"));
      return { intent: "HOLD", reasonCodes: ["ALLOC"] };
    }`);
    expect(result.signalsClaimed).toBe(false);
    expect(result.ok).toBe(false);
  });
});
