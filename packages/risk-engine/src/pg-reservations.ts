import { d, usd, Decimal } from "@odin/shared";
import type { PrismaClient } from "@odin/shared/db";
import { Prisma } from "@odin/shared/db";
import type {
  ReservationBudget,
  ReservationRequest,
  ReservationResult,
} from "./reservations.js";

export type PgReservationTx = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends" | "$use"
>;

/**
 * Durable PostgreSQL reservation authority.
 * All admission routes must serialize on account row (FOR UPDATE) then mutate
 * RiskReservation + immutable RiskReservationEvent rows.
 *
 * Prefer `*InTx` helpers when already inside a worker/account transaction —
 * nested `$transaction` calls are unsafe under account locks.
 */
export class PostgresReservationAuthority {
  constructor(private readonly prisma: PrismaClient) {}

  async reserve(
    request: ReservationRequest,
    budget: ReservationBudget,
    now = new Date(),
  ): Promise<ReservationResult> {
    return this.prisma.$transaction(async (tx) => {
      await lockAccountBudget(tx, request.accountId);
      return reserveInTx(tx, request, budget, now);
    });
  }

  async release(
    input: { accountId: string; mode: string; clientOrderId: string },
    budget: ReservationBudget,
    now = new Date(),
  ): Promise<ReservationResult> {
    return this.prisma.$transaction(async (tx) => {
      await lockAccountBudget(tx, input.accountId);
      return releaseInTx(tx, input, budget, now);
    });
  }

  async consume(
    input: { accountId: string; mode: string; clientOrderId: string },
    budget: ReservationBudget,
    now = new Date(),
  ): Promise<ReservationResult> {
    return this.prisma.$transaction(async (tx) => {
      await lockAccountBudget(tx, input.accountId);
      return consumeInTx(tx, input, budget, now);
    });
  }

  async releasePartial(
    input: {
      accountId: string;
      mode: string;
      clientOrderId: string;
      unused: { cashUsd: string; exposureUsd: string; riskUsd: string; slots: number };
    },
    budget: ReservationBudget,
    now = new Date(),
  ): Promise<ReservationResult> {
    return this.prisma.$transaction(async (tx) => {
      await lockAccountBudget(tx, input.accountId);
      return releasePartialInTx(tx, input, budget, now);
    });
  }

  /** Rebuild held totals from durable rows (startup / worker attach). */
  async reconstruct(accountId: string, caps: ReservationBudget): Promise<ReservationBudget> {
    return this.prisma.$transaction(async (tx) => {
      await lockAccountBudget(tx, accountId);
      return reconstructBudget(tx, accountId, caps);
    });
  }
}

/** Admit inside an already-open account transaction (worker executor path). */
export async function reserveInTx(
  tx: PgReservationTx,
  request: ReservationRequest,
  budget: ReservationBudget,
  now = new Date(),
): Promise<ReservationResult> {
  const mode = request.mode || "PAPER";
  const existing = await tx.riskReservation.findUnique({
    where: {
      accountId_mode_clientOrderId: {
        accountId: request.accountId,
        mode,
        clientOrderId: request.clientOrderId,
      },
    },
  });
  if (existing) {
    if (existing.status === "HELD") {
      return {
        ok: true as const,
        reservation: rowToRecord(existing),
        budget: await reconstructBudget(tx, request.accountId, budget),
      };
    }
    return { ok: false as const, reason: "DUPLICATE_RESERVATION" as const };
  }

  const live = await reconstructBudget(tx, request.accountId, budget);
  const cashNeed = d(request.cashUsd);
  const exposureNeed = d(request.exposureUsd);
  const riskNeed = d(request.riskUsd);
  if (cashNeed.lt(0) || exposureNeed.lt(0) || riskNeed.lt(0) || request.slots < 0) {
    return { ok: false as const, reason: "NEGATIVE_RELEASE" as const };
  }
  if (cashNeed.gt(live.cashAvailableUsd)) return { ok: false as const, reason: "INSUFFICIENT_CASH" as const };
  if (d(live.exposureUsedUsd).plus(exposureNeed).gt(live.exposureCapUsd)) {
    return { ok: false as const, reason: "AGGREGATE_EXPOSURE" as const };
  }
  if (live.slotsUsed + request.slots > live.slotsAvailable) {
    return { ok: false as const, reason: "MAX_POSITIONS" as const };
  }
  if (d(live.riskUsedUsd).plus(riskNeed).gt(live.riskBudgetUsd)) {
    return { ok: false as const, reason: "RISK_BUDGET" as const };
  }

  const created = await tx.riskReservation.create({
    data: {
      accountId: request.accountId,
      mode,
      clientOrderId: request.clientOrderId,
      status: "HELD",
      cashUsd: request.cashUsd,
      exposureUsd: request.exposureUsd,
      slots: request.slots,
      riskUsd: request.riskUsd,
      remainingCashUsd: request.cashUsd,
      remainingExposureUsd: request.exposureUsd,
      remainingRiskUsd: request.riskUsd,
      remainingSlots: request.slots,
      createdAt: now,
      updatedAt: now,
    },
  });
  await tx.riskReservationEvent.create({
    data: {
      reservationId: created.id,
      accountId: request.accountId,
      mode,
      clientOrderId: request.clientOrderId,
      type: "RESERVE",
      payload: {
        cashUsd: request.cashUsd,
        exposureUsd: request.exposureUsd,
        slots: request.slots,
        riskUsd: request.riskUsd,
      },
      createdAt: now,
    },
  });
  return {
    ok: true as const,
    reservation: rowToRecord(created),
    budget: await reconstructBudget(tx, request.accountId, budget),
  };
}

export async function releaseInTx(
  tx: PgReservationTx,
  input: { accountId: string; mode: string; clientOrderId: string },
  budget: ReservationBudget,
  now = new Date(),
): Promise<ReservationResult> {
  const row = await tx.riskReservation.findUnique({
    where: {
      accountId_mode_clientOrderId: {
        accountId: input.accountId,
        mode: input.mode,
        clientOrderId: input.clientOrderId,
      },
    },
  });
  if (!row || row.status !== "HELD") return { ok: false as const, reason: "INVALID_STATE" as const };
  const updated = await tx.riskReservation.update({
    where: { id: row.id },
    data: {
      status: "RELEASED",
      remainingCashUsd: "0",
      remainingExposureUsd: "0",
      remainingRiskUsd: "0",
      remainingSlots: 0,
      updatedAt: now,
    },
  });
  await tx.riskReservationEvent.create({
    data: {
      reservationId: row.id,
      accountId: input.accountId,
      mode: input.mode,
      clientOrderId: input.clientOrderId,
      type: "RELEASE",
      payload: {
        cashUsd: row.remainingCashUsd.toString(),
        exposureUsd: row.remainingExposureUsd.toString(),
        riskUsd: row.remainingRiskUsd.toString(),
        slots: row.remainingSlots,
      },
      createdAt: now,
    },
  });
  return {
    ok: true as const,
    reservation: rowToRecord(updated),
    budget: await reconstructBudget(tx, input.accountId, budget),
  };
}

export async function consumeInTx(
  tx: PgReservationTx,
  input: { accountId: string; mode: string; clientOrderId: string },
  budget: ReservationBudget,
  now = new Date(),
): Promise<ReservationResult> {
  const row = await tx.riskReservation.findUnique({
    where: {
      accountId_mode_clientOrderId: {
        accountId: input.accountId,
        mode: input.mode,
        clientOrderId: input.clientOrderId,
      },
    },
  });
  if (!row || row.status !== "HELD") return { ok: false as const, reason: "INVALID_STATE" as const };
  // Fill moves economic usage onto the open book (caps). Zero remainings so
  // reconstructBudget does not double-count CONSUMED + open exposure (D04).
  // Callers that need to return unused remainder must releasePartial before consume
  // or use release for a full cancel.
  const updated = await tx.riskReservation.update({
    where: { id: row.id },
    data: {
      status: "CONSUMED",
      remainingCashUsd: "0",
      remainingExposureUsd: "0",
      remainingRiskUsd: "0",
      remainingSlots: 0,
      updatedAt: now,
    },
  });
  await tx.riskReservationEvent.create({
    data: {
      reservationId: row.id,
      accountId: input.accountId,
      mode: input.mode,
      clientOrderId: input.clientOrderId,
      type: "CONSUME",
      payload: {
        consumedCashUsd: row.remainingCashUsd.toString(),
        consumedExposureUsd: row.remainingExposureUsd.toString(),
        consumedRiskUsd: row.remainingRiskUsd.toString(),
        consumedSlots: row.remainingSlots,
      },
      createdAt: now,
    },
  });
  return {
    ok: true as const,
    reservation: rowToRecord(updated),
    budget: await reconstructBudget(tx, input.accountId, budget),
  };
}

export async function releasePartialInTx(
  tx: PgReservationTx,
  input: {
    accountId: string;
    mode: string;
    clientOrderId: string;
    unused: { cashUsd: string; exposureUsd: string; riskUsd: string; slots: number };
  },
  budget: ReservationBudget,
  now = new Date(),
): Promise<ReservationResult> {
  const row = await tx.riskReservation.findUnique({
    where: {
      accountId_mode_clientOrderId: {
        accountId: input.accountId,
        mode: input.mode,
        clientOrderId: input.clientOrderId,
      },
    },
  });
  if (!row || (row.status !== "HELD" && row.status !== "CONSUMED")) {
    return { ok: false as const, reason: "INVALID_STATE" as const };
  }
  const cash = d(input.unused.cashUsd);
  const exposure = d(input.unused.exposureUsd);
  const risk = d(input.unused.riskUsd);
  const slots = input.unused.slots;
  if (cash.lt(0) || exposure.lt(0) || risk.lt(0) || slots < 0) {
    return { ok: false as const, reason: "NEGATIVE_RELEASE" as const };
  }
  if (
    cash.gt(row.remainingCashUsd.toString()) ||
    exposure.gt(row.remainingExposureUsd.toString()) ||
    risk.gt(row.remainingRiskUsd.toString()) ||
    slots > row.remainingSlots
  ) {
    return { ok: false as const, reason: "OVER_RELEASE" as const };
  }
  // Keep HELD while unused is peeled off; consume() marks CONSUMED and zeros remainders (D04).
  const nextStatus = row.status === "CONSUMED" ? "CONSUMED" : "HELD";
  const updated = await tx.riskReservation.update({
    where: { id: row.id },
    data: {
      status: nextStatus,
      remainingCashUsd: usd(d(row.remainingCashUsd.toString()).minus(cash)),
      remainingExposureUsd: usd(d(row.remainingExposureUsd.toString()).minus(exposure)),
      remainingRiskUsd: usd(d(row.remainingRiskUsd.toString()).minus(risk)),
      remainingSlots: row.remainingSlots - slots,
      updatedAt: now,
    },
  });
  await tx.riskReservationEvent.create({
    data: {
      reservationId: row.id,
      accountId: input.accountId,
      mode: input.mode,
      clientOrderId: input.clientOrderId,
      type: "RELEASE_PARTIAL",
      payload: input.unused,
      createdAt: now,
    },
  });
  return {
    ok: true as const,
    reservation: rowToRecord(updated),
    budget: await reconstructBudget(tx, input.accountId, budget),
  };
}

export async function lockAccountBudget(tx: PgReservationTx, accountId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "PaperAccount" WHERE id = ${accountId} FOR UPDATE`;
}

/**
 * Rebuild live budget under the account lock (D04).
 *
 * Caps carry authoritative OPEN usage (filled positions) and TOTAL slot capacity.
 * Only HELD reservation remainings are added — CONSUMED fills already live on the
 * open book, so counting them again would double-count exposure/slots/risk.
 */
export async function reconstructBudget(
  tx: PgReservationTx,
  accountId: string,
  caps: ReservationBudget,
): Promise<ReservationBudget> {
  const held = await tx.riskReservation.findMany({
    where: { accountId, status: "HELD" },
  });
  let cashHeld = d("0");
  let reservedExposure = d("0");
  let reservedRisk = d("0");
  let reservedSlots = 0;
  for (const row of held) {
    cashHeld = cashHeld.plus(row.remainingCashUsd.toString());
    reservedExposure = reservedExposure.plus(row.remainingExposureUsd.toString());
    reservedRisk = reservedRisk.plus(row.remainingRiskUsd.toString());
    reservedSlots += row.remainingSlots;
  }
  return {
    cashAvailableUsd: usd(Decimal.max(d("0"), d(caps.cashAvailableUsd).minus(cashHeld))),
    exposureCapUsd: caps.exposureCapUsd,
    exposureUsedUsd: usd(d(caps.exposureUsedUsd).plus(reservedExposure)),
    slotsAvailable: caps.slotsAvailable,
    slotsUsed: caps.slotsUsed + reservedSlots,
    riskBudgetUsd: caps.riskBudgetUsd,
    riskUsedUsd: usd(d(caps.riskUsedUsd).plus(reservedRisk)),
  };
}

function rowToRecord(row: {
  id: string;
  accountId: string;
  mode: string;
  clientOrderId: string;
  status: string;
  cashUsd: { toString(): string } | string;
  exposureUsd: { toString(): string } | string;
  slots: number;
  riskUsd: { toString(): string } | string;
  remainingCashUsd: { toString(): string } | string;
  remainingExposureUsd: { toString(): string } | string;
  remainingRiskUsd: { toString(): string } | string;
  remainingSlots: number;
  createdAt: Date;
}) {
  return {
    id: row.id,
    accountId: row.accountId,
    mode: row.mode,
    clientOrderId: row.clientOrderId,
    cashUsd: row.cashUsd.toString(),
    exposureUsd: row.exposureUsd.toString(),
    slots: row.slots,
    riskUsd: row.riskUsd.toString(),
    status: row.status as "HELD" | "RELEASED" | "CONSUMED",
    remainingCashUsd: row.remainingCashUsd.toString(),
    remainingExposureUsd: row.remainingExposureUsd.toString(),
    remainingRiskUsd: row.remainingRiskUsd.toString(),
    remainingSlots: row.remainingSlots,
    createdAtMs: row.createdAt.getTime(),
  };
}

/** Race N workers against one account — returns exact admission count. */
export async function raceAdmitWorkers(input: {
  prisma: PrismaClient;
  accountId: string;
  mode: string;
  budget: ReservationBudget;
  requests: ReservationRequest[];
  workerCount: number;
}): Promise<{ admitted: number; rejected: number; finalBudget: ReservationBudget }> {
  const authority = new PostgresReservationAuthority(input.prisma);
  const chunks: ReservationRequest[][] = Array.from({ length: input.workerCount }, () => []);
  input.requests.forEach((req, i) => {
    chunks[i % input.workerCount]!.push(req);
  });
  const results = await Promise.all(
    chunks.map(async (chunk) => {
      const out: ReservationResult[] = [];
      for (const req of chunk) {
        out.push(await authority.reserve(req, input.budget));
      }
      return out;
    }),
  );
  const flat = results.flat();
  const admitted = flat.filter((r) => r.ok).length;
  const rejected = flat.length - admitted;
  const finalBudget = await authority.reconstruct(input.accountId, input.budget);
  return { admitted, rejected, finalBudget };
}

// Keep Prisma import used for decimal casts in future migrations.
void Prisma;
