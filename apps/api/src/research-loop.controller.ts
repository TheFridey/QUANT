import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  abandonResearchExperiment,
  enqueueResearchExperiment,
  listResearchExperimentEvents,
  listResearchExperiments,
  recordResearchApproval,
  ResearchLoopLimitError,
  researchLoopStatus,
  setResearchLoopControl,
} from "@odin/evolution";
import { PrismaClient } from "@odin/shared/db";
import { ZodError } from "zod";
import { AdminGuard, type RequestWithUser } from "./http.js";

/**
 * ASCEND-08 research loop operator surface. Every route is ADMIN-only. Nothing here can promote a
 * strategy, change EngineControl, or alter risk limits: approvals cover forge_code, run_backtest and
 * promote_paper (a PAPER_CANDIDATE research label) for one experiment, and expire.
 */
@UseGuards(AdminGuard)
@Controller("evolution/research-loop")
export class ResearchLoopController {
  constructor(private readonly prisma: PrismaClient) {}

  @Get()
  status() {
    return researchLoopStatus(this.prisma);
  }

  @Post("control")
  async control(@Body() body: unknown, @Req() request: RequestWithUser) {
    try {
      return await setResearchLoopControl(this.prisma, body, actorOf(request));
    } catch (error) {
      throw badRequest(error);
    }
  }

  @Get("experiments")
  experiments() {
    return listResearchExperiments(this.prisma);
  }

  @Post("experiments")
  async enqueue(@Body() body: unknown, @Req() request: RequestWithUser) {
    let result: Awaited<ReturnType<typeof enqueueResearchExperiment>>;
    try {
      result = await enqueueResearchExperiment(this.prisma, body, actorOf(request));
    } catch (error) {
      throw badRequest(error);
    }
    if (result.created.length === 0) throw new ConflictException(result.refused ?? "Not queued");
    return result;
  }

  @Get("experiments/:id/events")
  async events(@Param("id") id: string) {
    const exists = await this.prisma.researchExperiment.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException("Experiment not found");
    return listResearchExperimentEvents(this.prisma, id);
  }

  @Post("experiments/:id/approvals")
  async approve(@Param("id") id: string, @Body() body: unknown, @Req() request: RequestWithUser) {
    let result: Awaited<ReturnType<typeof recordResearchApproval>>;
    try {
      result = await recordResearchApproval(this.prisma, id, body, actorOf(request));
    } catch (error) {
      throw badRequest(error);
    }
    if (!result.ok) {
      if (result.error === "EXPERIMENT_NOT_FOUND") throw new NotFoundException(result.error);
      throw new ConflictException(result.error);
    }
    return {
      id: result.approval.id,
      experimentId: result.approval.experimentId,
      action: result.approval.action,
      approvedBy: result.approval.approvedBy,
      approvedAt: result.approval.approvedAt.toISOString(),
      expiresAt: result.approval.expiresAt.toISOString(),
    };
  }

  @Post("experiments/:id/abandon")
  async abandon(@Param("id") id: string, @Body() body: unknown, @Req() request: RequestWithUser) {
    let result: Awaited<ReturnType<typeof abandonResearchExperiment>>;
    try {
      result = await abandonResearchExperiment(this.prisma, id, body, actorOf(request));
    } catch (error) {
      throw badRequest(error);
    }
    if (!result.ok) {
      if (result.error === "EXPERIMENT_NOT_FOUND") throw new NotFoundException(result.error);
      throw new ConflictException(result.error);
    }
    return result;
  }
}

function actorOf(request: RequestWithUser): string {
  return request.user?.email ?? "unknown";
}

export function badRequest(error: unknown): Error {
  if (error instanceof ZodError) return new BadRequestException(error.issues);
  if (error instanceof ResearchLoopLimitError) return new BadRequestException(error.message);
  return error instanceof Error ? error : new Error(String(error));
}
