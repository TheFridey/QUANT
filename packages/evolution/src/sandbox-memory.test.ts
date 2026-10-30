import { describe, expect, it } from "vitest";
import { compileStrategySource } from "./compile-strategy.js";
import { executeCompiledStrategy, isolationAvailable, probeIsolation } from "./sandbox-runner.js";

/** Audit M1: --max-old-space-size alone let a 512 MB ArrayBuffer succeed. */

async function allocate(mebibytes: number) {
  const compiled = compileStrategySource(`export function onBar() {
    const buffer = new ArrayBuffer(${mebibytes} * 1024 * 1024);
    new Uint8Array(buffer).fill(1);
    return { intent: "HOLD", reasonCodes: ["ALLOCATED"] };
  }`);
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
    metadata: { strategyId: "memory", version: "0", hypothesisId: "hyp" },
  });
}

const skipReason = isolationAvailable() ? "" : ` [skipped: isolation unavailable — ${probeIsolation().reason}]`;

describe.skipIf(!isolationAvailable())(`sandbox memory limit${skipReason}`, () => {
  it("reports an enforced address-space limit below 512 MiB of headroom", () => {
    const runner = probeIsolation();
    expect(runner.memoryEnforcement).toBe("rlimit-as");
    expect(runner.addressSpaceBytes).toBeGreaterThan(0);
    expect(runner.memoryMb).toBe(Math.floor((runner.addressSpaceBytes ?? 0) / (1024 * 1024)));
  });

  it("refuses a 512 MiB allocation", async () => {
    const result = await allocate(512);
    expect(result.ok).toBe(false);
    expect(result.code).not.toBe("EXECUTED");
    expect(result.signalsClaimed).toBe(false);
  });

  it("allows an 8 MiB allocation", async () => {
    const result = await allocate(8);
    expect(result.ok, result.error ?? "").toBe(true);
    expect(result.code).toBe("EXECUTED");
  });
});

const realisticStrategy = `export function onBar(input: any) {
  const closes = input.history.map((bar: any) => Number(bar.priceUsd)).filter((value: number) => Number.isFinite(value));
  const window = closes.slice(-20);
  const mean = window.length ? window.reduce((a: number, b: number) => a + b, 0) / window.length : 0;
  const state: Record<string, number> = { ...(input.state ?? {}) };
  state.seen = (state.seen ?? 0) + 1;
  for (let k = 0; k < 16; k += 1) state["band" + k] = Math.round(mean * 1000) + k;
  const price = Number(input.bar.priceUsd);
  const intent = window.length >= 20 && price > mean * 1.01 ? "ENTER_LONG" : "HOLD";
  return { intent, reasonCodes: [intent === "HOLD" ? "FLAT" : "ABOVE_MEAN", "H" + Math.min(closes.length, 256)], state };
}`;

describe.skipIf(!isolationAvailable())(`sandbox realistic workload${skipReason}`, () => {
  it("runs 300 bars with full 256-bar history and modest state under the default limits", async () => {
    const compiled = compileStrategySource(realisticStrategy);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const bars = Array.from({ length: 300 }, (_, index) => ({
      instrumentId: "solana:spot:universe",
      receivedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      priceUsd: String(1 + Math.sin(index / 7) / 10),
      liquidityUsd: "100000",
      volume24hUsd: "50000",
      priceChangeM5Pct: "0.4",
      priceChangeH1Pct: "1.2",
      txnsM5Buys: 12,
      txnsM5Sells: 9,
      dataState: "REPLAY",
    }));
    const started = Date.now();
    const result = await executeCompiledStrategy({
      javascript: compiled.javascript,
      artifactHash: compiled.artifactHash,
      bars,
      metadata: { strategyId: "realistic", version: "0", hypothesisId: "hyp" },
    });
    // Recorded so CI output shows the real cost of lock-step delivery.
    console.info(`[sandbox realistic workload] ${bars.length} bars in ${Date.now() - started} ms, code ${result.code}`);
    expect(result.ok, result.error ?? "").toBe(true);
    expect(result.signals).toHaveLength(300);
    expect(result.signals.at(-1)?.reasonCodes[1]).toBe("H256");
  });
});

describe.skipIf(!isolationAvailable())(`sandbox without /proc${skipReason}`, () => {
  // Evidence only: decides whether the /proc mount can be dropped. Asserts the outcome is reported, not its value.
  it("records whether the harness runs with no /proc mount", async () => {
    const compiled = compileStrategySource(`export function onBar() { return { intent: "HOLD", reasonCodes: ["NO_PROC"] }; }`);
    if (!compiled.ok) throw new Error(compiled.error);
    const result = await executeCompiledStrategy({
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
      metadata: { strategyId: "no-proc", version: "0", hypothesisId: "hyp" },
      mountProc: false,
    });
    console.info(`[sandbox without /proc] ok=${result.ok} code=${result.code} error=${result.error ?? ""}`);
    expect(typeof result.ok).toBe("boolean");
  });
});

describe("sandbox CI guard", () => {
  // CI installs bubblewrap and gcc, so the isolation suites must run there rather than skip.
  it.runIf(process.env.CI === "true")("has isolation with seccomp available in CI", () => {
    const runner = probeIsolation();
    expect(runner.available, runner.reason).toBe(true);
    expect(runner.seccomp, runner.seccompDetail).toBe("default-deny-errno");
  });
});
