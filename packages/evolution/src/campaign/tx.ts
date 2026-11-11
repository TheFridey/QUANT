import type { Prisma, PrismaClient } from "@odin/shared/db";

/**
 * Campaign transactions write result rows that can be several hundred kilobytes and may wait on an advisory
 * lock held by another campaign, so the Prisma default of 5 s is too tight on a slow or busy host (observed in
 * the first demonstration run). They stay short in practice; these are ceilings.
 */
export const CAMPAIGN_TX_OPTIONS = { maxWait: 15_000, timeout: 60_000 } as const;

export function campaignTx<T>(prisma: PrismaClient, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn, CAMPAIGN_TX_OPTIONS);
}
