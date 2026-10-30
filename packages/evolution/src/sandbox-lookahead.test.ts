import { describe, expect, it } from "vitest";
import { compileStrategySource } from "./compile-strategy.js";
import { executeCompiledStrategy, isolationAvailable, probeIsolation } from "./sandbox-runner.js";
import type { StrategyBar } from "./strategy-interface.js";

/**
 * Audit C1: the strategy scans every readable, writable mapping of its own process
 * through /proc/self/mem for a marker that exists only in the last bar's close.
 * The needle is kept XOR-masked so the scanner never finds its own copy.
 */

const MARKER = "QLOOKAHEADZ7X9";
const MASK = 0x5a;
const masked = Array.from(Buffer.from(MARKER, "latin1")).map((byte) => byte ^ MASK);

const scanner = `export function onBar(input: any) {
  const p = (globalThis as any)["pro" + "cess"];
  const f = p.getBuiltinModule("f" + "s");
  const masked = ${JSON.stringify(masked)};
  const mask = ${MASK};
  const first = masked[0] ^ mask;
  const maps = String(f.readFileSync("/proc/self/maps", "utf8")).split("\\n");
  const fd = f.openSync("/proc/self/mem", "r");
  const chunk = (globalThis as any).Buffer.alloc(1 << 20);
  let found = false;
  let scanned = 0;
  for (const line of maps) {
    const m = /^([0-9a-f]+)-([0-9a-f]+) rw/.exec(line);
    if (!m) continue;
    const start = parseInt(m[1], 16);
    const end = parseInt(m[2], 16);
    if (end - start > 256 * 1024 * 1024) continue;
    for (let at = start; at < end && !found; at += chunk.length) {
      let n = 0;
      try { n = f.readSync(fd, chunk, 0, Math.min(chunk.length, end - at), at); } catch (_e) { break; }
      scanned += n;
      let index = chunk.indexOf(first);
      while (index >= 0 && index < n) {
        let match = true;
        for (let j = 1; j < masked.length; j += 1) {
          if (index + j >= n || chunk[index + j] !== (masked[j] ^ mask)) { match = false; break; }
        }
        if (match) { found = true; break; }
        index = chunk.indexOf(first, index + 1);
      }
    }
    if (found) break;
  }
  f.closeSync(fd);
  return {
    intent: "HOLD",
    reasonCodes: [found ? "MARKER_FOUND" : "MARKER_NOT_FOUND", scanned > 0 ? "SCANNED" : "NOT_SCANNED", "BAR_" + input.history.length],
  };
}
`;

const bar = (index: number, close: string): StrategyBar => ({
  instrumentId: "solana:spot:universe",
  receivedAt: `2026-01-01T00:0${index}:00.000Z`,
  priceUsd: close,
  liquidityUsd: "100000",
  volume24hUsd: "1000",
  priceChangeM5Pct: null,
  priceChangeH1Pct: null,
  txnsM5Buys: null,
  txnsM5Sells: null,
  dataState: "REPLAY",
});

const skipReason = isolationAvailable() ? "" : ` [skipped: isolation unavailable — ${probeIsolation().reason}]`;

describe.skipIf(!isolationAvailable())(`sandbox look-ahead${skipReason}`, () => {
  it("never exposes a future bar to a strategy that scans its own memory", async () => {
    const compiled = compileStrategySource(scanner);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const bars = [bar(0, "1"), bar(1, "1"), bar(2, "1"), bar(3, MARKER)];
    const result = await executeCompiledStrategy({
      javascript: compiled.javascript,
      artifactHash: compiled.artifactHash,
      bars,
      metadata: { strategyId: "lookahead", version: "0", hypothesisId: "hyp" },
      timeoutMs: 15_000,
      perBarTimeoutMs: 5_000,
    });
    expect(result.ok, result.error ?? "").toBe(true);
    expect(result.signals).toHaveLength(bars.length);
    for (const signal of result.signals.slice(0, -1)) {
      expect(signal.reasonCodes[1]).toBe("SCANNED");
      expect(signal.reasonCodes[0]).toBe("MARKER_NOT_FOUND");
    }
    // Positive control: once the last bar is delivered the same scan does find it.
    expect(result.signals.at(-1)?.reasonCodes[0]).toBe("MARKER_FOUND");
  });
});
