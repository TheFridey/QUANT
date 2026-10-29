import {
  createExecutionGateway,
  allowsLocalPaperBooking,
  type ExternalExecution,
} from "@odin/market-data";
import { applyExternalFill, releasePendingExitReservation } from "@odin/trading-engine";
import { assertPaperOrSandboxOnly, d, newId } from "@odin/shared";
import type { PrismaClient } from "@odin/shared/db";
import { releaseInTx, type ReservationBudget } from "@odin/risk-engine";

/**
 * SANDBOX outbox processor (Stage Q).
 *
 * Orders are admitted inside the account transaction as PRE_SUBMIT / PENDING with
 * executionMode=SANDBOX. This processor runs OUTSIDE that transaction: submit to the
 * external venue, sync status, and book confirmed fills via applyExternalFill.
 * Never locally fills a SANDBOX order.
 */
export async function processSandboxOutbox(
  prisma: PrismaClient,
  input: {
    accountId: string;
    now?: Date;
    reservationBudget?: ReservationBudget;
    env?: NodeJS.ProcessEnv;
  },
): Promise<{ submitted: number; filled: number; unknown: number; skipped: number }> {
  const now = input.now ?? new Date();
  const env = input.env ?? process.env;
  const gate = assertPaperOrSandboxOnly(env);
  if (!gate.ok || gate.mode !== "SANDBOX") {
    return { submitted: 0, filled: 0, unknown: 0, skipped: 0 };
  }
  const gateway = createExecutionGateway("SANDBOX", env);
  if (allowsLocalPaperBooking(gateway)) {
    return { submitted: 0, filled: 0, unknown: 0, skipped: 0 };
  }
  const venue =
    "externalVenue" in gateway && typeof gateway.externalVenue === "function"
      ? gateway.externalVenue()
      : null;
  const readiness = gateway.readiness();

  const due = await prisma.order.findMany({
    where: {
      accountId: input.accountId,
      executionMode: "SANDBOX",
      status: "PENDING",
      submissionState: { in: ["PRE_SUBMIT", "SUBMITTING", "ACKED", "UNKNOWN"] },
      OR: [{ nextSyncAt: null }, { nextSyncAt: { lte: now } }],
    },
    orderBy: { submittedAt: "asc" },
    take: 50,
  });

  let submitted = 0;
  let filled = 0;
  let unknown = 0;
  let skipped = 0;

  for (const order of due) {
    if (readiness !== "READY" || !venue) {
      await prisma.order.update({
        where: { id: order.id },
        data: {
          lastSubmitError: `SANDBOX_NOT_READY:${readiness}`,
          nextSyncAt: new Date(now.getTime() + 30_000),
          submitAttempts: { increment: 1 },
        },
      });
      skipped += 1;
      continue;
    }

    try {
      if (order.submissionState === "PRE_SUBMIT" || order.submissionState === "UNKNOWN") {
        await prisma.order.update({
          where: { id: order.id },
          data: { submissionState: "SUBMITTING", submitAttempts: { increment: 1 } },
        });
        const result = await venue.submitOrder({
          clientOrderId: order.clientOrderId,
          instrumentId: order.instrumentId ?? order.pairAddress,
          side: order.side as "BUY" | "SELL",
          qty: order.qty.toString(),
          type: "market",
          timeInForce: "day",
        });
        if (!result.ok) {
          if (result.retryClass === "TRANSIENT" || result.code === "UNKNOWN_OUTCOME") {
            await prisma.order.update({
              where: { id: order.id },
              data: {
                submissionState: "UNKNOWN",
                lastSubmitError: `${result.code}:${result.error}`.slice(0, 500),
                nextSyncAt: new Date(now.getTime() + 15_000),
              },
            });
            await prisma.recoveryCase.upsert({
              where: { dedupeKey: `UNKNOWN_SUBMISSION|${order.clientOrderId}` },
              create: {
                dedupeKey: `UNKNOWN_SUBMISSION|${order.clientOrderId}`,
                accountId: input.accountId,
                kind: "UNKNOWN_SUBMISSION",
                severity: "ERROR",
                orderId: order.id,
                clientOrderId: order.clientOrderId,
                pairAddress: order.pairAddress,
                detail: { code: result.code, error: result.error },
                status: "OPEN",
              },
              update: { attempts: { increment: 1 }, detail: { code: result.code, error: result.error } },
            });
            unknown += 1;
          } else {
            await prisma.order.update({
              where: { id: order.id },
              data: {
                status: "REJECTED",
                rejectReason: result.code,
                submissionState: "TERMINAL",
                lastSubmitError: result.error.slice(0, 500),
              },
            });
            await releasePendingExitReservation(prisma, order);
            if (input.reservationBudget) {
              await releaseInTx(
                prisma,
                { accountId: input.accountId, mode: "SANDBOX", clientOrderId: order.clientOrderId },
                input.reservationBudget,
                now,
              );
            }
          }
          continue;
        }
        await prisma.order.update({
          where: { id: order.id },
          data: {
            submissionState: "ACKED",
            brokerOrderId: result.value.brokerOrderId,
            lastBrokerStatus: result.value.status,
            lastBrokerSyncAt: now,
            nextSyncAt: new Date(now.getTime() + 5_000),
          },
        });
        submitted += 1;
      }

      // Sync / ingest executions for ACKED orders.
      const brokerId = (
        await prisma.order.findUnique({ where: { id: order.id }, select: { brokerOrderId: true } })
      )?.brokerOrderId;
      if (!brokerId) continue;
      const state = await venue.getOrderByClientId(order.clientOrderId);
      if (!state.ok) {
        await prisma.order.update({
          where: { id: order.id },
          data: {
            submissionState: "UNKNOWN",
            lastSubmitError: `${state.code}:${state.error}`.slice(0, 500),
            nextSyncAt: new Date(now.getTime() + 15_000),
          },
        });
        unknown += 1;
        continue;
      }
      const executions = await venue.listExecutions({ pageToken: null });
      if (executions.ok) {
        for (const exec of executions.value.items.filter((e: ExternalExecution) => e.brokerOrderId === brokerId)) {
          await prisma.$transaction(async (tx) => {
            await applyExternalFill(tx, {
              accountId: input.accountId,
              orderId: order.id,
              brokerExecutionId: exec.executionId,
              qty: exec.qty,
              priceUsd: exec.price,
              feeUsd: exec.fee,
              feeKnown: exec.fee != null,
              executedAt: new Date(exec.executedAt),
              currency: exec.currency ?? "USD",
            });
          });
          filled += 1;
        }
      }
      await prisma.order.update({
        where: { id: order.id },
        data: {
          lastBrokerStatus: state.value.status,
          lastBrokerSyncAt: now,
          nextSyncAt:
            state.value.status === "FILLED" ||
            state.value.status === "CANCELED" ||
            state.value.status === "REJECTED" ||
            state.value.status === "EXPIRED"
              ? null
              : new Date(now.getTime() + 5_000),
          submissionState:
            state.value.status === "FILLED" ||
            state.value.status === "CANCELED" ||
            state.value.status === "REJECTED" ||
            state.value.status === "EXPIRED"
              ? "TERMINAL"
              : "ACKED",
          ...(state.value.status === "CANCELED" || state.value.status === "REJECTED" || state.value.status === "EXPIRED"
            ? { status: state.value.status === "CANCELED" ? "CANCELLED" : state.value.status }
            : {}),
        },
      });
    } catch (err) {
      await prisma.order.update({
        where: { id: order.id },
        data: {
          submissionState: "UNKNOWN",
          lastSubmitError: (err instanceof Error ? err.message : String(err)).slice(0, 500),
          nextSyncAt: new Date(now.getTime() + 15_000),
          submitAttempts: { increment: 1 },
        },
      });
      unknown += 1;
    }
  }

  void d;
  void newId;
  return { submitted, filled, unknown, skipped };
}
