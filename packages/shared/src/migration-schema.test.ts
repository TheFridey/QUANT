import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "./db.js";

const hasDb = Boolean(process.env.DATABASE_URL || process.env.DATABASE_URL_TEST);

/**
 * Migration upgrade smoke — verifies additive MVP columns exist after db:deploy.
 * Does not reset databases.
 */
describe.runIf(hasDb)("migration schema upgrade smoke", () => {
  const prisma = createPrismaClient();

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("exposes protection ack + REPLAY isolation columns", async () => {
    const protectionCols = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'ProtectionOrder'
        AND column_name IN ('confirmedTriggerPriceUsd', 'desiredTriggerPriceUsd', 'ackState')
      ORDER BY column_name
    `;
    expect(protectionCols.map((c) => c.column_name).sort()).toEqual([
      "ackState",
      "confirmedTriggerPriceUsd",
      "desiredTriggerPriceUsd",
    ]);

    const funnelCols = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'OpportunityFunnelEvent' AND column_name = 'accountId'
    `;
    expect(funnelCols).toHaveLength(1);

    const equityCols = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'EquitySnapshot' AND column_name = 'accountId'
    `;
    expect(equityCols).toHaveLength(1);

    const accountCols = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'PaperAccount'
        AND column_name IN ('tradingEnvironment', 'sessionStartEquityUsd', 'highWaterMarkUsd', 'sessionStartedAt')
      ORDER BY column_name
    `;
    expect(accountCols.length).toBeGreaterThanOrEqual(3);
  });
});
