import { BadRequestException, Controller, Get, NotFoundException, Param } from "@nestjs/common";
import { OpportunitiesService } from "./opportunities.service.js";

/**
 * OPERATION HORIZON opportunity scanner. Read only and behind the global JWT guard (no @Public). GET only;
 * every query is bounded (OPPORTUNITY_BOUNDS). The scanner never creates intents or orders and never
 * changes configuration.
 */
@Controller("research")
export class OpportunitiesController {
  constructor(private readonly opportunities: OpportunitiesService) {}

  @Get("opportunities")
  list() {
    return this.opportunities.opportunities();
  }

  @Get("markets/:id")
  async market(@Param("id") id: string) {
    if (!/^[A-Za-z0-9:._-]{1,64}$/.test(id)) throw new BadRequestException("invalid instrument id");
    const result = await this.opportunities.market(id);
    if (!result) throw new NotFoundException("unknown instrument");
    return result;
  }
}
