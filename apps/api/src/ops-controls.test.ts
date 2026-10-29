import { ConflictException } from "@nestjs/common";
import { DEFAULT_STRATEGY } from "@odin/shared";
import type { PrismaClient } from "@odin/shared/db";
import type { Queue } from "bullmq";
import { describe, expect, it } from "vitest";
import { TerminalService } from "./terminal.service.js";

const sourceHash = "a".repeat(64);
const artifactHash = "b".repeat(64);

function mockService(initial: {
  status: string;
  flattenRequested?: boolean;
  config?: Record<string, unknown>;
  activeStrategy?: Record<string, unknown> | null;
  openPositions?: number;
}) {
  let row = {
    id: "primary",
    status: initial.status,
    flattenRequested: initial.flattenRequested ?? false,
    config: { ...DEFAULT_STRATEGY, ...(initial.config ?? {}) },
    activeStrategy: initial.activeStrategy ?? null,
    updatedBy: null as string | null,
    updatedAt: new Date("2026-10-29T12:00:00.000Z"),
  };
  const openPositions = initial.openPositions ?? 0;
  const cycles: Array<Record<string, unknown>> = [];
  const prisma = {
    engineControl: {
      findUnique: async () => row,
      update: async (input: { data: Record<string, unknown> }) => {
        row = {
          ...row,
          ...input.data,
          config: (input.data.config as typeof row.config) ?? row.config,
          activeStrategy: row.activeStrategy,
          updatedAt: new Date(),
        };
        return row;
      },
    },
    position: {
      count: async () => openPositions,
    },
    paperAccount: {
      findUnique: async () => ({ id: "primary" }),
    },
    cycleRun: {
      findMany: async () => cycles,
      findUnique: async ({ where }: { where: { id: string } }) => cycles.find((c) => c.id === where.id) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const created = { ...data, error: null, finishedAt: null };
        cycles.push(created);
        return created;
      },
    },
    order: {
      findMany: async () => [],
    },
  } as unknown as PrismaClient;
  const ingest = { add: async () => ({ id: "job" }) } as unknown as Queue;
  return { service: new TerminalService(prisma, ingest), getRow: () => row, cycles };
}

describe("D16 operational controls vs config immutability", () => {
  it("allows pauseNewEntries while RUNNING without strategy mutation", async () => {
    const { service, getRow } = mockService({
      status: "RUNNING",
      activeStrategy: {
        strategyId: "strat_reviewed",
        strategyVersion: "1.0.0",
        sourceHash,
        artifactHash,
      },
    });

    const result = await service.updateConfig({ pauseNewEntries: true }, "operator@odin.local");
    expect(result.operationalOnly).toBe(true);
    expect(getRow().config.pauseNewEntries).toBe(true);
    expect(getRow().config.entryM5ChangePct).toBe(DEFAULT_STRATEGY.entryM5ChangePct);
  });

  it("still rejects strategy field patches while RUNNING", async () => {
    const { service } = mockService({ status: "RUNNING" });
    await expect(service.updateConfig({ entryM5ChangePct: "9" }, "operator@odin.local")).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("preserves incomplete flattenRequested across resume", async () => {
    const { service, getRow } = mockService({
      status: "PAUSED",
      flattenRequested: true,
      openPositions: 2,
    });
    const resumed = await service.act("resume", "operator@odin.local");
    expect(resumed.status).toBe("RUNNING");
    expect(resumed.flattenRequested).toBe(true);
    expect(getRow().flattenRequested).toBe(true);
  });

  it("clears flattenRequested on resume only when the book is flat", async () => {
    const { service } = mockService({
      status: "PAUSED",
      flattenRequested: true,
      openPositions: 0,
    });
    const resumed = await service.act("resume", "operator@odin.local");
    expect(resumed.flattenRequested).toBe(false);
  });

  it("accepts reduce-only SELL while PAUSED and returns an async receipt", async () => {
    const { service, cycles } = mockService({ status: "PAUSED" });
    const receipt = await service.submitOrder({
      side: "SELL",
      pairAddress: "pair_a",
      clientIntentId: "intent_close_001",
    });
    expect(receipt.accepted).toBe(true);
    expect(receipt.pending).toBe(true);
    expect(receipt.clientIntentId).toBe("intent_close_001");
    expect(cycles).toHaveLength(1);

    const replay = await service.submitOrder({
      side: "SELL",
      pairAddress: "pair_a",
      clientIntentId: "intent_close_001",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.cycleId).toBe(receipt.cycleId);
    expect(cycles).toHaveLength(1);
  });

  it("rejects BUY while PAUSED", async () => {
    const { service } = mockService({ status: "PAUSED" });
    await expect(
      service.submitOrder({ side: "BUY", pairAddress: "pair_a", notionalUsd: "25" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
