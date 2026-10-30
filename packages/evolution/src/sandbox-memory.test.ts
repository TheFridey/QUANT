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

describe("sandbox CI guard", () => {
  // CI installs bubblewrap and gcc, so the isolation suites must run there rather than skip.
  it.runIf(process.env.CI === "true")("has isolation with seccomp available in CI", () => {
    const runner = probeIsolation();
    expect(runner.available, runner.reason).toBe(true);
    expect(runner.seccomp, runner.seccompDetail).toBe("default-deny-errno");
  });
});
