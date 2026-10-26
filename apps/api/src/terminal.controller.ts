import { Body, Controller, Get, Param, Patch, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import IORedis from "ioredis";
import { AdminGuard, Public, type RequestWithUser } from "./http.js";
import { TerminalService } from "./terminal.service.js";

@Controller()
export class TerminalController {
  constructor(private readonly terminal: TerminalService) {}

  @Public()
  @Get("health")
  async health() {
    const redis = await pingRedis();
    return this.terminal.health(async () => redis);
  }

  @Public()
  @Get("ready")
  async ready(@Res({ passthrough: true }) response: Response) {
    const redis = await pingRedis();
    const report = await this.terminal.health(async () => redis);
    if (report.status !== "ok") response.status(503);
    return report;
  }

  @Get("terminal/snapshot")
  snapshot() {
    return this.terminal.snapshot();
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

  @Get("cycles/:id")
  cycle(@Param("id") id: string) {
    return this.terminal.snapshot().then((snapshot) => ({ snapshot, focus: id }));
  }
}

async function pingRedis(): Promise<boolean> {
  const url = process.env.REDIS_URL;
  if (!url) return false;
  const redis = new IORedis(url, { maxRetriesPerRequest: 1, connectTimeout: 1000 });
  try {
    return (await redis.ping()) === "PONG";
  } catch {
    return false;
  } finally {
    redis.disconnect();
  }
}
