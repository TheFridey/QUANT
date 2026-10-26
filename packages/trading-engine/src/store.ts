import { classifyFreshness, type DataMode, type ReasonCode, type StrategyConfig } from "@odin/shared";
import { Prisma, type PrismaClient } from "@odin/shared/db";
import { applyFill, type BookState } from "./ledger.js";
import { quoteFill } from "./fill.js";

export type CommitOrder = {
  clientOrderId: string;
  pairAddress: string;
  baseSymbol: string;
  side: "BUY" | "SELL";
  intent: "ENTRY" | "EXIT" | "FLATTEN" | "OPERATOR";
  qty: string;
  observationId: string;
  reasonCodes: ReasonCode[];
};

export async function lockAccount(tx: Prisma.TransactionClient, accountId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "PaperAccount" WHERE id = ${accountId} FOR UPDATE`;
}

export async function commitProposedOrder(
  tx: Prisma.TransactionClient,
  input: {
    accountId: string;
    cycleId: string;
    order: CommitOrder;
    config: StrategyConfig;
    mode: DataMode;
    now: Date;
  },
): Promise<{ status: "FILLED" | "REJECTED" | "REPLAY"; reason: ReasonCode | null }> {
  const existing = await tx.order.findUnique({ where: { clientOrderId: input.order.clientOrderId } });
  if (existing) return { status: "REPLAY", reason: "IDEMPOTENT_REPLAY" };

  const observation = await tx.marketObservation.findUnique({ where: { id: input.order.observationId } });
  if (!observation || observation.priceUsd === null || observation.liquidityUsd === null) {
    await reject(tx, input, "MISSING_PRICE");
    return { status: "REJECTED", reason: "MISSING_PRICE" };
  }
  const freshness = classifyFreshness({
    mode: input.mode,
    receivedAt: observation.receivedAt,
    now: input.now,
    liveMaxAgeMs: input.config.liveMaxAgeMs,
    delayedMaxAgeMs: input.config.delayedMaxAgeMs,
  });
  if (input.order.side === "BUY" && freshness !== "LIVE") {
    const reason = freshness === "DELAYED" ? "DATA_DELAYED" : freshness === "STALE" ? "DATA_STALE" : freshness === "REPLAY" ? "DATA_REPLAY" : "DATA_DEMO";
    await reject(tx, input, reason);
    return { status: "REJECTED", reason };
  }
  if (input.order.side === "SELL" && freshness !== "LIVE") {
    const allowed = freshness === "DELAYED" && input.config.allowDelayedExits;
    if (!allowed) {
      const reason = freshness === "DELAYED" ? "DATA_DELAYED" : freshness === "STALE" ? "DATA_STALE" : freshness === "REPLAY" ? "DATA_REPLAY" : "DATA_DEMO";
      await reject(tx, input, reason);
      return { status: "REJECTED", reason };
    }
  }

  const quoted = quoteFill({
    side: input.order.side,
    midPriceUsd: observation.priceUsd.toString(),
    quantity: input.order.qty,
    liquidityUsd: observation.liquidityUsd.toString(),
    feeBps: input.config.feeBps,
    maxSlippageBps: input.config.maxSlippageBps,
  });
  if (!quoted.ok) {
    await reject(tx, input, quoted.reason);
    return { status: "REJECTED", reason: quoted.reason };
  }

  const account = await tx.paperAccount.findUnique({ where: { id: input.accountId } });
  const positions = await tx.position.findMany({ where: { accountId: input.accountId } });
  if (!account) {
    await reject(tx, input, "REJECTED");
    return { status: "REJECTED", reason: "REJECTED" };
  }
  const state: BookState = {
    cashUsd: account.cashUsd.toString(),
    positions: positions.map((position) => ({
      pairAddress: position.pairAddress,
      baseSymbol: position.baseSymbol,
      baseQty: position.baseQty.toString(),
      avgCostUsd: position.avgCostUsd.toString(),
      realizedPnlUsd: position.realizedPnlUsd.toString(),
    })),
  };
  const applied = applyFill(state, {
    pairAddress: input.order.pairAddress,
    baseSymbol: input.order.baseSymbol,
    side: input.order.side,
    fill: quoted.fill,
  });
  if (!applied.ok) {
    await reject(tx, input, applied.reason);
    return { status: "REJECTED", reason: applied.reason };
  }

  const order = await tx.order.create({
    data: {
      clientOrderId: input.order.clientOrderId,
      cycleId: input.cycleId,
      accountId: input.accountId,
      pairAddress: input.order.pairAddress,
      baseSymbol: input.order.baseSymbol,
      side: input.order.side,
      intent: input.order.intent,
      status: "FILLED",
      qty: quoted.fill.qty,
      reasonCodes: input.order.reasonCodes,
    },
  });
  const fill = await tx.fill.create({
    data: {
      orderId: order.id,
      observationId: observation.id,
      pairAddress: input.order.pairAddress,
      side: input.order.side,
      qty: quoted.fill.qty,
      priceUsd: quoted.fill.priceUsd,
      notionalUsd: quoted.fill.notionalUsd,
      feeUsd: quoted.fill.feeUsd,
      slippageBps: quoted.fill.slippageBps,
      liquidityUsd: quoted.fill.liquidityUsd,
    },
  });
  await tx.ledgerEntry.createMany({
    data: applied.lines.map((line) => ({
      accountId: input.accountId,
      type: line.type,
      amountUsd: line.amountUsd,
      affectsCash: line.affectsCash,
      orderId: order.id,
      fillId: fill.id,
      note: line.note,
    })),
  });
  const nextPosition = applied.state.positions.find((position) => position.pairAddress === input.order.pairAddress);
  if (!nextPosition) throw new Error("POSITION_MISSING_AFTER_FILL");
  await tx.position.upsert({
    where: { accountId_pairAddress: { accountId: input.accountId, pairAddress: input.order.pairAddress } },
    create: { accountId: input.accountId, ...nextPosition },
    update: nextPosition,
  });
  await tx.paperAccount.update({
    where: { id: input.accountId },
    data: { cashUsd: applied.state.cashUsd },
  });
  return { status: "FILLED", reason: "FILLED" };
}

async function reject(
  tx: Prisma.TransactionClient,
  input: { accountId: string; cycleId: string; order: CommitOrder },
  reason: ReasonCode,
): Promise<void> {
  await tx.order.create({
    data: {
      clientOrderId: input.order.clientOrderId,
      cycleId: input.cycleId,
      accountId: input.accountId,
      pairAddress: input.order.pairAddress,
      baseSymbol: input.order.baseSymbol,
      side: input.order.side,
      intent: input.order.intent,
      status: "REJECTED",
      qty: input.order.qty,
      reasonCodes: input.order.reasonCodes,
      rejectReason: reason,
    },
  });
}

export async function readBook(prisma: PrismaClient, accountId: string): Promise<BookState> {
  const account = await prisma.paperAccount.findUniqueOrThrow({ where: { id: accountId } });
  const positions = await prisma.position.findMany({ where: { accountId } });
  return {
    cashUsd: account.cashUsd.toString(),
    positions: positions.map((position) => ({
      pairAddress: position.pairAddress,
      baseSymbol: position.baseSymbol,
      baseQty: position.baseQty.toString(),
      avgCostUsd: position.avgCostUsd.toString(),
      realizedPnlUsd: position.realizedPnlUsd.toString(),
    })),
  };
}
