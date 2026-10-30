import { ConflictException } from "@nestjs/common";
import { d, usd } from "@odin/shared";
import type { Prisma } from "@odin/shared/db";

/**
 * Reset the paper account to a new starting balance. Shared by the strategy PATCH and promotion.
 * Runs inside the caller's transaction, under advisory lock 641001, and refuses once any paper
 * order exists (checked under that lock, not before it).
 */
export async function resetPaperBalance(tx: Prisma.TransactionClient, startingBalanceUsd: string, note: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(641001)`;
  if ((await tx.order.count()) > 0) {
    throw new ConflictException("Starting balance can change only before any paper order exists");
  }
  const amount = usd(d(startingBalanceUsd));
  await tx.paperAccount.update({ where: { id: "primary" }, data: { cashUsd: amount, startingBalanceUsd: amount } });
  await tx.ledgerEntry.deleteMany({ where: { accountId: "primary", type: "OPENING_BALANCE" } });
  await tx.ledgerEntry.create({
    data: { accountId: "primary", type: "OPENING_BALANCE", amountUsd: amount, affectsCash: true, note },
  });
}
