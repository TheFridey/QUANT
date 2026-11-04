import { Controller, Get, Param, Query } from "@nestjs/common";
import { FeedbackService } from "./feedback.service.js";

/**
 * GENESIS Phase 7 read-only trade feedback. Authenticated by the global JWT guard and scoped to the
 * terminal's active account, like the ASCEND-09 lot endpoints. GET only; every list is limit-bounded.
 */
@Controller("terminal/feedback")
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  @Get("summary")
  summary(@Query("limit") limit?: string) {
    return this.feedback.summary({ limit });
  }

  @Get("hypothetical")
  hypothetical(@Query("limit") limit?: string) {
    return this.feedback.hypothetical({ limit });
  }

  @Get("lots/:lotKey")
  lot(@Param("lotKey") lotKey: string) {
    return this.feedback.lot(lotKey);
  }
}
