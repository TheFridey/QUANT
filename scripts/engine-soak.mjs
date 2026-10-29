#!/usr/bin/env node
/**
 * §33 Sustained engine soak — actual StageRunner + Postgres (not helper slot soak).
 *
 * Usage:
 *   DATABASE_URL=postgresql://odin:odin@127.0.0.1:5432/odin_test \
 *   SOAK_SECONDS=12 pnpm exec tsx scripts/engine-soak.mjs
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const seconds = Math.max(1, Number(process.env.SOAK_SECONDS ?? "10"));
const databaseUrl = process.env.DATABASE_URL || process.env.DATABASE_URL_TEST;
if (!databaseUrl) {
  console.log(JSON.stringify({ ok: false, error: "DATABASE_URL required" }));
  process.exit(2);
}

// Resolve @odin/* to package sources the same way vitest does.
register("data:text/javascript," + encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    const map = {
      "@odin/shared": "${root}/packages/shared/src/index.ts",
      "@odin/shared/db": "${root}/packages/shared/src/db.ts",
      "@odin/shared/bootstrap": "${root}/packages/shared/src/bootstrap.ts",
      "@odin/agent-core": "${root}/packages/agent-core/src/index.ts",
      "@odin/analytics": "${root}/packages/analytics/src/index.ts",
      "@odin/market-data": "${root}/packages/market-data/src/index.ts",
      "@odin/risk-engine": "${root}/packages/risk-engine/src/index.ts",
      "@odin/trading-engine": "${root}/packages/trading-engine/src/index.ts",
      "@odin/evolution": "${root}/packages/evolution/src/index.ts",
    };
    if (map[specifier]) {
      return { shortCircuit: true, url: "file://" + map[specifier] };
    }
    return nextResolve(specifier, context);
  }
`), pathToFileURL("./"));

const { PrismaClient } = await import("@odin/shared/db");
const { DEFAULT_STRATEGY } = await import("@odin/shared");
const { ensureFoundation } = await import("@odin/shared/bootstrap");
const { toJson } = await import("@odin/shared/db");
const { StageRunner, silentBus } = await import(
  pathToFileURL(resolve(root, "apps/worker/src/stage-runner.ts")).href
);

const wallStart = Date.now();
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const pairAddress = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE";
const feed = {
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

await ensureFoundation(prisma, {
  email: process.env.ADMIN_EMAIL ?? "admin@odin.local",
  password: process.env.ADMIN_PASSWORD ?? "odin-paper-dev",
  config: { ...DEFAULT_STRATEGY, multiMarketPaperIngest: false, paperLatencyMs: 0 },
});
await prisma.engineControl.update({
  where: { id: "primary" },
  data: {
    status: "RUNNING",
    config: toJson({ ...DEFAULT_STRATEGY, multiMarketPaperIngest: false, paperLatencyMs: 0 }),
  },
});

const runner = new StageRunner(prisma, feed, silentBus, "live", () => new Date());
let cycles = 0;
let fills = 0;
let errors = 0;
const deadline = wallStart + seconds * 1000;

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
await prisma.$disconnect();

const result = {
  ok: errors === 0 && cycles > 0,
  label: "engine_worker_db_soak",
  helperNotFullEngine: false,
  soakSecondsRequested: seconds,
  wallClockMs: wallMs,
  wallClockSeconds: Number((wallMs / 1000).toFixed(3)),
  cyclesCompleted: cycles,
  fillsObserved: fills,
  errors,
  note: "StageRunner+Postgres soak; fixture-shaped market feed; no external broker.",
};
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
