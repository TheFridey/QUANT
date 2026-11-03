import "reflect-metadata";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { BadRequestException, ConflictException, ForbiddenException, type ExecutionContext } from "@nestjs/common";
import type { PrismaClient } from "@odin/shared/db";
import { describe, expect, it } from "vitest";
import { AdminGuard, type RequestWithUser } from "./http.js";
import { ResearchLoopController } from "./research-loop.controller.js";

describe("ASCEND-08 research loop API", () => {
  it("guards every route with ADMIN at the controller level", () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, ResearchLoopController) as unknown[];
    expect(guards).toContain(AdminGuard);
  });

  it("AdminGuard refuses a non-admin user", () => {
    const context = {
      switchToHttp: () => ({ getRequest: () => ({ user: { role: "VIEWER", email: "v@odin.local" } }) }),
    } as unknown as ExecutionContext;
    expect(() => new AdminGuard().canActivate(context)).toThrow(ForbiddenException);
  });

  it("answers 409 to an approval the experiment has not asked for, and writes nothing", async () => {
    let created = 0;
    const prisma = {
      researchExperiment: {
        findUnique: async () => ({ id: "rexp_1", hypothesisId: "hyp_1", state: "OBSERVE", blockedState: null, context: {} }),
      },
      researchApproval: {
        create: async () => {
          created += 1;
          return {};
        },
      },
    } as unknown as PrismaClient;
    const controller = new ResearchLoopController(prisma);
    const request = { user: { role: "ADMIN", email: "op@odin.local" } } as unknown as RequestWithUser;
    await expect(controller.approve("rexp_1", { action: "run_backtest", subjectHash: "a".repeat(64) }, request)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(created).toBe(0);
  });

  it("answers 400 (not 500) to a lease shorter than twice the tick runtime, and writes nothing", async () => {
    let upserts = 0;
    const prisma = {
      researchLoopControl: {
        findUnique: async () => null,
        upsert: async () => {
          upserts += 1;
          return {};
        },
      },
    } as unknown as PrismaClient;
    const controller = new ResearchLoopController(prisma);
    await expect(
      controller.control({ tickRuntimeMs: 120_000, leaseMs: 200_000 }, { user: { role: "ADMIN", email: "a@odin.local" } } as unknown as RequestWithUser),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(upserts).toBe(0);
  });
});
