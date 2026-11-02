import { Controller, Get, Param, Query } from "@nestjs/common";
import { TradeLotsService } from "./trade-lots.service.js";

/**
 * ASCEND-09 read-only lot history. Authenticated by the global JWT guard and scoped to the terminal's
 * active account, like the other terminal endpoints. GET only.
 */
@Controller("terminal/lots")
export class TradeLotsController {
  constructor(private readonly lots: TradeLotsService) {}

  @Get()
  list(
    @Query("status") status?: string,
    @Query("pair") pair?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    return this.lots.listLots({ status, pair, limit, offset });
  }

  /** Declared before ":lotKey" so it is not captured as a lot key. */
  @Get("attribution")
  attribution() {
    return this.lots.attribution();
  }

  @Get(":lotKey")
  timeline(@Param("lotKey") lotKey: string) {
    return this.lots.lotTimeline(lotKey);
  }
}
