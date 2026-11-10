import type { Prisma, PrismaClient } from "@odin/shared/db";

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
