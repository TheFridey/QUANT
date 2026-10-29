import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { AdminGuard, type RequestWithUser } from "./http.js";
import { OperatorCapacityService } from "./operator-capacity.service.js";

@Controller()
export class OperatorController {
  constructor(private readonly operator: OperatorCapacityService) {}

  @Get("terminal/capacity")
  capacity() {
    return this.operator.capacity();
  }

  @Get("terminal/why-no-trades")
  whyNoTrades(@Query("window") window?: string) {
    return this.operator.whyNoTrades(window);
  }

  @Get("terminal/safety/recover")
  recoveryPrerequisites() {
    return this.operator.recoveryPrerequisites();
  }

  @UseGuards(AdminGuard)
  @Post("terminal/safety/recover")
  recover(@Req() request: RequestWithUser) {
    return this.operator.recoverSafety(request.user?.email ?? "unknown");
  }

  @UseGuards(AdminGuard)
  @Patch("strategy-instances/:id")
  updateInstance(@Param("id") id: string, @Body() body: unknown, @Req() request: RequestWithUser) {
    return this.operator.updateStrategyInstance(id, body, request.user?.email ?? "unknown");
  }
}
