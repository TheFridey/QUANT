/**
 * §33 Sustained StageRunner + Postgres soak.
 * Duration from SOAK_SECONDS (default 8 in CI to keep runtime bounded).
 */
import { DEFAULT_STRATEGY, INTEGRATION_TEST_ADVISORY_LOCK } from "@odin/shared";
import { ensureFoundation } from "@odin/shared/bootstrap";
import { PrismaClient, toJson } from "@odin/shared/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { silentBus, StageRunner, type MarketFeed } from "./stage-runner.js";

const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));
const soakSeconds = Math.max(1, Number(process.env.SOAK_SECONDS ?? "8"));

// Audit B5: soak at the default universe size (24 pairs) so executor transactions carry real load.
const UNIVERSE = 24;
const BASE58_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const pairAddresses = Array.from({ length: UNIVERSE }, (_, index) => `Soak${BASE58_LETTERS[index]}`.padEnd(44, "1"));
const config = { ...DEFAULT_STRATEGY, multiMarketPaperIngest: false, paperLatencyMs: 0, universeLimit: UNIVERSE };

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? null;
}

describe.skipIf(!enabled)("engine soak StageRunner+DB", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRaw`SELECT pg_advisory_lock(${INTEGRATION_TEST_ADVISORY_LOCK})`;
    await ensureFoundation(prisma, {
      email: process.env.ADMIN_EMAIL ?? "admin@odin.local",
      password: process.env.ADMIN_PASSWORD ?? "odin-paper-dev",
      config,
    });
    await prisma.engineControl.update({
      where: { id: "primary" },
      data: { status: "RUNNING", config: toJson(config) },
    });
  }, 60_000);

  afterAll(async () => {
    await prisma.$executeRaw`SELECT pg_advisory_unlock(${INTEGRATION_TEST_ADVISORY_LOCK})`;
    await prisma.$disconnect();
  });

  it(
    `runs StageRunner cycles for ~${soakSeconds}s wall clock`,
    async () => {
      const feed: MarketFeed = {
        async fetchUniverse() {
          return {
            ok: true,
            fetchedAt: new Date().toISOString(),
            data: pairAddresses.map((pairAddress, index) => ({
              source: "dexscreener",
              chainId: "solana",
              pairAddress,
              dexId: "orca",
              url: `https://dexscreener.com/solana/${pairAddress}`,
              baseAddress: `Base${BASE58_LETTERS[index]}`.padEnd(44, "1"),
              baseSymbol: `SK${BASE58_LETTERS[index]}`,
              baseName: `Soak ${BASE58_LETTERS[index]}`,
              quoteAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
              quoteSymbol: "USDC",
              priceUsd: String(100 + index + Math.random()),
              liquidityUsd: "1000000",
              volume24hUsd: "5000000",
              volume5mUsd: "10000",
              priceChangeM5Pct: String(Math.random() * 6 - 2),
              priceChangeH1Pct: "1.2",
              priceChangeH24Pct: "4",
              txnsM5Buys: 80,
              txnsM5Sells: 20,
              raw: { soak: true },
            })),
          };
        },
      };

      const runner = new StageRunner(prisma, feed, silentBus, "live", () => new Date());
      const wallStart = Date.now();
      const deadline = wallStart + soakSeconds * 1000;
      let cycles = 0;
      let fills = 0;
      let errors = 0;
      const transactionMs: number[] = [];
      const ingestToExecutorMs: number[] = [];

      while (Date.now() < deadline) {
        try {
          await prisma.cycleRun.updateMany({
            where: { status: "RUNNING" },
            data: { status: "FAILED", error: "SOAK_RESET", finishedAt: new Date() },
          });
          const ingestStarted = Date.now();
          const ingested = await runner.ingest({ trigger: `soak-${cycles}` });
          if (!ingested.skipped) {
            await runner.sentinel(ingested.cycleId);
            await runner.pulse(ingested.cycleId);
            await runner.aegis(ingested.cycleId);
            await runner.atlas(ingested.cycleId);
            ingestToExecutorMs.push(Date.now() - ingestStarted);
            await runner.executor(ingested.cycleId);
            const cycle = await prisma.cycleRun.findUnique({ where: { id: ingested.cycleId } });
            const timings = cycle?.executorTimings as Record<string, number> | null;
            if (timings && typeof timings.transaction === "number") transactionMs.push(timings.transaction);
            await runner.archivist(ingested.cycleId);
            fills += await prisma.fill.count({ where: { order: { cycleId: ingested.cycleId } } });
            cycles += 1;
          }
        } catch {
          errors += 1;
          if (errors > 5) break;
        }
      }

      const wallMs = Date.now() - wallStart;
      console.log(
        JSON.stringify({
          ok: errors === 0 && cycles > 0,
          label: "engine_worker_db_soak",
          soakSecondsRequested: soakSeconds,
          wallClockMs: wallMs,
          wallClockSeconds: Number((wallMs / 1000).toFixed(3)),
          cyclesCompleted: cycles,
          fillsObserved: fills,
          errors,
          universe: UNIVERSE,
          executorTransactionMs: { p50: percentile(transactionMs, 50), p95: percentile(transactionMs, 95), max: percentile(transactionMs, 100) },
          ingestToExecutorMs: { p50: percentile(ingestToExecutorMs, 50), p95: percentile(ingestToExecutorMs, 95) },
        }),
      );
      // Every executor run records its phase timings (audit H3).
      expect(transactionMs.length).toBe(cycles);

      expect(errors).toBe(0);
      expect(cycles).toBeGreaterThan(0);
      expect(wallMs).toBeGreaterThanOrEqual(soakSeconds * 1000 - 500);
    },
    Math.max(30_000, soakSeconds * 1000 + 20_000),
  );
});
