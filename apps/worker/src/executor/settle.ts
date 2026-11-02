// Audit F2: one executor phase, moved out of StageRunner.executor without behaviour change.
import { releaseInTx } from "@odin/risk-engine";
import { d, exitFence, type ExecutionContext } from "@odin/shared";
import type { Prisma } from "@odin/shared/db";
import { releasePendingExitReservation, settlePendingOrder } from "@odin/trading-engine";
import { strategyConfigOrExitOnly } from "../strategy-config.js";
import type { ExecutorHost } from "./host.js";

/**
 * Settle phase (R05): settle or cancel PAPER pending orders under explicit policy, before the book
 * is refreshed for admission. Runs inside the executor transaction, under the account lock.
 * Returns the number of fills.
 */
export async function settlePendingPaperOrders(
  host: ExecutorHost,
  tx: Prisma.TransactionClient,
  { ctx, now }: { ctx: ExecutionContext; now: Date },
): Promise<number> {
  const engine = await tx.engineControl.findUnique({ where: { id: "primary" } });
  const { config } = strategyConfigOrExitOnly(engine?.config ?? {});
  // Local settle loop must only touch PAPER — never locally fill SANDBOX pending orders (F01).
  const pending = await tx.order.findMany({
    where: { accountId: ctx.accountId, status: "PENDING", executionMode: "PAPER" },
    orderBy: { submittedAt: "asc" },
  });
  let filled = 0;
  const settleBudget = await host.buildReservationBudget(tx, {
    accountId: ctx.accountId,
    config,
    valuation: { equityUsd: null },
  });
  for (const row of pending) {
    // Pause / emergency: still settle eligible EXITs; cancel pending ENTRY/OPERATOR buys when halted.
    const haltEntries =
      engine?.status === "PAUSED" ||
      engine?.status === "EMERGENCY_STOP" ||
      engine?.status === "STOPPED" ||
      config.pauseNewEntries === true;
    if (
      haltEntries &&
      row.side === "BUY" &&
      (row.intent === "ENTRY" || row.intent === "OPERATOR")
    ) {
      await tx.order.update({
        where: { id: row.id },
        data: {
          status: "CANCELLED",
          rejectReason: "ENGINE_HALTED",
          reasonCodes: [...row.reasonCodes, "ENGINE_HALTED"],
        },
      });
      await releasePendingExitReservation(tx, row);
      await releaseInTx(
        tx,
        { accountId: ctx.accountId, mode: "PAPER", clientOrderId: row.clientOrderId },
        settleBudget,
        now,
      );
      continue;
    }
    // ASCEND-00 F5: a pending SELL whose position another exit already closed (typically protection
    // firing in the same cycle as a planner NET_CLOSE) has nothing left to sell. Cancel it explicitly and
    // release its reservations, rather than letting the store reject it as SELL_EXCEEDS_POSITION.
    // PCR-1: a SELL may sell only units held when it was booked, never units bought since (for example by
    // a pending BUY that settled first in this loop: orders settle in submittedAt order). The decision is the
    // pure exitFence (packages/shared/src/position-lot.ts), read and applied under this transaction's
    // account lock. Flat pairs cancel every SELL (F5); flatten exits are not capped; unstamped rows keep
    // today's behaviour.
    if (row.side === "SELL") {
      const position = await tx.position.findFirst({
        where: { accountId: ctx.accountId, pairAddress: row.pairAddress },
      });
      // STRATEGY exits are fenced against the owning instance's allocation (per-owner FIFO).
      const allocation =
        row.ownerScope === "STRATEGY" && row.strategyInstanceId
          ? await tx.strategyAllocation.findUnique({
              where: {
                accountId_strategyInstanceId_pairAddress: {
                  accountId: ctx.accountId,
                  strategyInstanceId: row.strategyInstanceId,
                  pairAddress: row.pairAddress,
                },
              },
            })
          : null;
      const decision = exitFence(
        {
          qty: row.qty.toString(),
          ownerScope: row.ownerScope,
          intent: row.intent,
          stamp: {
            lotId: row.positionLifecycleId,
            boughtQtyAtBooking: row.positionBoughtQtyAtBooking?.toString() ?? null,
            allocationBoughtQtyAtBooking: row.allocationBoughtQtyAtBooking?.toString() ?? null,
          },
        },
        position
          ? { qty: position.baseQty.toString(), lotId: position.lifecycleId, cumBoughtQty: position.cumBoughtQty.toString() }
          : null,
        allocation ? { qty: allocation.qty.toString(), cumBoughtQty: allocation.cumBoughtQty.toString() } : null,
      );
      if (decision.action === "CANCEL") {
        await tx.order.update({
          where: { id: row.id },
          data: {
            status: "CANCELLED",
            rejectReason: decision.reason,
            reasonCodes: [...row.reasonCodes, decision.reason],
          },
        });
        await releasePendingExitReservation(tx, row);
        await releaseInTx(
          tx,
          { accountId: ctx.accountId, mode: "PAPER", clientOrderId: row.clientOrderId },
          settleBudget,
          now,
        );
        continue;
      }
      if (decision.action === "CAP") {
        // Shrink the order to the surviving booked units; release the reserved exit qty it no longer needs.
        const excess = d(row.qty.toString()).minus(d(decision.qty)).toFixed(8);
        await tx.order.update({
          where: { id: row.id },
          data: { qty: decision.qty, reasonCodes: [...row.reasonCodes, decision.reason] },
        });
        await releasePendingExitReservation(tx, { ...row, qty: excess });
      }
    }
    const settled = await settlePendingOrder(tx, {
      accountId: ctx.accountId,
      orderId: row.id,
      config,
      mode: host.dataMode,
      now,
      tradingEnvironment: ctx.tradingEnvironment,
    });
    if (settled.status === "FILLED") {
      filled += 1;
      if (settled.side === "BUY" && settled.pairAddress) {
        await host.armProtectionForFill(tx, {
          accountId: ctx.accountId,
          pairAddress: settled.pairAddress,
          qty: settled.filledQty ?? row.qty.toString(),
          config,
          markUsd: null,
        });
      }
    }
    // Exit reservations are released inside settlePendingOrder only (review F3: no double release).
    if (settled.status === "FILLED" || settled.status === "REJECTED" || settled.status === "EXPIRED") {
      await releaseInTx(
        tx,
        { accountId: ctx.accountId, mode: "PAPER", clientOrderId: row.clientOrderId },
        settleBudget,
        now,
      );
    }
  }
  return filled;
}
