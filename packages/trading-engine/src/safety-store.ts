import { newId, SAFETY_CODES, type SafetyCode } from "@odin/shared";
import type { Prisma, PrismaClient } from "@odin/shared/db";
import { toJson } from "@odin/shared/db";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Durable account safety state — independent of DurableAlert.acked (R06).
 */

export async function activateSafetyState(
  db: Db,
  input: {
    accountId: string;
    code: SafetyCode | string;
    detail?: Record<string, unknown>;
    now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  const existing = await db.accountSafetyState.findUnique({
    where: { accountId_code: { accountId: input.accountId, code: input.code } },
  });
  if (existing?.status === "ACTIVE") {
    await db.accountSafetyState.update({
      where: { id: existing.id },
      data: {
        detail: input.detail ? toJson(input.detail) : existing.detail ?? undefined,
        updatedAt: now,
      },
    });
    return;
  }
  if (existing) {
    await db.accountSafetyState.update({
      where: { id: existing.id },
      data: {
        status: "ACTIVE",
        detail: input.detail ? toJson(input.detail) : undefined,
        activatedAt: now,
        resolvedAt: null,
        updatedAt: now,
      },
    });
    return;
  }
  await db.accountSafetyState.create({
    data: {
      id: newId("safety"),
      accountId: input.accountId,
      code: input.code,
      status: "ACTIVE",
      detail: input.detail ? toJson(input.detail) : undefined,
      activatedAt: now,
    },
  });
}

export async function resolveSafetyState(
  db: Db,
  input: {
    accountId: string;
    codes: Array<SafetyCode | string>;
    now?: Date;
  },
): Promise<number> {
  const now = input.now ?? new Date();
  const result = await db.accountSafetyState.updateMany({
    where: {
      accountId: input.accountId,
      code: { in: input.codes },
      status: "ACTIVE",
    },
    data: { status: "RESOLVED", resolvedAt: now, updatedAt: now },
  });
  return result.count;
}

export async function loadActiveSafetyStates(
  db: Db,
  accountId: string,
): Promise<Array<{ code: string; status: string; detail: unknown; activatedAt: Date }>> {
  return db.accountSafetyState.findMany({
    where: { accountId, status: "ACTIVE" },
    orderBy: { activatedAt: "desc" },
  });
}

export async function isEntriesSuspended(db: Db, accountId: string): Promise<boolean> {
  const row = await db.accountSafetyState.findFirst({
    where: {
      accountId,
      code: SAFETY_CODES.ENTRIES_SUSPENDED,
      status: "ACTIVE",
    },
  });
  return row !== null;
}
