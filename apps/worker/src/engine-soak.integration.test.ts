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

const pairAddress = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE";
const config = { ...DEFAULT_STRATEGY, multiMarketPaperIngest: false, paperLatencyMs: 0 };

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
            data: [
              {
                source: "dexscreener",
                chainId: "solana",
                pairAddress,
                dexId: "orca",
                url: `https://dexscreener.com/solana/${pairAddress}`,
                baseAddress: "So11111111111111111111111111111111111111112",
                baseSymbol: "SOL",
                baseName: "Wrapped SOL",
                quoteAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                quoteSymbol: "USDC",
                priceUsd: "100",
                liquidityUsd: "1000000",
                volume24hUsd: "5000000",
                volume5mUsd: "10000",
                priceChangeM5Pct: String(1 + Math.random() * 3),
                priceChangeH1Pct: "1.2",
                priceChangeH24Pct: "4",
                txnsM5Buys: 80,
                txnsM5Sells: 20,
                raw: { soak: true },
              },
            ],
          };
        },
      };

      const runner = new StageRunner(prisma, feed, silentBus, "live", () => new Date());
      const wallStart = Date.now();
      const deadline = wallStart + soakSeconds * 1000;
      let cycles = 0;
      let fills = 0;
      let errors = 0;

      while (Date.now() < deadline) {
        try {
          await prisma.cycleRun.updateMany({
            where: { status: "RUNNING" },
            data: { status: "FAILED", error: "SOAK_RESET", finishedAt: new Date() },
          });
          const ingested = await runner.ingest({ trigger: `soak-${cycles}` });
          if (!ingested.skipped) {
            await runner.sentinel(ingested.cycleId);
            await runner.pulse(ingested.cycleId);
            await runner.aegis(ingested.cycleId);
            await runner.atlas(ingested.cycleId);
            await runner.executor(ingested.cycleId);
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
        }),
      );

      expect(errors).toBe(0);
      expect(cycles).toBeGreaterThan(0);
      expect(wallMs).toBeGreaterThanOrEqual(soakSeconds * 1000 - 500);
    },
    Math.max(30_000, soakSeconds * 1000 + 20_000),
  );
});
