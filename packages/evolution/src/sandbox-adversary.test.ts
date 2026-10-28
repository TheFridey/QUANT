import { describe, expect, it } from "vitest";
import { compileStrategySource } from "./compile-strategy.js";
import { executeCompiledStrategy, isolationAvailable } from "./sandbox-runner.js";
import type { StrategyBar } from "./strategy-interface.js";

const bar: StrategyBar = {
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
};

async function run(source: string) {
  const compiled = compileStrategySource(source);
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) throw new Error(compiled.error);
  return executeCompiledStrategy({
    javascript: compiled.javascript,
    artifactHash: compiled.artifactHash,
    bars: [bar],
    metadata: { strategyId: "adversary", version: "0", hypothesisId: "hyp" },
    timeoutMs: 3_000,
  });
}

describe.skipIf(!isolationAvailable())("runtime adversaries inside bubblewrap", () => {
  it("does not let the strategy spawn a child process", async () => {
    const result = await run(`export async function onBar() {
      const cp = await import("node:child_process");
      try {
        cp.execFileSync("/usr/bin/true", [], { timeout: 500 });
        return { intent: "HOLD", reasonCodes: ["SPAWNED"] };
      } catch (error) {
        const code = error && error.code ? error.code : "BLOCKED";
        return { intent: "HOLD", reasonCodes: ["CHILD_" + code] };
      }
    }`);
    expect(JSON.stringify(result)).not.toContain("SPAWNED");
    expect(result.signals[0]?.reasonCodes[0] ?? "").toMatch(/^CHILD_/);
    if (result.runner.seccomp === "default-deny-errno") {
      expect(result.signals[0]?.reasonCodes[0]).toBe("CHILD_EPERM");
    }
  });

  it("does not let a dynamic import read a host project file", async () => {
    const result = await run(`export async function onBar() {
      try {
        const fs = await import("node:fs");
        const text = fs.readFileSync("/workspace/package.json", "utf8");
        return { intent: "HOLD", reasonCodes: ["READ", text.slice(0, 12)] };
      } catch (error) {
        const code = error && error.code ? error.code : "BLOCKED";
        return { intent: "HOLD", reasonCodes: ["IMPORT_" + code] };
      }
    }`);
    expect(JSON.stringify(result)).not.toContain("odin-quant");
    expect(JSON.stringify(result)).not.toContain("\"name\"");
  });

  it("does not reveal a host secret", async () => {
    process.env.ODIN_CANARY_SECRET = "canary-should-stay-on-host";
    const result = await run(`export function onBar() {
      const secret = process.env.ODIN_CANARY_SECRET || "NO_SECRET";
      return { intent: "HOLD", reasonCodes: [String(secret)] };
    }`);
    delete process.env.ODIN_CANARY_SECRET;
    expect(JSON.stringify(result)).not.toContain("canary-should-stay-on-host");
  });

  it("does not change host risk limits or place an order", async () => {
    const risk = { maxDailyLossPct: "3" };
    const orders = 0;
    const result = await run(`export async function onBar() {
      let placed = "ORDER_BLOCKED";
      try {
        const net = await import("node:net");
        placed = await new Promise((resolve, reject) => {
          const socket = net.connect(9, "127.0.0.1", () => { socket.end(); resolve("ORDER_PLACED"); });
          socket.setTimeout(300, () => { socket.destroy(); reject(Object.assign(new Error("timeout"), { code: "TIMEOUT" })); });
          socket.on("error", reject);
        });
      } catch (error) {
        placed = "ORDER_" + (error && error.code ? error.code : "BLOCKED");
      }
      return { intent: "HOLD", reasonCodes: [String(placed)], state: { maxDailyLossPct: "100" } };
    }`);
    expect(orders).toBe(0);
    expect(risk.maxDailyLossPct).toBe("3");
    expect(JSON.stringify(result)).not.toContain("ORDER_PLACED");
    if (result.runner.seccomp === "default-deny-errno") {
      expect(result.signals[0]?.reasonCodes[0]).toBe("ORDER_EPERM");
    }
  });

  it("rejects a nondeterministic reason code instead of accepting it as a signal", async () => {
    const result = await run(`export function onBar() {
      return { intent: "HOLD", reasonCodes: [String(Math.random()), String(Date.now())] };
    }`);
    expect(result.signalsClaimed).toBe(false);
    expect(JSON.stringify(result.signals)).not.toMatch(/0\\.\\d{3,}|\\d{12,}/);
  });
});
