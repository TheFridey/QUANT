// Audit F2: one executor phase, moved out of StageRunner.executor without behaviour change.
import {
  clientOrderIdFor,
  d,
  instrumentIdFromPositionKey,
  intentIdFor,
  intentIdempotencyKey,
  type ExecutionContext,
} from "@odin/shared";
import type { PrismaClient } from "@odin/shared/db";
import { commitProposedOrder, lockAccount, retryUnresolvedProtectionIntents } from "@odin/trading-engine";
import { strategyConfigOrExitOnly } from "../strategy-config.js";

/**
 * Protect phase, after the executor transaction: retry unresolved protection exits, account-scoped
 * and lifecycle-fenced (D07). Each retry takes its own account lock.
 */
export async function retryProtectionExits(
  prisma: PrismaClient,
  { ctx, now }: { ctx: ExecutionContext; now: Date },
): Promise<void> {
  await retryUnresolvedProtectionIntents(prisma, {
    now,
    accountId: ctx.accountId,
    attemptExit: async (intent) => {
      try {
        const leg = await prisma.protectionOrder.findUnique({ where: { id: intent.legId } });
        if (!leg) return { ok: false, error: "LEG_MISSING" };
        if (leg.accountId !== intent.accountId) return { ok: false, error: "ACCOUNT_MISMATCH" };
        const pair = instrumentIdFromPositionKey(leg.positionKey, intent.accountId);
        if (!pair) return { ok: false, error: "POSITION_KEY_DECODE" };
        const observation = await prisma.marketObservation.findFirst({
          where: {
            pairAddress: pair,
            priceUsd: { not: null },
            tradingEnvironment: ctx.tradingEnvironment,
          },
          orderBy: { receivedAt: "desc" },
        });
        if (!observation) return { ok: false, error: "MISSING_PRICE" };
        const position = await prisma.position.findFirst({
          where: { accountId: intent.accountId, pairAddress: pair },
        });
        if (!position || d(position.baseQty.toString()).lte(0)) {
          return { ok: true };
        }
        // Fence: do not reduce a reopened lot with an old unresolved intent.
        if (leg.lifecycleId && position.lifecycleId && leg.lifecycleId !== position.lifecycleId) {
          return { ok: true };
        }
        const config = await prisma.engineControl.findUnique({ where: { id: "primary" } });
        const parsed = strategyConfigOrExitOnly(config?.config ?? {}).config;
        const result = await prisma.$transaction(async (tx) => {
          await lockAccount(tx, intent.accountId);
          const protKey = intentIdempotencyKey({
            cycleId: `prot_retry_${intent.id}`,
            accountId: intent.accountId,
            source: "PROTECTION",
            ownerRef: intent.legId,
            pairAddress: pair,
            action: "CLOSE_NET",
          });
          return commitProposedOrder(tx, {
            accountId: intent.accountId,
            cycleId: `prot_retry_${intent.id}`,
            order: {
              clientOrderId: clientOrderIdFor(protKey),
              pairAddress: pair,
              baseSymbol: position.baseSymbol,
              side: "SELL",
              intent: "EXIT",
              qty: position.baseQty.toString(),
              observationId: observation.id,
              reasonCodes: ["STOP_LOSS"],
              executionMode: "PAPER",
              venue: "PAPER",
              instrumentId: pair.includes(":") ? pair : null,
              intentId: intentIdFor(protKey),
              ownerScope: "PROTECTION",
            },
            config: parsed,
            mode: ctx.dataMode,
            now,
          });
        });
        return result.status === "FILLED"
          ? { ok: true }
          : { ok: false, error: result.reason ?? result.status };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "RETRY_FAILED" };
      }
    },
  });
}
