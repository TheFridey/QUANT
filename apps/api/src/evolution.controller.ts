import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { AdminGuard, type RequestWithUser } from "./http.js";
import { EvolutionService } from "./evolution.service.js";

@Controller("evolution")
export class EvolutionController {
  constructor(private readonly evolution: EvolutionService) {}

  @Get("markets")
  markets() {
    return this.evolution.listMarkets();
  }

  @UseGuards(AdminGuard)
  @Post("markets")
  setMarket(@Body() body: unknown, @Req() request: RequestWithUser) {
    return this.evolution.setMarket(body, request.user?.email ?? "unknown");
  }

  @Post("markets/validate")
  validateUniverse(@Body() body: unknown) {
    return this.evolution.validateUniverse(body);
  }

  @Get("models")
  models() {
    return this.evolution.modelOps();
  }

  @Get("hypotheses")
  hypotheses() {
    return this.evolution.listHypotheses();
  }

  @UseGuards(AdminGuard)
  @Post("hypotheses")
  createHypothesis(@Body() body: unknown, @Req() request: RequestWithUser) {
    return this.evolution.createHypothesis(body, request.user?.email ?? "unknown");
  }

  @UseGuards(AdminGuard)
  @Post("pipeline")
  pipeline(@Body() body: unknown, @Req() request: RequestWithUser) {
    return this.evolution.runPipeline(body, request.user?.email ?? "unknown");
  }

  @UseGuards(AdminGuard)
  @Post("forge")
  forge(@Body() body: unknown) {
    return this.evolution.forgeOnly(body);
  }

  @Post("challenge")
  challenge(@Body() body: unknown) {
    return this.evolution.challengePreview(body);
  }

  @Get("lifecycle")
  lifecycle(@Query("strategyId") strategyId?: string) {
    return this.evolution.listLifecycle(strategyId);
  }

  @Get("genome")
  genome() {
    return this.evolution.genome();
  }

  @Get("memory/reconstruction")
  reconstruction(@Query("tradeId") tradeId?: string) {
    return this.evolution.reconstructMemory(tradeId);
  }

  @Get("memory/factors")
  factors() {
    return this.evolution.memoryFactors();
  }

  @Get("memory")
  memory(
    @Query("q") q?: string,
    @Query("pairAddress") pairAddress?: string,
    @Query("tradeId") tradeId?: string,
    @Query("phase") phase?: string,
    @Query("includePostExit") includePostExit?: string,
    @Query("limit") limit?: string,
  ) {
    return this.evolution.searchMemory({ q, pairAddress, tradeId, phase, includePostExit, limit });
  }

  @UseGuards(AdminGuard)
  @Post("memory")
  recordMemory(@Body() body: unknown) {
    return this.evolution.recordMemory(body);
  }

  @Get("autonomy")
  autonomy() {
    return this.evolution.getAutonomy();
  }

  @UseGuards(AdminGuard)
  @Post("autonomy")
  setAutonomy(@Body() body: unknown, @Req() request: RequestWithUser) {
    return this.evolution.setAutonomy(body, request.user?.email ?? "unknown");
  }

  @Get("research")
  research() {
    return this.evolution.researchCentre();
  }

  @Get("forge")
  forgeMonitor() {
    return this.evolution.forgeMonitor();
  }

  @Get("integrity")
  integrity() {
    return this.evolution.dataIntegrityPanel();
  }

  @Get("confidence")
  confidence() {
    return this.evolution.researchConfidence();
  }

  @UseGuards(AdminGuard)
  @Post("queue")
  enqueue(@Body() body: unknown) {
    return this.evolution.enqueue(body);
  }

  @Get("reports/:id")
  report(@Param("id") id: string) {
    return this.evolution.getReport(id);
  }

  @UseGuards(AdminGuard)
  @Post("promote")
  promote(@Body() body: unknown, @Req() request: RequestWithUser) {
    return this.evolution.promotePaperStrategy(body, request.user?.email ?? "");
  }

  @UseGuards(AdminGuard)
  @Post("promote/unvalidated")
  promoteUnvalidated(@Body() body: unknown, @Req() request: RequestWithUser) {
    return this.evolution.applyUnvalidatedPaperExperiment(body, request.user?.email ?? "");
  }
}
