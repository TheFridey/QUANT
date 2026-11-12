import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { CAMPAIGN_LIMIT_BOUNDS, normaliseInstrument, type CampaignDataset, type RawBars } from "@odin/evolution/campaign";
import type { PrismaClient } from "@odin/shared/db";
import { parseBarsCsv } from "./ml-args.js";

/**
 * Loads the bars a campaign dataset declares. This is the only I/O of an evaluation and it happens before the
 * evaluator starts: a warehouse read bounded by the declared as-of instant, or a local file whose SHA-256 must
 * equal the declared one. Nothing is fetched from a network.
 */
export class DatasetLoadError extends Error {
  constructor(message: string) {
    super(`DATASET_LOAD: ${message}`);
    this.name = "DatasetLoadError";
  }
}

/**
 * OPERATION INTEGRITY F08: warehouse instrument kinds each campaign market may study. A kind not listed here is
 * refused rather than guessed. Values are the `HistoricalDataset.instrumentKind` strings the backfill writes.
 */
export const WAREHOUSE_KINDS_BY_MARKET: Record<CampaignDataset["market"], readonly string[]> = {
  CRYPTO: ["SOLANA_POOL", "DEX_POOL"],
  ETF: ["EQUITY_ETF"],
  FX: ["FX_PAIR"],
  GOLD: ["COMMODITY", "COMMODITY_FUTURE"],
};

/**
 * The warehouse row must be the instrument, product type and interval the campaign declares. Instruments are
 * compared after the same normalisation the holdout ledger uses, so formatting aliases (EUR_USD, EUR/USD,
 * fx:EURUSD) match and different instruments (EUR/USD declared as XAU/USD) do not. A deliberate proxy study
 * is not supported here: it must be declared as its own instrument rather than pass as another.
 * Returns null when consistent, else the reason.
 */
export function warehouseIdentityMismatch(dataset: Pick<CampaignDataset, "market" | "instrument" | "interval">, row: { id: string; instrumentKey: string; instrumentKind: string; interval: string }): string | null {
  if (row.interval !== dataset.interval) return `warehouse dataset ${row.id} is ${row.interval}, but the campaign declares ${dataset.interval}`;
  let declared: string, stored: string;
  try {
    declared = normaliseInstrument(dataset.instrument);
    stored = normaliseInstrument(row.instrumentKey);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (declared !== stored) return `warehouse dataset ${row.id} is instrument ${row.instrumentKey} (${stored}), but the campaign declares ${dataset.instrument} (${declared})`;
  const kinds = WAREHOUSE_KINDS_BY_MARKET[dataset.market] ?? [];
  if (!kinds.includes(row.instrumentKind)) return `warehouse dataset ${row.id} is a ${row.instrumentKind}, which the ${dataset.market} market does not study (expected ${kinds.join(" or ") || "none"})`;
  return null;
}

export async function loadRawBars(prisma: PrismaClient, dataset: CampaignDataset, baseDir: string): Promise<RawBars> {
  if (dataset.source.kind === "FILE") {
    const path = isAbsolute(dataset.source.path) ? dataset.source.path : resolve(baseDir, dataset.source.path);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      throw new DatasetLoadError(`cannot read ${dataset.source.path}`);
    }
    const sha256 = createHash("sha256").update(text).digest("hex");
    if (sha256 !== dataset.source.sha256) throw new DatasetLoadError(`${dataset.source.path} hashes to ${sha256}, but the campaign declares ${dataset.source.sha256}; the file is not the declared dataset`);
    const parsed = parseBarsCsv(text);
    const hasAvailability = parsed.length > 0 && parsed.every((b) => b.availableAt !== null);
    return {
      bars: parsed.map(({ t, open, high, low, close, volume }) => ({ t, open, high, low, close, volume })),
      availableAt: hasAvailability ? parsed.map((b) => b.availableAt!) : null,
      tickVolumes: null,
      source: { kind: "FILE", path: dataset.source.path, sha256, rows: parsed.length },
    };
  }
  const row = await prisma.historicalDataset.findUnique({ where: { id: dataset.source.datasetId } });
  if (!row) throw new DatasetLoadError(`warehouse dataset ${dataset.source.datasetId} does not exist`);
  // Checked before any bar is read, so a mismatched dataset costs nothing and produces no result (F08).
  const mismatch = warehouseIdentityMismatch(dataset, row);
  if (mismatch) throw new DatasetLoadError(mismatch);
  const max = CAMPAIGN_LIMIT_BOUNDS.maxBarsPerDataset;
  // One more than the limit, so an oversized dataset is refused rather than silently truncated.
  const rows = await prisma.historicalBar.findMany({ where: { datasetId: row.id, availableAt: { lte: new Date(dataset.asOf) } }, orderBy: { openTime: "asc" }, take: max + 1 });
  if (rows.length > max) throw new DatasetLoadError(`warehouse dataset ${row.id} has more than ${max} bars available at ${dataset.asOf}`);
  return {
    bars: rows.map((r) => ({ t: r.openTime.getTime(), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: r.volume === null ? null : Number(r.volume) })),
    availableAt: rows.map((r) => r.availableAt.getTime()),
    tickVolumes: rows.map((r) => {
      const extra = r.extra && typeof r.extra === "object" && !Array.isArray(r.extra) ? (r.extra as Record<string, unknown>) : null;
      const ticks = extra ? Number(extra.tickVolume) : Number.NaN;
      return Number.isFinite(ticks) ? ticks : null;
    }),
    source: { kind: "WAREHOUSE", datasetId: row.id, sourceId: row.sourceId, instrumentKey: row.instrumentKey, instrumentKind: row.instrumentKind, interval: row.interval, rowsRead: rows.length },
  };
}
