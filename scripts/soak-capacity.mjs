#!/usr/bin/env node
/**
 * Production-shaped capacity/soak probe on real Postgres reservation + protection path.
 *
 * IMPORTANT (D27): this script is a **helper harness**, not a full-engine soak.
 * It calls reservation/OCO helpers directly (PostgresReservationAuthority, armLongShortOco,
 * claimOcoTrigger). It does NOT run the worker stage pipeline, market ingest, UI, or
 * end-to-end protected live positions. "50 slots admitted" ≠ "50 filled protected positions
 * under the running engine." Do not cite exit 0 as full-engine or browser capacity proof.
 *
 * Honesty rules (D57):
 * - Labels result `fixture_shaped_soak` when MARKET_DATA_PAPER live feeds are absent.
 * - Labels `mixed_credential_env` only when Alpaca/OANDA env vars are present — still NOT a live SLO.
 * - Never claims VERIFIED_EXTERNAL, VERIFIED_OFFLINE capacity SLO, or production latency budgets.
 * - Exit 0 means the PG reservation/OCO helper path completed; it does not promote D57 beyond PARTIAL.
 * - Uses DATABASE_URL; does not truncate / reset operator databases or contaminate MARKET_DATA_PAPER.
 *
 * Prerequisites: pnpm build:packages && DATABASE_URL set
 *
 * Usage:
 *   node scripts/soak-capacity.mjs
 *   SOAK_SLOTS=50 SOAK_WORKERS=3 node scripts/soak-capacity.mjs
 */
import { performance } from "node:perf_hooks";
import { createPrismaClient } from "../packages/shared/dist/db.js";
import { PostgresReservationAuthority, raceAdmitWorkers } from "../packages/risk-engine/dist/index.js";
import {
  armLongShortOco,
  claimOcoTrigger,
  persistOcoGroup,
} from "../packages/trading-engine/dist/index.js";

function envInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

async function main() {
  const slots = envInt("SOAK_SLOTS", 50);
  const workers = envInt("SOAK_WORKERS", 3);
  const accountId = process.env.SOAK_ACCOUNT_ID || "primary:soak-capacity";
  const hasDb = Boolean(process.env.DATABASE_URL || process.env.DATABASE_URL_TEST);
  if (!hasDb) {
    console.error(JSON.stringify({ ok: false, error: "DATABASE_URL required" }, null, 2));
    process.exit(2);
  }

  const prisma = createPrismaClient();
  const started = performance.now();
  const liveFeeds =
    Boolean(process.env.ALPACA_API_KEY_ID?.trim()) || Boolean(process.env.OANDA_API_TOKEN?.trim());
  const label = liveFeeds ? "mixed_credential_env" : "fixture_shaped_soak";

  try {
    await prisma.paperAccount.upsert({
      where: { id: accountId },
      create: {
        id: accountId,
        cashUsd: "1000000",
        startingBalanceUsd: "1000000",
        tradingEnvironment: "FIXTURE",
      },
      update: { cashUsd: "1000000" },
    });

    await prisma.riskReservationEvent.deleteMany({ where: { accountId } });
    await prisma.riskReservation.deleteMany({ where: { accountId } });
    await prisma.protectionIntent.deleteMany({ where: { accountId } });
    await prisma.protectionOrder.deleteMany({ where: { accountId } });

    const budget = {
      cashAvailableUsd: "1000000.00000000",
      exposureCapUsd: "800000.00000000",
      exposureUsedUsd: "0.00000000",
      slotsAvailable: slots,
      slotsUsed: 0,
      riskBudgetUsd: "200000.00000000",
      riskUsedUsd: "0.00000000",
    };

    const requests = Array.from({ length: slots + 20 }, (_, i) => ({
      id: `soak_rsv_${i}`,
      accountId,
      mode: "PAPER",
      clientOrderId: `soak_slot_${i}`,
      cashUsd: "1000",
      exposureUsd: "1000",
      slots: 1,
      riskUsd: "40",
    }));

    const race = await raceAdmitWorkers({
      prisma,
      accountId,
      mode: "PAPER",
      budget,
      requests,
      workerCount: workers,
    });

    const auth = new PostgresReservationAuthority(prisma);
    const reconstructed = await auth.reconstruct(accountId, budget);

    const protectCount = Math.min(20, race.admitted);
    let ocoClaimsWon = 0;
    for (let i = 0; i < protectCount; i += 1) {
      const groupId = `soak_oco_${accountId}_${i}`;
      const group = armLongShortOco({
        groupId,
        positionKey: `${accountId}:etf:SPY_${i}`,
        direction: "LONG",
        qty: "1",
        entryPriceUsd: "100",
        stopLossPct: "3",
        takeProfitPct: "5",
      });
      await persistOcoGroup(prisma, { accountId, group });
      const claims = await Promise.all([
        claimOcoTrigger(prisma, { ocoGroupId: groupId, markUsd: "96", workerId: `soak-w1-${i}` }),
        claimOcoTrigger(prisma, { ocoGroupId: groupId, markUsd: "96", workerId: `soak-w2-${i}` }),
      ]);
      ocoClaimsWon += claims.filter((c) => c.ok).length;
    }

    const elapsedMs = Math.round(performance.now() - started);
    const report = {
      ok: true,
      label,
      productionShaped: true,
      liveFeedsPresent: liveFeeds,
      helperNotFullEngine: true,
      note: liveFeeds
        ? "Helper≠full engine. Credentials present but soak still uses synthetic marks for protection claims — not a live SLO unless verify-external-providers + worker pipeline pass."
        : "Helper≠full engine. FIXTURE-shaped: real Postgres reservation/protection helpers only; no worker/UI/live feeds.",
      targetProtectedSlots: slots,
      admitted: race.admitted,
      reconstructedSlotsUsed: reconstructed.slotsUsed,
      metSlotTarget: race.admitted >= slots && reconstructed.slotsUsed === slots,
      workers,
      protectGroups: protectCount,
      ocoClaimsWon,
      ocoExactlyOnePerGroup: ocoClaimsWon === protectCount,
      elapsedMs,
      accountId,
    };
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.metSlotTarget && report.ocoExactlyOnePerGroup ? 0 : 1);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2),
  );
  process.exit(1);
});
