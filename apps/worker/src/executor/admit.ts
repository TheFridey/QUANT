// Audit F2: one executor phase, moved out of StageRunner.executor without behaviour change.
import { liveGateAlert, strategyVersionStamp } from "@odin/agent-core";
import { allowsLocalPaperBooking, createExecutionGateway } from "@odin/market-data";
import { releaseInTx, reserveInTx } from "@odin/risk-engine";
import { assertPaperOrSandboxOnly, d, newId, usd, type ExecutionContext } from "@odin/shared";
import type { Prisma } from "@odin/shared/db";
import { commitProposedOrder } from "@odin/trading-engine";
import { upsertDecision } from "../decisions.js";
import type { ExecutorHost, LoadedPlan } from "./host.js";

/**
 * Admit phase: reserve and commit the admitted plan's orders under the account lock. PAPER books
 * locally; SANDBOX admits PRE_SUBMIT orders for the outbox and never fills locally; a refused
 * execution gate admits nothing. Returns the fills booked here.
 */
export async function admitPlannedOrders(
  host: ExecutorHost,
  tx: Prisma.TransactionClient,
  { cycleId, now, ctx, loaded }: { cycleId: string; now: Date; ctx: ExecutionContext; loaded: LoadedPlan },
): Promise<{ filled: number; filledIds: string[] }> {
  let filled = 0;
  const liveGate = assertPaperOrSandboxOnly(process.env);
  const filledIds: string[] = [];
  const reservationBudget = await host.buildReservationBudget(tx, {
    accountId: ctx.accountId,
    config: loaded.config,
    valuation: loaded.valuation,
  });

  // Remaining PENDING after settle still consume slots/exposure/risk.
  const stillPending = await tx.order.findMany({
    where: { accountId: ctx.accountId, status: "PENDING" },
  });
  // Key by owner+pair so two instances can both have pending entries on the same symbol.
  const pendingPairSuppress = new Set(
    stillPending
      .filter((o) => o.side === "BUY")
      .map((o) => (o.strategyInstanceId ? `${o.strategyInstanceId}::${o.pairAddress}` : o.pairAddress)),
  );

  const executionGateway = createExecutionGateway(liveGate.ok ? liveGate.mode : "PAPER", process.env);

  if (!liveGate.ok) {
    await host.persistAlert(tx, liveGateAlert(liveGate.reason, liveGate.mode), ctx.accountId);
    await upsertDecision(tx, cycleId, {
      agent: "EXECUTOR",
      modelVersion: "executor-paper-1.2.0",
      pairAddress: "",
      decision: "REJECT",
      confidence: "1.000000",
      reasonCodes: ["REJECTED"],
      input: {},
      output: { error: liveGate.reason, mode: liveGate.mode },
      inputSource: "execution-gate",
      durationMs: 0,
    });
  } else if (!allowsLocalPaperBooking(executionGateway)) {
    // SANDBOX: admit durable PRE_SUBMIT orders under account lock; outbox submits outside tx.
    // Never book a local PAPER fill as if it were the external demo (D09 / F01).
    const gatewayReady = executionGateway.readiness();
    await upsertDecision(tx, cycleId, {
      agent: "EXECUTOR",
      modelVersion: "executor-sandbox-1.0.0",
      pairAddress: "",
      decision: gatewayReady === "READY" ? "ACT" : "HOLD",
      confidence: "1.000000",
      reasonCodes: gatewayReady === "READY" ? ["ORDER_PENDING"] : ["REJECTED"],
      input: { gatewayId: executionGateway.id, mode: executionGateway.mode },
      output: {
        sandboxOutbox: true,
        readiness: gatewayReady,
        note:
          gatewayReady === "READY"
            ? "SANDBOX orders admitted as PRE_SUBMIT; outbox submits externally"
            : gatewayReady === "MISSING_CREDENTIALS"
              ? "SANDBOX credentials missing; orders held PRE_SUBMIT without local PAPER fill"
              : "SANDBOX gateway not ready; refusing local PAPER fill masquerade",
      },
      inputSource: "execution-gateway",
      durationMs: 0,
    });
    for (const order of loaded.plan.orders) {
      const needsReservation =
        order.side === "BUY" && (order.intent === "ENTRY" || order.intent === "OPERATOR");
      if (needsReservation) {
        const cashUsd = order.estimatedCostUsd ?? order.estimatedNotionalUsd ?? order.qty;
        const instanceBudget =
          order.strategyInstanceId && "instanceAvailable" in loaded
            ? d(
                (loaded as { instanceAvailable?: Map<string, string> }).instanceAvailable?.get(
                  order.strategyInstanceId,
                ) ?? "0",
              )
                .plus(d(cashUsd))
                .toFixed(8)
            : null;
        const budgetRow =
          order.strategyInstanceId && "instances" in loaded
            ? (
                loaded as {
                  instances?: Array<{ id: string; budgetUsd: string }>;
                }
              ).instances?.find((i) => i.id === order.strategyInstanceId)
            : null;
        const admitted = await reserveInTx(
          tx,
          {
            id: newId("rsv"),
            accountId: ctx.accountId,
            mode: "SANDBOX",
            clientOrderId: order.clientOrderId,
            cashUsd,
            exposureUsd: order.estimatedNotionalUsd ?? cashUsd,
            slots: 1,
            riskUsd: usd(d(cashUsd).mul(d(loaded.config.stopLossPct)).div(100)),
            strategyInstanceId: order.strategyInstanceId ?? null,
            intentId: order.intentId ?? null,
            instanceBudgetUsd: budgetRow?.budgetUsd ?? instanceBudget,
          },
          reservationBudget,
          now,
        );
        if (!admitted.ok) {
          await upsertDecision(tx, cycleId, {
            agent: "EXECUTOR",
            modelVersion: "executor-sandbox-1.0.0",
            pairAddress: order.pairAddress,
            decision: "REJECT",
            confidence: "1.000000",
            reasonCodes: ["REJECTED"],
            input: { clientOrderId: order.clientOrderId },
            output: { reservationDenied: admitted.reason },
            inputSource: "pg-reservations",
            durationMs: 0,
          });
          continue;
        }
      }
      await commitProposedOrder(tx, {
        accountId: ctx.accountId,
        cycleId,
        order: {
          ...order,
          // Force pending so we never locally fill; submissionState marks the outbox.
          eligibleAt: new Date(now.getTime() + 365 * 24 * 3600 * 1000).toISOString(),
          expiresAt: order.expiresAt,
          executionMode: "SANDBOX",
          venue: executionGateway.id,
          instrumentId: order.pairAddress.includes(":") ? order.pairAddress : null,
          strategyVersion: strategyVersionStamp(
            loaded.activeStrategy,
            loaded.config.entryM5ChangePct,
            order.strategyInstanceId,
          ),
          strategyInstanceId: order.strategyInstanceId ?? null,
          intentId: order.intentId ?? null,
          ownerScope: order.ownerScope ?? (order.strategyInstanceId ? "STRATEGY" : "LEGACY"),
          submissionState: "PRE_SUBMIT",
        },
        config: loaded.config,
        mode: host.dataMode,
        now,
      });
      await tx.order.updateMany({
        where: { clientOrderId: order.clientOrderId },
        data: { submissionState: "PRE_SUBMIT", executionMode: "SANDBOX", venue: executionGateway.id },
      });
    }
  } else {
    for (const order of loaded.plan.orders) {
      // Suppress duplicate pending BUY for same owner+pair (R05) — same-symbol other owners still flow.
      const pendingKey = order.strategyInstanceId
        ? `${order.strategyInstanceId}::${order.pairAddress}`
        : order.pairAddress;
      if (order.side === "BUY" && pendingPairSuppress.has(pendingKey)) {
        await upsertDecision(tx, cycleId, {
          agent: "EXECUTOR",
          modelVersion: "executor-paper-1.2.0",
          pairAddress: order.pairAddress,
          decision: "REJECT",
          confidence: "1.000000",
          reasonCodes: ["REJECTED"],
          input: { clientOrderId: order.clientOrderId },
          output: { reservationDenied: "PENDING_DUPLICATE" },
          inputSource: "pending-suppress",
          durationMs: 0,
        });
        continue;
      }
      const needsReservation =
        order.side === "BUY" && (order.intent === "ENTRY" || order.intent === "OPERATOR");
      if (needsReservation) {
        const cashUsd = order.estimatedCostUsd ?? order.estimatedNotionalUsd ?? (() => {
          const mark = loaded.marks?.[order.pairAddress]?.priceUsd;
          return mark && d(mark).gt(0) ? usd(d(order.qty).mul(d(mark))) : order.qty;
        })();
        const budgetRow =
          order.strategyInstanceId && "instances" in loaded
            ? (
                loaded as {
                  instances?: Array<{ id: string; budgetUsd: string }>;
                }
              ).instances?.find((i) => i.id === order.strategyInstanceId)
            : null;
        const admitted = await reserveInTx(
          tx,
          {
            id: newId("rsv"),
            accountId: ctx.accountId,
            mode: "PAPER",
            clientOrderId: order.clientOrderId,
            cashUsd,
            exposureUsd: order.estimatedNotionalUsd ?? cashUsd,
            slots: 1,
            riskUsd: usd(d(cashUsd).mul(d(loaded.config.stopLossPct)).div(100)),
            strategyInstanceId: order.strategyInstanceId ?? null,
            intentId: order.intentId ?? null,
            instanceBudgetUsd: budgetRow?.budgetUsd ?? null,
          },
          reservationBudget,
          now,
        );
        if (!admitted.ok) {
          await upsertDecision(tx, cycleId, {
            agent: "EXECUTOR",
            modelVersion: "executor-paper-1.2.0",
            pairAddress: order.pairAddress,
            decision: "REJECT",
            confidence: "1.000000",
            reasonCodes: ["REJECTED"],
            input: { clientOrderId: order.clientOrderId },
            output: { reservationDenied: admitted.reason },
            inputSource: "pg-reservations",
            durationMs: 0,
          });
          continue;
        }
      }
      const result = await commitProposedOrder(tx, {
        accountId: ctx.accountId,
        cycleId,
        order: {
          ...order,
          eligibleAt: order.eligibleAt,
          expiresAt: order.expiresAt,
          executionMode: "PAPER",
          venue: "PAPER",
          instrumentId: order.pairAddress.includes(":") ? order.pairAddress : null,
          strategyVersion: strategyVersionStamp(
            loaded.activeStrategy,
            loaded.config.entryM5ChangePct,
            order.strategyInstanceId,
          ),
          strategyInstanceId: order.strategyInstanceId ?? null,
          intentId: order.intentId ?? null,
          ownerScope: order.ownerScope ?? (order.strategyInstanceId ? "STRATEGY" : "LEGACY"),
          submissionState: "LOCAL",
        },
        config: loaded.config,
        mode: host.dataMode,
        now,
      });
      if (needsReservation) {
        if (result.status === "FILLED" || result.status === "REJECTED" || result.status === "EXPIRED") {
          await releaseInTx(
            tx,
            { accountId: ctx.accountId, mode: "PAPER", clientOrderId: order.clientOrderId },
            reservationBudget,
            now,
          );
        }
      }
      if (result.status === "PENDING" && order.side === "BUY") {
        pendingPairSuppress.add(pendingKey);
      }
      if (result.status === "FILLED") {
        filled += 1;
        filledIds.push(order.clientOrderId);
        if (order.side === "BUY") {
          await host.armProtectionForFill(tx, {
            accountId: ctx.accountId,
            pairAddress: order.pairAddress,
            qty: order.qty,
            config: loaded.config,
            markUsd: loaded.marks?.[order.pairAddress]?.priceUsd ?? null,
          });
        }
      }
    }
  }
  return { filled, filledIds };
}
