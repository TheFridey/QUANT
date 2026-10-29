import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SAFETY_CODES } from "@odin/shared";
import { PrismaClient } from "@odin/shared/db";
import {
  activateSafetyState,
  isEntriesSuspended,
  loadActiveSafetyStates,
  resolveSafetyState,
} from "./safety-store.js";

const databaseUrl = process.env.DATABASE_URL_TEST;
const enabled = Boolean(databaseUrl && databaseUrl.includes("odin_test"));

describe.skipIf(!enabled)("safety store ACK independence (R06)", () => {
  let prisma: PrismaClient;
  const accountId = "primary:safety-r06";

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRaw`SELECT pg_advisory_lock(641206)`;
    await prisma.accountSafetyState.deleteMany({ where: { accountId } });
    await prisma.durableAlert.deleteMany({ where: { accountId } });
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
    await prisma.accountSafetyState.deleteMany({ where: { accountId } });
    await prisma.durableAlert.deleteMany({ where: { accountId } });
    await prisma.$executeRaw`SELECT pg_advisory_unlock(641206)`;
    await prisma.$disconnect();
  });

  it("ACK of DurableAlert does not clear ACTIVE ENTRIES_SUSPENDED", async () => {
    await activateSafetyState(prisma, {
      accountId,
      code: SAFETY_CODES.ENTRIES_SUSPENDED,
      detail: { reason: "test_reconcile" },
    });
    const alert = await prisma.durableAlert.create({
      data: {
        accountId,
        severity: "CRITICAL",
        code: SAFETY_CODES.ENTRIES_SUSPENDED,
        message: "test suspension",
        acked: false,
      },
    });
    expect(await isEntriesSuspended(prisma, accountId)).toBe(true);

    // Operator ACK — notification only.
    await prisma.durableAlert.update({
      where: { id: alert.id },
      data: { acked: true, ackedAt: new Date() },
    });
    expect(await isEntriesSuspended(prisma, accountId)).toBe(true);
    const active = await loadActiveSafetyStates(prisma, accountId);
    expect(active.some((row) => row.code === SAFETY_CODES.ENTRIES_SUSPENDED)).toBe(true);

    // Only explicit resolve (clean reconcile path) clears suspension.
    await resolveSafetyState(prisma, {
      accountId,
      codes: [SAFETY_CODES.ENTRIES_SUSPENDED],
    });
    expect(await isEntriesSuspended(prisma, accountId)).toBe(false);
  });
});
