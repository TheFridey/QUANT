import { Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { AdminGuard, type RequestWithUser } from "./http.js";
import { LabService } from "./lab.service.js";

@Controller("lab")
export class LabController {
  constructor(private readonly lab: LabService) {}

  @Get("strategies")
  listStrategies() {
    return this.lab.listStrategyVersions();
  }

  @UseGuards(AdminGuard)
  @Post("strategies")
  createStrategy(@Body() body: unknown, @Req() request: RequestWithUser) {
    return this.lab.createStrategyVersion(body, request.user?.email ?? "unknown");
  }

  @Get("backtests")
  listBacktests() {
    return this.lab.listBacktests();
  }

  @Get("backtests/compare")
  compare(@Query("ids") ids = "") {
    const list = ids
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    return this.lab.compareBacktests(list);
  }

  @Get("backtests/:id")
  getBacktest(@Param("id") id: string) {
    return this.lab.getBacktest(id);
  }

  @Get("backtests/:id/report")
  async report(@Param("id") id: string, @Res() response: Response) {
    const { html, filename } = await this.lab.exportReport(id);
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("content-disposition", `attachment; filename="${filename}"`);
    response.send(html);
  }

  @UseGuards(AdminGuard)
  @Post("backtests")
  runBacktest(@Body() body: unknown, @Req() request: RequestWithUser) {
    return this.lab.runBacktest(body, request.user?.email ?? "unknown");
  }

  @UseGuards(AdminGuard)
  @Post("backtests/:id/oracle")
  oracle(@Param("id") id: string) {
    return this.lab.requestOracleReview(id);
  }

  @UseGuards(AdminGuard)
  @Post("oracle/:id/approve")
  approveOracle(@Param("id") id: string, @Req() request: RequestWithUser) {
    return this.lab.approveOracle(id, request.user?.email ?? "unknown");
  }

  @Get("observability")
  observability() {
    return this.lab.observabilitySummary();
  }
}
