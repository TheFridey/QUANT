import { DEFAULT_STRATEGY, startOfLondonDay } from "@odin/shared";
import type { PrismaClient } from "@odin/shared/db";
import { describe, expect, it } from "vitest";
import { sandboxEntryBlock } from "./sandbox-execution.js";

const now = new Date("2026-10-31T16:05:00.000Z");
const dec = (value: string) => ({ toString: () => value });

function fakePrisma(input: {
  status?: string;
  config?: Record<string, unknown>;
  sessionStartedAt?: Date | null;
  start?: string | null;
  low?: string | null;
  snapshotEquity?: string | null;
}) {
  return {
    engineControl: {
      findUnique: async () => ({ status: input.status ?? "RUNNING", config: input.config ?? DEFAULT_STRATEGY }),
    },
    paperAccount: {
      findUnique: async () => ({
        startingBalanceUsd: dec("10000"),
        highWaterMarkUsd: dec("10106"),
        sessionStartedAt: input.sessionStartedAt === undefined ? startOfLondonDay(now) : input.sessionStartedAt,
        sessionStartEquityUsd: input.start === undefined ? dec("10000") : input.start === null ? null : dec(input.start),
        sessionLowEquityUsd: input.low ? dec(input.low) : null,
      }),
    },
    equitySnapshot: {
      findFirst: async () => (input.snapshotEquity ? { equityUsd: dec(input.snapshotEquity) } : null),
    },
  } as unknown as PrismaClient;
}

describe("sandbox entry re-check before first submission (ASCEND-00 F3)", () => {
  it("blocks a never-submitted BUY once the day has breached, even after a recovery", async () => {
    // 31 Oct: equity reached $9,679.11 at 16:00 and is now $9,710 (-2.90%).
    expect(await sandboxEntryBlock(fakePrisma({ low: "9679.11", snapshotEquity: "9710" }), { accountId: "demo", now })).toBe("CIRCUIT_BREAKER");
    expect(await sandboxEntryBlock(fakePrisma({ low: "9750", snapshotEquity: "9690" }), { accountId: "demo", now })).toBe("CIRCUIT_BREAKER");
  });

  it("allows the BUY on a healthy day, including before today's first snapshot", async () => {
    expect(await sandboxEntryBlock(fakePrisma({ low: "9900", snapshotEquity: "9950" }), { accountId: "demo", now })).toBeNull();
    expect(await sandboxEntryBlock(fakePrisma({ low: null, snapshotEquity: null }), { accountId: "demo", now })).toBeNull();
  });

  it("blocks while the engine is halted or new entries are paused", async () => {
    expect(await sandboxEntryBlock(fakePrisma({ status: "EMERGENCY_STOP" }), { accountId: "demo", now })).toBe("ENGINE_HALTED");
    expect(await sandboxEntryBlock(fakePrisma({ status: "PAUSED" }), { accountId: "demo", now })).toBe("ENGINE_HALTED");
    expect(
      await sandboxEntryBlock(fakePrisma({ config: { ...DEFAULT_STRATEGY, pauseNewEntries: true } }), { accountId: "demo", now }),
    ).toBe("PAUSE_NEW_ENTRIES");
  });

  it("blocks when the day's base is unknown or the session has not rolled to today", async () => {
    expect(await sandboxEntryBlock(fakePrisma({ start: null }), { accountId: "demo", now })).toBe("DAILY_PNL_UNAVAILABLE");
    expect(
      await sandboxEntryBlock(fakePrisma({ sessionStartedAt: new Date("2026-10-30T00:00:00.000Z") }), { accountId: "demo", now }),
    ).toBe("DAILY_PNL_UNAVAILABLE");
  });
});
