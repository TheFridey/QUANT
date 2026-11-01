import "../load-env.js";
import { AlpacaBarsSource, GeckoTerminalPoolSource, runBackfill, type HistoricalBarSource, type HistoryInterval } from "@odin/market-data";
import { PrismaClient } from "@odin/shared/db";
import { ensureBackfillJob, PrismaBackfillStore } from "./prisma-backfill-store.js";

/**
 * ASCEND-01 bounded backfill, run by hand (or a timer) outside the trading loop:
 *
 *   node dist/src/history/backfill-cli.js <geckoterminal|alpaca_iex> <instrumentKey> <interval> <cohort> <startISO> <endISO> [maxRequests]
 *
 * Re-running the same arguments resumes the open job from its checkpoint. Read-only against providers.
 */
async function main() {
  const [sourceId, instrumentKey, interval, cohort, start, end, maxRequestsText] = process.argv.slice(2);
  if (!sourceId || !instrumentKey || !interval || !cohort || !start || !end) {
    console.error("usage: backfill-cli <geckoterminal|alpaca_iex> <instrumentKey> <interval> <cohort> <startISO> <endISO> [maxRequests]");
    process.exit(2);
  }
  let source: HistoricalBarSource;
  let instrumentKind: string;
  if (sourceId === "geckoterminal") {
    source = new GeckoTerminalPoolSource();
    instrumentKind = "SOLANA_POOL";
  } else if (sourceId === "alpaca_iex") {
    source = new AlpacaBarsSource({ keyId: process.env.ALPACA_API_KEY_ID?.trim(), secret: process.env.ALPACA_API_SECRET_KEY?.trim(), dataUrl: process.env.ALPACA_DATA_BASE_URL?.trim() || undefined });
    instrumentKind = "EQUITY_ETF";
  } else {
    throw new Error(`unknown source ${sourceId}`);
  }
  const maxRequests = Math.min(Math.max(Number(maxRequestsText ?? 20) || 20, 1), 200);
  const prisma = new PrismaClient();
  let stop = false;
  process.on("SIGTERM", () => (stop = true));
  process.on("SIGINT", () => (stop = true));
  try {
    const job = await ensureBackfillJob(prisma, {
      source,
      instrumentKey,
      instrumentKind,
      cohort,
      interval: interval as HistoryInterval,
      windowStart: new Date(start),
      windowEnd: new Date(end),
      maxWindowDays: 3660,
    });
    const result = await runBackfill({ job, source, store: new PrismaBackfillStore(prisma), options: { maxRequests, shouldStop: () => stop } });
    console.log(JSON.stringify({ jobId: result.job.id, status: result.job.status, stoppedBy: result.stoppedBy, requests: result.requests, rowsImported: result.job.rowsImported, rowsRejected: result.job.rowsRejected, revisions: result.job.revisionsDetected, lastError: result.job.lastError }));
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
