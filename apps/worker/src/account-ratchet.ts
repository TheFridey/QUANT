import type { Prisma, PrismaClient } from "@odin/shared/db";

/**
 * Apply a London-day session roll. Compare-and-set on the session this reader saw, so a stage finishing late
 * cannot undo a newer roll. The roll resets the session low; within a day the low only moves down elsewhere.
 */
export async function applySessionRoll(
  db: PrismaClient | Prisma.TransactionClient,
  accountId: string,
  seenSessionStartedAt: Date | null,
  roll: { sessionStartedAt: Date; sessionStartEquityUsd: string; sessionLowEquityUsd: string | null },
): Promise<boolean> {
  const result = await db.paperAccount.updateMany({
    where: { id: accountId, sessionStartedAt: seenSessionStartedAt },
    data: {
      sessionStartedAt: roll.sessionStartedAt,
      sessionStartEquityUsd: roll.sessionStartEquityUsd,
      sessionLowEquityUsd: roll.sessionLowEquityUsd,
    },
  });
  return result.count > 0;
}

/**
 * Raise the high-water mark, never lower it. GREATEST in SQL so a writer holding an older, lower value (a
 * stage that finishes after timing out, or any concurrent cycle) cannot lose the true peak, which would
 * shrink the measured drawdown and loosen the total-drawdown limit.
 */
export async function ratchetHighWaterMark(
  db: PrismaClient | Prisma.TransactionClient,
  accountId: string,
  highWaterMarkUsd: string,
): Promise<void> {
  await db.$executeRaw`
    UPDATE "PaperAccount"
    SET "highWaterMarkUsd" = GREATEST(COALESCE("highWaterMarkUsd", ${highWaterMarkUsd}::numeric), ${highWaterMarkUsd}::numeric)
    WHERE id = ${accountId}`;
}
