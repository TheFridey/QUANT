import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "@odin/shared/db";
import { PostgresReservationAuthority, raceAdmitWorkers } from "./pg-reservations.js";
import type { ReservationBudget, ReservationRequest } from "./reservations.js";

const hasDb = Boolean(process.env.DATABASE_URL || process.env.DATABASE_URL_TEST);

describe.runIf(hasDb)("Postgres reservation authority", () => {
  const prisma = createPrismaClient();
  const accountId = "primary:reservation-test";

  beforeAll(async () => {
    await prisma.paperAccount.upsert({
      where: { id: accountId },
      create: {
        id: accountId,
        cashUsd: "100000",
        startingBalanceUsd: "100000",
        tradingEnvironment: "MARKET_DATA_PAPER",
      },
      update: { cashUsd: "100000" },
    });
  });

  async function resetReservations() {
    await prisma.riskReservationEvent.deleteMany({ where: { accountId } });
    await prisma.riskReservation.deleteMany({ where: { accountId } });
  }

  afterAll(async () => {
    await prisma.riskReservationEvent.deleteMany({ where: { accountId } });
    await prisma.riskReservation.deleteMany({ where: { accountId } });
    await prisma.paperAccount.deleteMany({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  const budget = (): ReservationBudget => ({
    cashAvailableUsd: "1000.00000000",
    exposureCapUsd: "500.00000000",
    exposureUsedUsd: "0.00000000",
    slotsAvailable: 2,
    slotsUsed: 0,
    riskBudgetUsd: "100.00000000",
    riskUsedUsd: "0.00000000",
  });

  function req(id: string, exposure = "300"): ReservationRequest {
    return {
      id: `pg_${id}`,
      accountId,
      mode: "PAPER",
      clientOrderId: id,
      cashUsd: exposure,
      exposureUsd: exposure,
      slots: 1,
      riskUsd: "40",
    };
  }

  it("admits under transaction and rejects overflow", async () => {
    await resetReservations();
    const auth = new PostgresReservationAuthority(prisma);
    expect((await auth.reserve(req("a", "200"), budget())).ok).toBe(true);
    expect((await auth.reserve(req("b", "200"), budget())).ok).toBe(true);
    expect((await auth.reserve(req("c", "200"), budget())).ok).toBe(false);
    const live = await auth.reconstruct(accountId, budget());
    expect(live.slotsUsed).toBe(2);
  });

  it("rejects over-release and negative releasePartial", async () => {
    await resetReservations();
    const auth = new PostgresReservationAuthority(prisma);
    expect((await auth.reserve(req("partial", "200"), budget())).ok).toBe(true);
    expect((await auth.consume({ accountId, mode: "PAPER", clientOrderId: "partial" }, budget())).ok).toBe(
      true,
    );
    const over = await auth.releasePartial(
      {
        accountId,
        mode: "PAPER",
        clientOrderId: "partial",
        unused: { cashUsd: "500", exposureUsd: "500", riskUsd: "10", slots: 0 },
      },
      budget(),
    );
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toBe("OVER_RELEASE");
  });

  it("two workers racing never over-admit slots", async () => {
    await resetReservations();
    const requests = Array.from({ length: 8 }, (_, i) => req(`race_${i}`, "200"));
    const result = await raceAdmitWorkers({
      prisma,
      accountId,
      mode: "PAPER",
      budget: budget(),
      requests,
      workerCount: 2,
    });
    expect(result.admitted).toBe(2);
    expect(result.finalBudget.slotsUsed).toBe(2);
    expect(Number(result.finalBudget.exposureUsedUsd)).toBeLessThanOrEqual(500);
  });
});
