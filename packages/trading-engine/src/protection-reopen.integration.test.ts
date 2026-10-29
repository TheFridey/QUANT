import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "@odin/shared";
import { PrismaClient } from "@odin/shared/db";
import { armLongShortOco, persistOcoGroup } from "./protection-lifecycle.js";
import { protectionGroupId } from "./position-lifecycle.js";

const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));

describe.skipIf(!enabled)("protection reopen lifecycle (R01)", () => {
  let prisma: PrismaClient;
  const accountId = "primary:prot-r01";
  const pairAddress = "pair_r01_reopen";

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRaw`SELECT pg_advisory_lock(641099)`;
    await prisma.protectionIntent.deleteMany({ where: { accountId } });
    await prisma.protectionOrder.deleteMany({ where: { accountId } });
    await prisma.paperAccount.upsert({
      where: { id: accountId },
      create: {
        id: accountId,
        cashUsd: "100000",
        startingBalanceUsd: "100000",
        tradingEnvironment: "MARKET_DATA_PAPER",
      },
      update: {},
    });
  });

  afterAll(async () => {
    await prisma.protectionIntent.deleteMany({ where: { accountId } });
    await prisma.protectionOrder.deleteMany({ where: { accountId } });
    await prisma.$executeRaw`SELECT pg_advisory_unlock(641099)`;
    await prisma.$disconnect();
  });

  it("close→reopen mints a new group with fresh triggers (no terminal inheritance)", async () => {
    const lot1 = newId("lot");
    const group1 = armLongShortOco({
      groupId: protectionGroupId(accountId, pairAddress, lot1),
      positionKey: `${accountId}:${pairAddress}`,
      direction: "LONG",
      qty: "10",
      entryPriceUsd: "100",
      stopLossPct: "3",
      takeProfitPct: "5",
    });
    await persistOcoGroup(prisma, { accountId, group: group1, lifecycleId: lot1 });

    // Terminalise first lifecycle (close).
    await prisma.protectionOrder.updateMany({
      where: { ocoGroupId: group1.id },
      data: { status: "FILLED", remainingQty: 0 },
    });

    const lot2 = newId("lot");
    const group2 = armLongShortOco({
      groupId: protectionGroupId(accountId, pairAddress, lot2),
      positionKey: `${accountId}:${pairAddress}`,
      direction: "LONG",
      qty: "4",
      entryPriceUsd: "200",
      stopLossPct: "3",
      takeProfitPct: "5",
    });
    await persistOcoGroup(prisma, { accountId, group: group2, lifecycleId: lot2 });

    const armed = await prisma.protectionOrder.findMany({
      where: { accountId, lifecycleId: lot2, status: "ARMED" },
    });
    expect(armed.length).toBeGreaterThanOrEqual(2);
    const stop = armed.find((leg) => leg.kind === "STOP");
    expect(Number(stop?.triggerPriceUsd?.toString())).toBeCloseTo(194, 4);
    expect(stop?.ocoGroupId).toBe(group2.id);
    expect(stop?.ocoGroupId).not.toBe(group1.id);

    // Permanent-id reuse must not skip insert when only terminal rows remain.
    const permanentId = `oco_${accountId}_${pairAddress}`;
    await prisma.protectionOrder.create({
      data: {
        id: `${permanentId}:STOP`,
        accountId,
        positionKey: `${accountId}:${pairAddress}`,
        ocoGroupId: permanentId,
        lifecycleId: "old",
        kind: "STOP",
        origin: "SYNTHETIC_ENGINE",
        direction: "LONG",
        protectedQty: "1",
        remainingQty: "0",
        triggerPriceUsd: "50",
        status: "FILLED",
        ackState: "ACKED",
      },
    });
    const reused = armLongShortOco({
      groupId: permanentId,
      positionKey: `${accountId}:${pairAddress}`,
      direction: "LONG",
      qty: "2",
      entryPriceUsd: "150",
      stopLossPct: "2",
      takeProfitPct: "4",
    });
    await persistOcoGroup(prisma, { accountId, group: reused, lifecycleId: newId("lot") });
    const reusedArmed = await prisma.protectionOrder.findMany({
      where: { ocoGroupId: permanentId, status: "ARMED" },
    });
    expect(reusedArmed.length).toBeGreaterThanOrEqual(1);
    expect(Number(reusedArmed.find((l) => l.kind === "STOP")?.triggerPriceUsd?.toString())).toBeCloseTo(
      147,
      4,
    );
  });
});
