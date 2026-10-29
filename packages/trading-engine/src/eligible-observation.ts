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
  ingestJobId?: string;
};

export type EligibleObservationInput = {
  pairAddress: string;
  eligibleAt: Date;
  /** Wall-clock / processing upper bound — never select future receipts. */
  now?: Date;
  /** Order expiry — refuse events at/after expiry. */
  expiresAt?: Date | null;
  tradingEnvironment?: string | null;
  /** Prefer observations from this cycle ingest when present. */
  preferIngestJobId?: string | null;
  /**
   * When true (default), require an exact environment match.
   * Null-environment legacy rows are quarantined and never treated as compatible.
   */
  allowNullEnvironment?: boolean;
};

function envClause(
  tradingEnvironment: string | null | undefined,
  allowNullEnvironment: boolean,
): Record<string, unknown> {
  if (tradingEnvironment == null || tradingEnvironment === "") return {};
  if (allowNullEnvironment) {
    return {
      OR: [{ tradingEnvironment }, { tradingEnvironment: null }],
    };
  }
  return { tradingEnvironment };
}

function receiptBounds(input: EligibleObservationInput): {
  gte: Date;
  lte?: Date;
} {
  const now = input.now ?? new Date();
  let lte = now;
  if (input.expiresAt && input.expiresAt.getTime() < lte.getTime()) {
    // Eligible events must arrive strictly before expiry.
    lte = new Date(input.expiresAt.getTime() - 1);
  }
  return { gte: input.eligibleAt, lte };
}

function isUsableRow(
  row: EligibleObservationRow,
  input: EligibleObservationInput,
): boolean {
  const now = input.now ?? new Date();
  if (row.receivedAt.getTime() > now.getTime()) return false;
  if (row.receivedAt.getTime() < input.eligibleAt.getTime()) return false;
  if (input.expiresAt && row.receivedAt.getTime() >= input.expiresAt.getTime()) return false;
  if (row.eventTime) {
    if (row.eventTime.getTime() > now.getTime()) return false;
    // Old provider event with a new receipt is not eligible for a changed-price fill.
    if (row.eventTime.getTime() < input.eligibleAt.getTime()) return false;
  }
  if (
    input.tradingEnvironment &&
    !input.allowNullEnvironment &&
    row.tradingEnvironment !== input.tradingEnvironment
  ) {
    return false;
  }
  return row.priceUsd != null;
}

/**
 * Select the fill observation for a pending order (R04 / D03).
 * Same instrument, exact environment, receipt within [eligibleAt, now]/expiresAt),
 * and provider event time (when known) also within bounds — never an old event with a new receipt.
 */
export async function findEligibleFillObservation(
  db: Db,
  input: EligibleObservationInput,
): Promise<EligibleObservationRow | null> {
  const allowNull = input.allowNullEnvironment === true;
  const envFilter = envClause(input.tradingEnvironment, allowNull);
  const receivedAt = receiptBounds(input);
  if (receivedAt.lte && receivedAt.lte.getTime() < receivedAt.gte.getTime()) {
    return null;
  }

  const baseWhere = {
    pairAddress: input.pairAddress,
    priceUsd: { not: null },
    receivedAt,
    ...envFilter,
  };

  if (input.preferIngestJobId) {
    const preferred = await db.marketObservation.findFirst({
      where: { ...baseWhere, ingestJobId: input.preferIngestJobId },
      orderBy: { receivedAt: "asc" },
    });
    if (preferred && isUsableRow(preferred, input)) return preferred;
  }

  const candidates = await db.marketObservation.findMany({
    where: baseWhere,
    orderBy: { receivedAt: "asc" },
    take: 20,
  });
  for (const row of candidates) {
    if (isUsableRow(row, input)) return row;
  }

  // Fallback: eventTime within bounds AND receipt also within bounds (no old-event/new-receipt).
  const byEvent = await db.marketObservation.findMany({
    where: {
      pairAddress: input.pairAddress,
      priceUsd: { not: null },
      eventTime: {
        gte: input.eligibleAt,
        lte: input.now ?? new Date(),
      },
      receivedAt: {
        gte: input.eligibleAt,
        lte: receivedAt.lte ?? (input.now ?? new Date()),
      },
      ...envFilter,
    },
    orderBy: { eventTime: "asc" },
    take: 20,
  });
  for (const row of byEvent) {
    if (isUsableRow(row, input)) return row;
  }
  return null;
}
