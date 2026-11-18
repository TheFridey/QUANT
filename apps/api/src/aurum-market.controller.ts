import { BadRequestException, Controller, Get, NotFoundException, Query } from "@nestjs/common";
import { legacyRetirementFromEnv } from "@odin/shared";
import { PrismaClient } from "@odin/shared/db";

/**
 * HELIOS: AURUM COMMAND gold market data. Read-only, behind the global JWT guard (no @Public), GET only.
 * Serves genuine warehouse bars for XAU_USD datasets. Nothing is synthesised: a dataset with no bars returns no
 * candles. Bars are historical warehouse data, never presented as live quotes; the shadow quote feed is not
 * persisted in production yet, so the live section reports it as inactive rather than inventing a price.
 */

export const GOLD_INSTRUMENT_KEYS = ["XAU_USD", "XAUUSD", "commodity:XAUUSD"] as const;
const INTERVAL_MS: Record<string, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };
export const MAX_CANDLES = 2_000;

type BarRow = { openTime: Date; open: unknown; high: unknown; low: unknown; close: unknown; extra: unknown };

export type GoldCandle = { t: number; o: string; h: string; l: string; c: string; bidC: string | null; askC: string | null; spreadC: string | null };
export type CandleGap = { afterT: number; beforeT: number; missingBars: number };

/** Gaps between consecutive bars wider than one interval. Closed sessions (daily break, weekends) appear here too. */
export function findCandleGaps(times: readonly number[], intervalMs: number): CandleGap[] {
  const gaps: CandleGap[] = [];
  for (let i = 1; i < times.length; i++) {
    const d = times[i]! - times[i - 1]!;
    if (d > intervalMs) gaps.push({ afterT: times[i - 1]!, beforeT: times[i]!, missingBars: Math.round(d / intervalMs) - 1 });
  }
  return gaps;
}

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = typeof v === "string" ? v : typeof v === "number" ? String(v) : (v as { toString(): string }).toString();
  return s === "" ? null : s;
}

export function toCandle(row: BarRow): GoldCandle {
  const extra = (row.extra && typeof row.extra === "object" ? row.extra : {}) as Record<string, unknown>;
  return {
    t: row.openTime.getTime(),
    o: text(row.open)!,
    h: text(row.high)!,
    l: text(row.low)!,
    c: text(row.close)!,
    bidC: text(extra.bid_c),
    askC: text(extra.ask_c),
    spreadC: text(extra.spread_c),
  };
}

@Controller("aurum/market")
export class AurumMarketController {
  constructor(private readonly prisma: PrismaClient) {}

  /** Gold datasets in the warehouse, with their identity and coverage. */
  @Get("datasets")
  async datasets() {
    const rows = await this.prisma.historicalDataset.findMany({
      where: { instrumentKey: { in: [...GOLD_INSTRUMENT_KEYS] } },
      select: { id: true, sourceId: true, instrumentKey: true, interval: true, barCount: true, firstOpenTime: true, lastOpenTime: true, versionHash: true, updatedAt: true, licence: true },
      orderBy: [{ interval: "asc" }, { sourceId: "asc" }],
    });
    return {
      datasets: rows.map((r) => ({
        ...r,
        alignment: r.sourceId.endsWith("_ny17") ? "NEW_YORK_17" : "UTC",
        firstOpenTime: r.firstOpenTime?.toISOString() ?? null,
        lastOpenTime: r.lastOpenTime?.toISOString() ?? null,
        updatedAt: r.updatedAt.toISOString(),
      })),
      dataKind: "HISTORICAL_WAREHOUSE_BARS" as const,
    };
  }

  /** The latest `limit` bars of one gold dataset (ascending), with bid/ask closes where stored and gaps. */
  @Get("candles")
  async candles(@Query("datasetId") datasetId?: string, @Query("limit") limitText?: string) {
    if (!datasetId || !/^[A-Za-z0-9_-]{1,64}$/.test(datasetId)) throw new BadRequestException("invalid dataset id");
    const limit = limitText === undefined ? 500 : Number(limitText);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CANDLES) throw new BadRequestException(`limit must be 1..${MAX_CANDLES}`);
    const dataset = await this.prisma.historicalDataset.findUnique({
      where: { id: datasetId },
      select: { id: true, sourceId: true, instrumentKey: true, interval: true, versionHash: true, barCount: true, firstOpenTime: true, lastOpenTime: true },
    });
    if (!dataset || !(GOLD_INSTRUMENT_KEYS as readonly string[]).includes(dataset.instrumentKey)) throw new NotFoundException("gold dataset not found");
    const rows = await this.prisma.historicalBar.findMany({
      where: { datasetId },
      orderBy: { openTime: "desc" },
      take: limit,
      select: { openTime: true, open: true, high: true, low: true, close: true, extra: true },
    });
    const candles = rows.reverse().map(toCandle);
    const intervalMs = INTERVAL_MS[dataset.interval] ?? null;
    return {
      dataset: { ...dataset, firstOpenTime: dataset.firstOpenTime?.toISOString() ?? null, lastOpenTime: dataset.lastOpenTime?.toISOString() ?? null },
      dataKind: "HISTORICAL_WAREHOUSE_BARS" as const,
      priceComponent: "MID_OHLC" as const,
      candles,
      gaps: intervalMs ? findCandleGaps(candles.map((c) => c.t), intervalMs) : [],
      bidAskCoverage: candles.length === 0 ? null : candles.filter((c) => c.bidC !== null && c.askC !== null).length / candles.length,
    };
  }

  /** Programme status for the command view. Every value here is a stated fact, never an inferred capability. */
  @Get("status")
  status() {
    const legacy = legacyRetirementFromEnv();
    return {
      legacyCrypto: { mode: legacy.mode, source: "API_PROCESS_ENV" as const },
      shadowFeed: { state: "INACTIVE" as const, persisted: false, reason: "Shadow feed not activated in production; durable quote store not deployed (D11)." },
      account: { state: "NOT_CREATED" as const },
      execution: { state: "BLOCKED" as const, reason: "No AURUM order path exists; C3/C10 not implemented." },
      research: { state: "BLOCKED" as const, reason: "Historical trial declaration (D7) outstanding." },
      executable: false as const,
    };
  }
}
