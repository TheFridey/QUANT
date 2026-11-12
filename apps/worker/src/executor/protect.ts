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
        const config = await prisma.engineControl.findUnique({ where: { id: "primary" } });
        const parsed = strategyConfigOrExitOnly(config?.config ?? {}).config;
        // PCR-1 / F-PCR1-a: every read that decides whether and how much to sell happens under the account
        // lock, in the transaction that books the exit. Reading the position and the lot fence before the
        // lock let a concurrent close-and-reopen slip in between, so a stale intent could sell the new lot.
        const result = await prisma.$transaction(async (tx) => {
          await lockAccount(tx, intent.accountId);
          const leg = await tx.protectionOrder.findUnique({ where: { id: intent.legId } });
          if (!leg) return { status: "SKIPPED" as const, error: "LEG_MISSING" };
          if (leg.accountId !== intent.accountId) return { status: "SKIPPED" as const, error: "ACCOUNT_MISMATCH" };
          const pair = instrumentIdFromPositionKey(leg.positionKey, intent.accountId);
          if (!pair) return { status: "SKIPPED" as const, error: "POSITION_KEY_DECODE" };
          const position = await tx.position.findFirst({
            where: { accountId: intent.accountId, pairAddress: pair },
          });
          // Nothing left to protect: the intent is resolved.
          if (!position || d(position.baseQty.toString()).lte(0)) return { status: "RESOLVED" as const };
          // Fence: an old unresolved intent never reduces a different (reopened) lot.
          if (leg.lifecycleId && position.lifecycleId && leg.lifecycleId !== position.lifecycleId) {
            return { status: "RESOLVED" as const };
          }
          const observation = await tx.marketObservation.findFirst({
            where: {
              pairAddress: pair,
              priceUsd: { not: null },
              tradingEnvironment: ctx.tradingEnvironment,
            },
            orderBy: { receivedAt: "desc" },
          });
          if (!observation) return { status: "SKIPPED" as const, error: "MISSING_PRICE" };
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
        if (result.status === "RESOLVED") return { ok: true };
        if (result.status === "SKIPPED") return { ok: false, error: result.error };
        return result.status === "FILLED"
          ? { ok: true }
          : { ok: false, error: result.reason ?? result.status };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "RETRY_FAILED" };
      }
    },
  });
}
