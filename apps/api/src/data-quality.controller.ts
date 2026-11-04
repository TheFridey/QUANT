import { BadRequestException, Controller, Get, NotFoundException, Param, Query } from "@nestjs/common";
import { datasetQuality, listDatasetsForQuality } from "@odin/market-data";
import { PrismaClient } from "@odin/shared/db";

/**
 * GENESIS Phase 3 read-only dataset quality. Behind the global JWT guard like every non-@Public route;
 * GET only, SELECTs only (the shared loader in @odin/market-data). The list reads dataset metadata, never
 * bars; the detail reads one dataset's bars, bounded by the ASCEND-01 per-dataset quota.
 */
@Controller("research/data-quality")
export class DataQualityController {
  constructor(private readonly prisma: PrismaClient) {}

  @Get()
  list() {
    return listDatasetsForQuality(this.prisma, new Date());
  }

  @Get(":datasetId")
  async detail(
    @Param("datasetId") datasetId: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("maxListed") maxListed?: string,
  ) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(datasetId)) throw new BadRequestException("invalid dataset id");
    const fromMs = from === undefined ? undefined : Date.parse(from);
    const toMs = to === undefined ? undefined : Date.parse(to);
    if ((fromMs === undefined) !== (toMs === undefined)) throw new BadRequestException("from and to go together");
    if ((fromMs !== undefined && !Number.isFinite(fromMs)) || (toMs !== undefined && !Number.isFinite(toMs)) || (fromMs !== undefined && toMs! < fromMs)) {
      throw new BadRequestException("from/to must be ISO timestamps with from <= to");
    }
    const listed = Math.min(Math.max(Number(maxListed ?? 50) || 50, 0), 500);
    const report = await datasetQuality(this.prisma, datasetId, new Date(), {
      maxListed: listed,
      ...(fromMs !== undefined && toMs !== undefined ? { window: { fromOpenTime: fromMs, toOpenTime: toMs } } : {}),
    });
    if (!report) throw new NotFoundException("dataset not found");
    return report;
  }
}
