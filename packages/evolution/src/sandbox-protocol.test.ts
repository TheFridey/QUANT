import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sandboxProtocolForTests, validateSignal } from "./sandbox-runner.js";
import type { StrategyBar } from "./strategy-interface.js";

/**
 * Protocol tests. These run the harness under plain Node with NO isolation, so they
 * prove the host-side lock-step, nonce and validation rules on any platform. Isolation
 * itself is covered by the bubblewrap suites (sandbox-forgery, sandbox-lookahead).
 */

const bar = (index: number): StrategyBar => ({
  instrumentId: "solana:spot:universe",
  pairAddress: "pair-1",
  receivedAt: `2026-01-01T00:0${index}:00.000Z`,
  priceUsd: String(1 + index),
  liquidityUsd: "100000",
  volume24hUsd: "1000",
  priceChangeM5Pct: null,
  priceChangeH1Pct: null,
  txnsM5Buys: null,
  txnsM5Sells: null,
  dataState: "REPLAY",
});

const workDirs: string[] = [];
afterEach(() => {
  for (const dir of workDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function drive(strategy: string, bars: StrategyBar[], perBarTimeoutMs = 2_000) {
  const work = mkdtempSync(join(tmpdir(), "odin-protocol-test-"));
  workDirs.push(work);
  writeFileSync(join(work, "strategy.js"), strategy);
  writeFileSync(join(work, "harness.mjs"), sandboxProtocolForTests.harnessSource);
  writeFileSync(join(work, "package.json"), "{\"type\":\"module\"}\n");
  const { createHash } = await import("node:crypto");
  const artifactHash = createHash("sha256").update(strategy).digest("hex");
  const outcome = await sandboxProtocolForTests.runStreaming({
    command: process.execPath,
    args: [join(work, "harness.mjs")],
    header: {
      nonce: "test-nonce-0123456789",
      artifactHash,
      contractVersion: "1.0.0",
      metadata: { strategyId: "protocol", version: "0", hypothesisId: "hyp" },
      initialState: {},
      historyLimit: 256,
    },
    bars,
    timeoutMs: 15_000,
    perBarTimeoutMs,
  });
  return { outcome, artifactHash };
}

describe("sandbox result protocol (unsandboxed harness)", () => {
  it("returns exactly one validated signal per delivered bar", async () => {
    const { outcome, artifactHash } = await drive(
      `export function onBar(input) { return { intent: "HOLD", reasonCodes: ["SEEN_" + input.history.length] }; }`,
      [bar(0), bar(1), bar(2)],
    );
    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") return;
    expect(outcome.executedHash).toBe(artifactHash);
    expect(outcome.signals.map((signal) => signal.reasonCodes[0])).toEqual(["SEEN_0", "SEEN_1", "SEEN_2"]);
    expect(outcome.signals.every((signal) => signal.instrumentId === "solana:spot:universe")).toBe(true);
  });

  it("ignores a forged success line on stdout followed by exit(0)", async () => {
    const forged = JSON.stringify({
      ok: true,
      executedHash: "0".repeat(64),
      signals: [{ instrumentId: "solana:spot:universe", intent: "ENTER_LONG", reasonCodes: ["FORGED"] }],
    });
    const { outcome } = await drive(
      `export function onBar() { process.stdout.write(${JSON.stringify(forged + "\n")}); process.exit(0); }`,
      [bar(0)],
    );
    expect(outcome.kind).not.toBe("completed");
  });

  it("rejects a frame written to the result pipe without the run nonce", async () => {
    const { outcome } = await drive(
      `import { writeSync } from "node:fs";
      export function onBar(input) {
        writeSync(3, JSON.stringify({ nonce: "guess", type: "signal", seq: 0, signal: { instrumentId: input.bar.instrumentId, pairAddress: input.bar.pairAddress, intent: "ENTER_LONG", reasonCodes: ["FORGED"] } }) + "\\n");
        return { intent: "HOLD", reasonCodes: ["REAL"] };
      }`,
      [bar(0)],
    );
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.code).toBe("SANDBOX_PROTOCOL");
  });

  // The next three model the strongest in-process attacker: it already knows the run nonce
  // (as if read from memory) and watches stdin for the live bar token.
  const attacker = `import { writeSync } from "node:fs";
      const NONCE = "test-nonce-0123456789";
      const tokens = [];
      process.stdin.on("data", (chunk) => {
        for (const line of String(chunk).split("\\n")) {
          try { const parsed = JSON.parse(line); if (parsed.token) tokens.push(parsed.token); } catch {}
        }
      });
      const frame = (seq, token, signal) =>
        writeSync(3, JSON.stringify({ nonce: NONCE, type: "signal", seq, token, signal }) + "\\n");`;

  it("rejects a frame written before its bar was sent instead of accepting it later", async () => {
    const { outcome } = await drive(
      `${attacker}
      export async function onBar(input) {
        if (input.history.length === 0) {
          // Pre-commit an answer for bar 1 after bar 0's frame, before bar 1 exists.
          setTimeout(() => frame(1, "guessed", { instrumentId: input.bar.instrumentId, pairAddress: input.bar.pairAddress, intent: "ENTER_LONG", reasonCodes: ["PRECOMMIT"] }), 0);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { intent: "HOLD", reasonCodes: ["REAL"] };
      }`,
      [bar(0), bar(1)],
    );
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.code).toBe("SANDBOX_PROTOCOL");
  });

  it("fails the run when a second frame arrives for the same bar", async () => {
    const { outcome } = await drive(
      `${attacker}
      export function onBar(input) {
        const signal = { instrumentId: input.bar.instrumentId, pairAddress: input.bar.pairAddress, intent: "ENTER_LONG", reasonCodes: ["DUPLICATE"] };
        // Written synchronously, so the host reads it first and the harness's own frame is the duplicate.
        frame(0, tokens.at(-1), signal);
        return { intent: "HOLD", reasonCodes: ["REAL"] };
      }`,
      [bar(0)],
    );
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.code).toBe("SANDBOX_PROTOCOL");
  });

  it("fails the run when a frame names a different instrument than the delivered bar", async () => {
    const { outcome } = await drive(
      `${attacker}
      export function onBar(input) {
        frame(0, tokens.at(-1), { instrumentId: "solana:spot:OTHER", pairAddress: input.bar.pairAddress, intent: "ENTER_LONG", reasonCodes: ["SWAP"] });
        return { intent: "HOLD", reasonCodes: ["REAL"] };
      }`,
      [bar(0)],
    );
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.code).toBe("CONTRACT_FAIL");
  });

  it("maps an invalid intent to CONTRACT_FAIL", async () => {
    const { outcome } = await drive(
      `export function onBar() { return { intent: "BUY_EVERYTHING", reasonCodes: ["X"], confidence: 42 }; }`,
      [bar(0)],
    );
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.code).toBe("CONTRACT_FAIL");
  });

  it("does not accept fewer signals than bars when the strategy exits early", async () => {
    const { outcome } = await drive(
      `export function onBar(input) {
        if (input.history.length === 1) process.exit(0);
        return { intent: "HOLD", reasonCodes: ["ONE"] };
      }`,
      [bar(0), bar(1), bar(2)],
    );
    expect(outcome.kind).not.toBe("completed");
  });

  it("times out a single slow bar even when the overall budget remains", async () => {
    const { outcome } = await drive(
      `export async function onBar(input) {
        if (input.history.length === 1) await new Promise((resolve) => setTimeout(resolve, 5_000));
        return { intent: "HOLD", reasonCodes: ["OK"] };
      }`,
      [bar(0), bar(1)],
      300,
    );
    expect(outcome.kind).toBe("timeout");
  });

  it("never writes a bar before the previous signal arrived", async () => {
    // The strategy reads stdin directly; with lock-step delivery nothing is waiting there.
    const { outcome } = await drive(
      `let peeked = "";
      process.stdin.on("data", (chunk) => { peeked += String(chunk); });
      export async function onBar(input) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const ahead = peeked.includes("01:00") || peeked.includes("02:00") ? "SAW_FUTURE" : "NO_FUTURE";
        return { intent: "HOLD", reasonCodes: [input.history.length === 0 ? ahead : "LATER"] };
      }`,
      [bar(0), bar(1), bar(2)],
    );
    expect(outcome.kind).toBe("completed");
    if (outcome.kind === "completed") expect(outcome.signals[0]?.reasonCodes[0]).toBe("NO_FUTURE");
  });
});

describe("host-side signal validation", () => {
  it("rejects a signal for a different instrument than the delivered bar", () => {
    const result = validateSignal({ instrumentId: "other", pairAddress: "pair-1", intent: "HOLD", reasonCodes: [] }, bar(0));
    expect(result.ok).toBe(false);
  });

  it("rejects unknown fields and out-of-range confidence", () => {
    expect(validateSignal({ instrumentId: "solana:spot:universe", pairAddress: "pair-1", intent: "HOLD", reasonCodes: [], size: 10 }, bar(0)).ok).toBe(false);
    expect(validateSignal({ instrumentId: "solana:spot:universe", pairAddress: "pair-1", intent: "HOLD", reasonCodes: [], confidence: 42 }, bar(0)).ok).toBe(false);
  });

  it("rejects nondeterministic reason codes", () => {
    expect(validateSignal({ instrumentId: "solana:spot:universe", pairAddress: "pair-1", intent: "HOLD", reasonCodes: ["0.123"] }, bar(0)).ok).toBe(false);
  });

  it("accepts a contract-valid signal", () => {
    expect(validateSignal({ instrumentId: "solana:spot:universe", pairAddress: "pair-1", intent: "ENTER_LONG", reasonCodes: ["UP"], confidence: 0.4 }, bar(0)).ok).toBe(true);
  });
});
