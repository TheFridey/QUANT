import { ConflictException } from "@nestjs/common";
import { DEFAULT_STRATEGY } from "@odin/shared";
import type { PrismaClient } from "@odin/shared/db";
import type { Queue } from "bullmq";
import { describe, expect, it } from "vitest";
import { TerminalService } from "./terminal.service.js";

const sourceHash = "a".repeat(64);
const artifactHash = "b".repeat(64);

describe("promoted paper strategy immutability", () => {
  it("keeps a paused-engine config patch from changing the promoted strategy and still pauses and resumes", async () => {
    let row = {
      id: "primary",
      status: "RUNNING",
      flattenRequested: false,
      config: { ...DEFAULT_STRATEGY, entryM5ChangePct: "2" },
      activeStrategy: {
        strategyId: "strat_reviewed",
        strategyVersion: "1.0.0",
        sourceHash,
        artifactHash,
        audits: [],
      },
      updatedBy: null as string | null,
    };
    const prisma = {
      engineControl: {
        findUnique: async () => row,
        update: async (input: { data: Record<string, unknown> }) => {
          row = { ...row, ...input.data, config: (input.data.config as typeof row.config) ?? row.config, activeStrategy: row.activeStrategy };
          return row;
        },
      },
    } as unknown as PrismaClient;
    const service = new TerminalService(prisma, {} as Queue);

    const paused = await service.act("pause", "operator@odin.local");
    expect(paused.status).toBe("PAUSED");

    await expect(service.updateConfig({ entryM5ChangePct: "9" }, "operator@odin.local")).rejects.toBeInstanceOf(ConflictException);
    await expect(service.updateConfig({ sourceHash: "c".repeat(64) }, "operator@odin.local")).rejects.toThrow();
    expect(row.config.entryM5ChangePct).toBe("2");
    expect(row.activeStrategy.sourceHash).toBe(sourceHash);
    expect(row.activeStrategy.artifactHash).toBe(artifactHash);
    expect(row.activeStrategy.strategyVersion).toBe("1.0.0");

    const resumed = await service.act("resume", "operator@odin.local");
    expect(resumed.status).toBe("RUNNING");
    expect(row.config.entryM5ChangePct).toBe("2");
  });
});
