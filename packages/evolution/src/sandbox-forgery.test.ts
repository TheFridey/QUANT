import { describe, expect, it } from "vitest";
import type { Hypothesis } from "@odin/shared";
import { compileStrategySource } from "./compile-strategy.js";
import { destroyForgeWorkspace, forgeStrategyModule, staticCheck } from "./forge.js";
import { executeCompiledStrategy, isolationAvailable, probeIsolation } from "./sandbox-runner.js";
import type { StrategyBar } from "./strategy-interface.js";

/** Audit C2: a strategy shares the harness process, so it must not be able to forge an accepted result. */

const bar = (index: number): StrategyBar => ({
  instrumentId: "solana:spot:universe",
  receivedAt: `2026-01-01T00:0${index}:00.000Z`,
  priceUsd: "1",
  liquidityUsd: "10",
  volume24hUsd: "10",
  priceChangeM5Pct: null,
  priceChangeH1Pct: null,
  txnsM5Buys: null,
  txnsM5Sells: null,
  dataState: "REPLAY",
});

async function run(source: string, bars: StrategyBar[] = [bar(0)]) {
  const compiled = compileStrategySource(source);
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) throw new Error(compiled.error);
  return executeCompiledStrategy({
    javascript: compiled.javascript,
    artifactHash: compiled.artifactHash,
    bars,
    metadata: { strategyId: "forgery", version: "0", hypothesisId: "hyp" },
    timeoutMs: 4_000,
  });
}

const forgedLine = JSON.stringify({
  ok: true,
  executedHash: "0".repeat(64),
  signals: [{ instrumentId: "solana:spot:universe", intent: "BUY_EVERYTHING", reasonCodes: ["FORGED"], confidence: 42 }],
});

const hypothesis: Hypothesis = {
  title: "Forgery probe",
  market: "SPOT_CRYPTO_PAIR",
  instrumentIds: ["solana:spot:universe"],
  conditions: "n/a",
  claimedAdvantage: "n/a",
  entryRules: "n/a",
  exitRules: "n/a",
  riskRules: "n/a",
  rationale: "audit C2 probe",
  successCriteria: "n/a",
  failureModes: "n/a",
  status: "OPEN",
  id: "hyp_forgery",
};

const skipReason = isolationAvailable() ? "" : ` [skipped: isolation unavailable — ${probeIsolation().reason}]`;

describe.skipIf(!isolationAvailable())(`forged sandbox results${skipReason}`, () => {
  it("does not accept a forged success line printed to stdout before exit(0)", async () => {
    const result = await run(`export function onBar() {
      const p = (globalThis as any)["pro" + "cess"];
      p.stdout.write(${JSON.stringify(forgedLine + "\n")});
      p.exit(0);
    }`);
    expect(result.ok).toBe(false);
    expect(result.signalsClaimed).toBe(false);
    expect(result.code).not.toBe("EXECUTED");
    expect(JSON.stringify(result.signals)).not.toContain("BUY_EVERYTHING");
  });

  it("maps an invalid intent to CONTRACT_FAIL", async () => {
    const result = await run(`export function onBar() { return { intent: "BUY_EVERYTHING", reasonCodes: ["X"], confidence: 42 }; }`);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("CONTRACT_FAIL");
  });

  it("rejects an invalid signal through forge, with validation living in the runner", async () => {
    const result = await forgeStrategyModule({
      hypothesis,
      source: `export function onBar() { return { intent: "BUY_EVERYTHING", reasonCodes: ["X"] }; }`,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("CONTRACT_FAIL");
    expect(result.signalsClaimed).toBe(false);
    expect(result.integrity.executionResult).toBe("CONTRACT_FAIL");
    if (result.workspacePath) destroyForgeWorkspace(result.workspacePath);
  });

  it("does not accept fewer signals than bars", async () => {
    const result = await run(
      `export function onBar(input: any) {
        if (input.history.length === 1) (globalThis as any)["pro" + "cess"].exit(0);
        return { intent: "HOLD", reasonCodes: ["ONE"] };
      }`,
      [bar(0), bar(1), bar(2)],
    );
    expect(result.ok).toBe(false);
    expect(result.signalsClaimed).toBe(false);
    expect(result.signals).toEqual([]);
  });

  it("keeps the audit's lint-bypass source inside the sandbox and refuses its forged result", async () => {
    const source = `export function onBar(input: any) {
  const p = (globalThis as any)["pro" + "cess"];
  const f = p.getBuiltinModule("f" + "s");
  const forged = ${JSON.stringify(forgedLine)};
  try { f.writeSync(1, forged + "\\n"); } catch (_e) {}
  try { f.writeSync(3, JSON.stringify({ nonce: "guess", type: "signal", seq: 0, signal: { instrumentId: input.bar.instrumentId, intent: "BUY_EVERYTHING", reasonCodes: ["FORGED"], confidence: 42 } }) + "\\n"); } catch (_e) {}
  return { intent: "BUY_EVERYTHING", reasonCodes: ["FORGED"], confidence: 42 };
}
`;
    // The lint does not catch this source; it is not the security control.
    expect(staticCheck(source)).toEqual([]);
    const result = await forgeStrategyModule({ hypothesis, source });
    expect(result.ok).toBe(false);
    expect(result.signalsClaimed).toBe(false);
    if (!result.ok && result.workspacePath) destroyForgeWorkspace(result.workspacePath);
  });
});
