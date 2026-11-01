import { DEFAULT_STRATEGY, startOfLondonDay } from "@odin/shared";
import type { PrismaClient } from "@odin/shared/db";
import { describe, expect, it, vi } from "vitest";
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

describe("sandbox outbox loop scope (ASCEND-00 F3 review)", () => {
  type Row = { id: string; side: string; submissionState: string; clientOrderId: string; reasonCodes: string[] };
  const row = (id: string, side: string, submissionState: string): Row => ({ id, side, submissionState, clientOrderId: `c_${id}`, reasonCodes: ["ORDER_PROPOSED"] });

  async function runOutbox(rows: Row[], fencedCount = 1) {
    vi.resetModules();
    // Test-only: report the sandbox mode from the gate and a venue that is not ready, so no order is submitted.
    vi.doMock("@odin/shared", async (original) => ({
      ...(await original<typeof import("@odin/shared")>()),
      assertPaperOrSandboxOnly: () => ({ ok: true, mode: "SANDBOX" }),
    }));
    vi.doMock("@odin/market-data", () => ({
      createExecutionGateway: () => ({ readiness: () => "NOT_READY" }),
      allowsLocalPaperBooking: () => false,
    }));
    const { processSandboxOutbox } = await import("./sandbox-execution.js");
    const updateMany = vi.fn().mockResolvedValue({ count: fencedCount });
    const update = vi.fn().mockResolvedValue({});
    const engineLookup = vi.fn().mockResolvedValue({ status: "EMERGENCY_STOP", config: DEFAULT_STRATEGY });
    const prisma = {
      engineControl: { findUnique: engineLookup },
      paperAccount: { findUnique: async () => null },
      equitySnapshot: { findFirst: async () => null },
      order: { findMany: async () => rows, updateMany, update },
    } as unknown as PrismaClient;
    const result = await processSandboxOutbox(prisma, { accountId: "demo", now, env: {} });
    vi.doUnmock("@odin/shared");
    vi.doUnmock("@odin/market-data");
    return { result, updateMany, update, engineLookup };
  }

  it("cancels only never-submitted BUYs, fenced on PENDING + PRE_SUBMIT, and evaluates the block once", async () => {
    const { updateMany, update, engineLookup } = await runOutbox([
      row("buy1", "BUY", "PRE_SUBMIT"),
      row("buy2", "BUY", "PRE_SUBMIT"),
      row("sell", "SELL", "PRE_SUBMIT"),
      row("unknown", "BUY", "UNKNOWN"),
      row("submitting", "BUY", "SUBMITTING"),
    ]);
    expect(engineLookup).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls.map(([args]) => args.where)).toEqual([
      { id: "buy1", status: "PENDING", submissionState: "PRE_SUBMIT" },
      { id: "buy2", status: "PENDING", submissionState: "PRE_SUBMIT" },
    ]);
    expect(updateMany.mock.calls[0]![0].data).toMatchObject({ status: "CANCELLED", rejectReason: "ENGINE_HALTED", submissionState: "TERMINAL" });
    // Everything else follows the unchanged not-ready path.
    expect(update.mock.calls.map(([args]) => args.where.id)).toEqual(["sell", "unknown", "submitting"]);
  });

  it("leaves an order alone when the fence finds it already moved on", async () => {
    const { updateMany, update } = await runOutbox([row("raced", "BUY", "PRE_SUBMIT")], 0);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });
});
