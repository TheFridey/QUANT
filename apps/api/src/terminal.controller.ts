import { Body, Controller, Get, Param, Patch, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { RedisHealth } from "./redis-health.js";
import { AdminGuard, Public, type RequestWithUser } from "./http.js";
import { TerminalService } from "./terminal.service.js";

@Controller()
export class TerminalController {
  constructor(
    private readonly terminal: TerminalService,
    private readonly redisHealth: RedisHealth,
  ) {}

  /** Public liveness: status only (audit M9). Component detail is behind auth at health/detail. */
  @Public()
  @Get("health")
  async health() {
    const report = await this.terminal.health(() => this.redisHealth.ping());
    return { status: report.status };
  }

  /** Public readiness for orchestrators: status only, 503 when degraded. */
  @Public()
  @Get("ready")
  async ready(@Res({ passthrough: true }) response: Response) {
    const report = await this.terminal.health(() => this.redisHealth.ping());
    if (report.status !== "ok") response.status(503);
    return { status: report.status };
  }

  /** Authenticated component detail: postgres, redis, engine, data state and cycle timing. */
  @Get("health/detail")
  healthDetail() {
    return this.terminal.health(() => this.redisHealth.ping());
  }

  @Get("terminal/snapshot")
  snapshot() {
    return this.terminal.snapshot();
  }

  @Get("terminal/equity")
  equity(@Query("range") range = "24H") {
    return this.terminal.equityHistory(range);
  }

  /** Paginated order/trade ledger beyond the snapshot's recent-40 window (D22). */
  @Get("terminal/history")
  history(
    @Query("kind") kind = "orders",
    @Query("limit") limit = "40",
    @Query("offset") offset = "0",
    @Query("side") side?: string,
    @Query("symbol") symbol?: string,
    @Query("status") status?: string,
  ) {
    return this.terminal.orderHistory({
      kind: kind === "trades" ? "trades" : kind === "all" ? "all" : "orders",
      limit: Number(limit) || 40,
      offset: Number(offset) || 0,
      side: side || undefined,
      symbol: symbol || undefined,
      status: status || undefined,
    });
  }

  @Get("terminal/activity")
  activity(@Query("limit") limit = "80") {
    return this.terminal.activityFeed(Number(limit) || 80);
  }

  @Get("terminal/decisions/:id")
  decision(@Param("id") id: string) {
    return this.terminal.decisionDetail(id);
  }

  @Get("terminal/agents/:agent")
  agent(@Param("agent") agent: string) {
    return this.terminal.agentDetail(agent);
  }

  @Get("terminal/logs")
  logs(@Query("limit") limit = "100") {
    return this.terminal.systemLogs(Number(limit) || 100);
  }

  @Get("terminal/alerts")
  alerts(@Query("includeAcked") includeAcked = "false") {
    return this.terminal.listAlerts(includeAcked === "true");
  }

  @UseGuards(AdminGuard)
  @Post("terminal/alerts/:id/ack")
  ackAlert(@Param("id") id: string, @Req() request: RequestWithUser) {
    return this.terminal.ackAlert(id, request.user?.email ?? "unknown");
  }

  @Get("market/observations")
  observations(@Query("pairAddress") pairAddress = "") {
    return this.terminal.observations(pairAddress);
  }

  @Get("market/security")
  security(@Query("token") token = "") {
    return this.terminal.birdeyeSecurity(token);
  }

  @Get("market/holders")
  holders(@Query("token") token = "") {
    return this.terminal.birdeyeHolders(token);
  }

  @Get("market/ohlcv")
  ohlcv(@Query("token") token = "") {
    return this.terminal.birdeyeOhlcv(token);
  }

  @UseGuards(AdminGuard)
  @Post("engine/start")
  start(@Req() request: RequestWithUser) {
    return this.terminal.act("start", request.user?.email ?? "unknown");
  }

  @UseGuards(AdminGuard)
  @Post("engine/pause")
  pause(@Req() request: RequestWithUser) {
    return this.terminal.act("pause", request.user?.email ?? "unknown");
  }

  @UseGuards(AdminGuard)
  @Post("engine/resume")
  resume(@Req() request: RequestWithUser) {
    return this.terminal.act("resume", request.user?.email ?? "unknown");
  }

  @UseGuards(AdminGuard)
  @Post("engine/stop")
  stop(@Req() request: RequestWithUser) {
    return this.terminal.act("stop", request.user?.email ?? "unknown");
  }

  @UseGuards(AdminGuard)
  @Post("engine/emergency-stop")
  emergency(@Body() body: unknown, @Req() request: RequestWithUser) {
    return this.terminal.act("emergency_stop", request.user?.email ?? "unknown", body);
  }

  /** ASCEND-00 F6: append-only engine config history, newest first, with the keys each change touched. */
  @Get("engine/config/history")
  configHistory(@Query("limit") limit = "50") {
    return this.terminal.configHistory(limit);
  }

  @UseGuards(AdminGuard)
  @Patch("engine/config")
  config(@Body() body: unknown, @Req() request: RequestWithUser) {
    return this.terminal.updateConfig(body, request.user?.email ?? "unknown");
  }

  @UseGuards(AdminGuard)
  @Post("orders")
  order(@Body() body: unknown) {
    return this.terminal.submitOrder(body);
  }

  @UseGuards(AdminGuard)
  @Get("orders/receipt")
  orderReceipt(@Query("cycleId") cycleId?: string, @Query("clientIntentId") clientIntentId?: string) {
    return this.terminal.orderReceipt({ cycleId, clientIntentId });
  }

  @Get("cycles/:id")
  cycle(@Param("id") id: string) {
    return this.terminal.snapshot().then((snapshot) => ({ snapshot, focus: id }));
  }
}
