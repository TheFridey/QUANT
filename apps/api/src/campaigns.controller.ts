import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Req, UseGuards } from "@nestjs/common";
import { authorizeHoldout, CampaignError, cancelRun, listCampaigns, runDetail, unitTrials } from "@odin/evolution/campaign";
import { PrismaClient } from "@odin/shared/db";
import { AdminGuard, type RequestWithUser } from "./http.js";

/**
 * OPERATION EVIDENCE research campaigns. Behind the global JWT guard (no @Public). The GET routes only read
 * and every query is bounded (VIEW_BOUNDS). The two POST routes are ADMIN-only and write research tables only:
 * one records an operator's authorisation for a single holdout read, the other requests cancellation of a run.
 * Nothing here evaluates anything (that is CPU work for the campaign process), promotes a strategy, or touches
 * EngineControl, risk limits or strategy instances.
 */
const ID = /^[a-z0-9]{8,40}$/;

function checkId(id: string): string {
  if (!ID.test(id)) throw new BadRequestException("invalid id");
  return id;
}

function mapError(error: unknown): Error {
  if (!(error instanceof CampaignError)) return error instanceof Error ? error : new Error(String(error));
  if (error.code === "NOT_FOUND") return new NotFoundException(error.message);
  if (error.code === "OPERATOR_REQUIRED") return new ForbiddenException(error.message);
  if (error.code === "BAD_TTL") return new BadRequestException(error.message);
  return new ConflictException(error.message);
}

@Controller("research/campaigns")
export class CampaignsController {
  constructor(private readonly prisma: PrismaClient) {}

  @Get()
  list() {
    return listCampaigns(this.prisma);
  }

  @Get("runs/:runId")
  async run(@Param("runId") runId: string) {
    const detail = await runDetail(this.prisma, checkId(runId));
    if (!detail) throw new NotFoundException("unknown run");
    return detail;
  }

  @Get("units/:unitId/trials")
  async trials(@Param("unitId") unitId: string) {
    const trials = await unitTrials(this.prisma, checkId(unitId));
    if (!trials) throw new NotFoundException("no result for this unit");
    return { unitId, results: trials };
  }

  /** Records that this operator allows one read of one frozen result's holdout. The read itself is a CLI step. */
  @UseGuards(AdminGuard)
  @Post("units/:unitId/authorize-holdout")
  async authorize(@Param("unitId") unitId: string, @Body() body: unknown, @Req() request: RequestWithUser) {
    const input = (body ?? {}) as { ttlHours?: unknown; note?: unknown };
    const ttlHours = input.ttlHours === undefined ? 24 : Number(input.ttlHours);
    if (!Number.isFinite(ttlHours)) throw new BadRequestException("ttlHours must be a number");
    if (input.note !== undefined && (typeof input.note !== "string" || input.note.length > 500)) throw new BadRequestException("note must be a string of at most 500 characters");
    const operator = request.user?.email;
    if (!operator) throw new ForbiddenException("operator identity required");
    try {
      const out = await authorizeHoldout(this.prisma, { unitId: checkId(unitId), operator, ttlMs: ttlHours * 3_600_000, note: input.note as string | undefined });
      return { status: "AUTHORIZED", by: out.authorisation.actor, expiresAt: out.authorisation.expiresAt?.toISOString() ?? null, priorLooks: out.priorLooks, period: { start: out.context.periodStart.toISOString(), end: out.context.periodEnd.toISOString() } };
    } catch (error) {
      throw mapError(error);
    }
  }

  @UseGuards(AdminGuard)
  @Post("runs/:runId/cancel")
  async cancel(@Param("runId") runId: string, @Req() request: RequestWithUser) {
    try {
      return await cancelRun(this.prisma, { runId: checkId(runId), actor: `operator:${request.user?.email ?? "unknown"}`, now: new Date() });
    } catch (error) {
      throw mapError(error);
    }
  }
}
