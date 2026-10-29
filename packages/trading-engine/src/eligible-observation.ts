import type { Prisma, PrismaClient } from "@odin/shared/db";

type Db = PrismaClient | Prisma.TransactionClient;

export type EligibleObservationRow = {
  id: string;
  pairAddress: string;
  priceUsd: { toString(): string } | null;
  liquidityUsd: { toString(): string } | null;
  freshness: string;
  receivedAt: Date;
  eventTime: Date | null;
  dataOrigin: string | null;
  tradingEnvironment: string | null;
};

/**
 * Select the fill observation for a pending order (R04).
 * Must be same instrument, correct environment, at/after eligibility — not the
 * original pre-eligibility decision quote.
 */
export async function findEligibleFillObservation(
  db: Db,
  input: {
    pairAddress: string;
    eligibleAt: Date;
    tradingEnvironment?: string | null;
    /** Prefer observations from this cycle ingest when present. */
    preferIngestJobId?: string | null;
  },
): Promise<EligibleObservationRow | null> {
  const envFilter =
    input.tradingEnvironment != null && input.tradingEnvironment !== ""
      ? {
          OR: [
            { tradingEnvironment: input.tradingEnvironment },
            { tradingEnvironment: null },
          ],
        }
      : {};

  const atOrAfter = await db.marketObservation.findFirst({
    where: {
      pairAddress: input.pairAddress,
      priceUsd: { not: null },
      receivedAt: { gte: input.eligibleAt },
      ...envFilter,
    },
    orderBy: { receivedAt: "asc" },
  });
  if (atOrAfter) return atOrAfter;

  // Fallback: eventTime at/after eligibility when receivedAt was wall-clock ingest of an older quote.
  const byEvent = await db.marketObservation.findFirst({
    where: {
      pairAddress: input.pairAddress,
      priceUsd: { not: null },
      eventTime: { gte: input.eligibleAt },
      ...envFilter,
    },
    orderBy: { eventTime: "asc" },
  });
  return byEvent;
}
