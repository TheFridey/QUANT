import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { CAMPAIGN_LIMIT_BOUNDS, type CampaignDataset, type RawBars } from "@odin/evolution/campaign";
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
  if (row.interval !== dataset.interval) throw new DatasetLoadError(`warehouse dataset ${row.id} is ${row.interval}, but the campaign declares ${dataset.interval}`);
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
