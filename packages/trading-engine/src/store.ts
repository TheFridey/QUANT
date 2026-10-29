import { classifyFreshness, type DataMode, type ReasonCode, type StrategyConfig } from "@odin/shared";
import { Prisma, type PrismaClient } from "@odin/shared/db";
import { findEligibleFillObservation } from "./eligible-observation.js";
import { applyFill, type BookState } from "./ledger.js";
import { quoteFill } from "./fill.js";
import { ensurePositionLifecycleOnOpen, reduceProtectionForFill } from "./position-lifecycle.js";

export type CommitOrder = {
  clientOrderId: string;
  pairAddress: string;
  baseSymbol: string;
  side: "BUY" | "SELL";
  intent: "ENTRY" | "EXIT" | "FLATTEN" | "OPERATOR";
  qty: string;
  observationId: string;
  reasonCodes: ReasonCode[];
  /** Planner eligibility — when in the future, order is PENDING (no fill yet). */
  eligibleAt?: string;
  expiresAt?: string;
  executionMode?: "PAPER" | "SANDBOX" | "LIVE";
  venue?: string;
  instrumentId?: string | null;
  strategyVersion?: string | null;
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
): Promise<{ status: "FILLED" | "PENDING" | "REJECTED" | "REPLAY" | "EXPIRED"; reason: ReasonCode | null }> {
  const existing = await tx.order.findUnique({ where: { clientOrderId: input.order.clientOrderId } });
  if (existing) return { status: "REPLAY", reason: "IDEMPOTENT_REPLAY" };

  const eligibleAt = input.order.eligibleAt ? new Date(input.order.eligibleAt) : input.now;
  const expiresAt = input.order.expiresAt ? new Date(input.order.expiresAt) : null;

  if (Number.isFinite(eligibleAt.getTime()) && eligibleAt.getTime() > input.now.getTime()) {
    await tx.order.create({
      data: {
        clientOrderId: input.order.clientOrderId,
        cycleId: input.cycleId,
        accountId: input.accountId,
        pairAddress: input.order.pairAddress,
        baseSymbol: input.order.baseSymbol,
        side: input.order.side,
        intent: input.order.intent,
        status: "PENDING",
        qty: input.order.qty,
        filledQty: 0,
        observationId: input.order.observationId,
        decisionObservationId: input.order.observationId,
        reasonCodes: [...input.order.reasonCodes, "ORDER_PENDING"],
        executionMode: input.order.executionMode ?? "PAPER",
        venue: input.order.venue ?? "PAPER",
        instrumentId: input.order.instrumentId ?? null,
        strategyVersion: input.order.strategyVersion ?? null,
        submittedAt: input.now,
        eligibleAt,
        expiresAt,
      },
    });
    return { status: "PENDING", reason: "ORDER_PENDING" };
  }

  if (expiresAt && expiresAt.getTime() <= input.now.getTime()) {
    await reject(tx, input, "ORDER_EXPIRED", expiresAt, eligibleAt);
    return { status: "EXPIRED", reason: "ORDER_EXPIRED" };
  }

  return fillCommittedOrder(tx, input, eligibleAt, expiresAt);
}

/** Fill a previously PENDING order once eligible, or expire it. Idempotent on already-filled. */
export async function settlePendingOrder(
  tx: Prisma.TransactionClient,
  input: {
    accountId: string;
    orderId: string;
    config: StrategyConfig;
    mode: DataMode;
    now: Date;
    tradingEnvironment?: string | null;
  },
): Promise<{
  status: "FILLED" | "PENDING" | "REJECTED" | "EXPIRED" | "SKIP";
  reason: ReasonCode | null;
  filledQty?: string;
  side?: "BUY" | "SELL";
  pairAddress?: string;
  fillObservationId?: string;
}> {
  const order = await tx.order.findUnique({ where: { id: input.orderId } });
  if (!order) return { status: "SKIP", reason: null };
  if (order.status !== "PENDING") return { status: "SKIP", reason: "IDEMPOTENT_REPLAY" };
  if (order.expiresAt && order.expiresAt.getTime() <= input.now.getTime()) {
    await tx.order.update({
      where: { id: order.id },
      data: { status: "EXPIRED", rejectReason: "ORDER_EXPIRED", reasonCodes: [...order.reasonCodes, "ORDER_EXPIRED"] },
    });
    return { status: "EXPIRED", reason: "ORDER_EXPIRED" };
  }
  if (order.eligibleAt && order.eligibleAt.getTime() > input.now.getTime()) {
    return { status: "PENDING", reason: "ORDER_PENDING" };
  }
  if (!order.observationId) {
    await tx.order.update({
      where: { id: order.id },
      data: { status: "REJECTED", rejectReason: "MISSING_PRICE" },
    });
    return { status: "REJECTED", reason: "MISSING_PRICE" };
  }

  const eligibleAt = order.eligibleAt ?? input.now;
  // R04/D03: fill against same-instrument observation within eligibility bounds — not the decision quote.
  const fillObservation = await findEligibleFillObservation(tx, {
    pairAddress: order.pairAddress,
    eligibleAt,
    now: input.now,
    expiresAt: order.expiresAt,
    tradingEnvironment: input.tradingEnvironment ?? input.config.tradingEnvironment ?? null,
    preferIngestJobId: order.cycleId,
    allowNullEnvironment: false,
  });
  if (!fillObservation || fillObservation.priceUsd === null) {
    // No eligible event yet — keep pending (do not fill on stale pre-eligibility quote).
    return { status: "PENDING", reason: "ORDER_PENDING" };
  }

  const commitInput = {
    accountId: input.accountId,
    cycleId: order.cycleId,
    order: {
      clientOrderId: order.clientOrderId,
      pairAddress: order.pairAddress,
      baseSymbol: order.baseSymbol,
      side: order.side as CommitOrder["side"],
      intent: order.intent as CommitOrder["intent"],
      qty: order.qty.toString(),
      observationId: fillObservation.id,
      reasonCodes: order.reasonCodes as ReasonCode[],
      instrumentId: order.instrumentId,
    },
    config: input.config,
    mode: input.mode,
    now: input.now,
  };

  const result = await fillExistingPending(
    tx,
    commitInput,
    order.id,
    eligibleAt,
    order.expiresAt,
    {
      decisionObservationId: order.decisionObservationId ?? order.observationId,
      fillObservationId: fillObservation.id,
    },
  );
  return {
    ...result,
    filledQty: order.qty.toString(),
    side: order.side as "BUY" | "SELL",
    pairAddress: order.pairAddress,
    fillObservationId: fillObservation.id,
  };
}

async function fillExistingPending(
  tx: Prisma.TransactionClient,
  input: {
    accountId: string;
    cycleId: string;
    order: CommitOrder;
    config: StrategyConfig;
    mode: DataMode;
    now: Date;
  },
  orderId: string,
  eligibleAt: Date,
  expiresAt: Date | null,
  provenance?: { decisionObservationId: string | null; fillObservationId: string },
): Promise<{ status: "FILLED" | "REJECTED" | "EXPIRED"; reason: ReasonCode | null }> {
  const observation = await tx.marketObservation.findUnique({ where: { id: input.order.observationId } });
  if (!observation || observation.priceUsd === null) {
    await tx.order.update({
      where: { id: orderId },
      data: { status: "REJECTED", rejectReason: "MISSING_PRICE" },
    });
    return { status: "REJECTED", reason: "MISSING_PRICE" };
  }
  const instrumentKey = input.order.instrumentId ?? input.order.pairAddress;
  const needsDexLiquidity = !instrumentKey.startsWith("fx:") && !instrumentKey.startsWith("etf:") && !instrumentKey.startsWith("commodity:");
  if (needsDexLiquidity && observation.liquidityUsd === null) {
    await tx.order.update({
      where: { id: orderId },
      data: { status: "REJECTED", rejectReason: "MISSING_LIQUIDITY" },
    });
    return { status: "REJECTED", reason: "MISSING_LIQUIDITY" };
  }
  const freshness = resolveObservationFreshness(observation.freshness, {
    mode: input.mode,
    receivedAt: observation.receivedAt,
    now: input.now,
    liveMaxAgeMs: input.config.liveMaxAgeMs,
    delayedMaxAgeMs: input.config.delayedMaxAgeMs,
  });
  if (input.order.side === "BUY" && freshness !== "LIVE") {
    const demoOk = freshness === "DEMO" && input.config.allowDemoPaperEntries === true;
    const delayedOk = freshness === "DELAYED" && input.config.allowDemoPaperEntries === true;
    if (!demoOk && !delayedOk) {
      const reason = freshnessReason(freshness);
      await tx.order.update({
        where: { id: orderId },
        data: { status: "REJECTED", rejectReason: reason },
      });
      return { status: "REJECTED", reason };
    }
  }
  if (input.order.side === "SELL" && freshness !== "LIVE") {
    const delayedOk = freshness === "DELAYED" && input.config.allowDelayedExits;
    const demoOk = freshness === "DEMO" && input.config.allowDemoPaperEntries === true;
    if (!delayedOk && !demoOk) {
      const reason = freshnessReason(freshness);
      await tx.order.update({
        where: { id: orderId },
        data: { status: "REJECTED", rejectReason: reason },
      });
      return { status: "REJECTED", reason };
    }
  }

  const quoted = quoteFill({
    side: input.order.side,
    midPriceUsd: observation.priceUsd.toString(),
    quantity: input.order.qty,
    liquidityUsd: observation.liquidityUsd?.toString() ?? "0",
    feeBps: input.config.feeBps,
    maxSlippageBps: input.config.maxSlippageBps,
    spreadBpsEstimate: input.config.spreadBpsEstimate,
    maxPriceImpactBps: input.config.maxPriceImpactBps,
    instrumentId: input.order.instrumentId ?? input.order.pairAddress,
  });
  if (!quoted.ok) {
    await tx.order.update({
      where: { id: orderId },
      data: { status: "REJECTED", rejectReason: quoted.reason },
    });
    return { status: "REJECTED", reason: quoted.reason };
  }

  const account = await tx.paperAccount.findUnique({ where: { id: input.accountId } });
  const positions = await tx.position.findMany({ where: { accountId: input.accountId } });
  if (!account) {
    await tx.order.update({
      where: { id: orderId },
      data: { status: "REJECTED", rejectReason: "REJECTED" },
    });
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
  const priorPosition = positions.find((p) => p.pairAddress === input.order.pairAddress);
  const priorQty = priorPosition?.baseQty.toString() ?? "0";
  const applied = applyFill(state, {
    pairAddress: input.order.pairAddress,
    baseSymbol: input.order.baseSymbol,
    side: input.order.side,
    fill: quoted.fill,
  });
  if (!applied.ok) {
    await tx.order.update({
      where: { id: orderId },
      data: { status: "REJECTED", rejectReason: applied.reason },
    });
    return { status: "REJECTED", reason: applied.reason };
  }

  const fillObservationId = provenance?.fillObservationId ?? observation.id;
  const decisionObservationId =
    provenance?.decisionObservationId ?? input.order.observationId ?? observation.id;

  await tx.order.update({
    where: { id: orderId },
    data: {
      status: "FILLED",
      qty: quoted.fill.qty,
      filledQty: quoted.fill.qty,
      observationId: decisionObservationId,
      decisionObservationId,
      fillObservationId,
      reasonCodes: [...input.order.reasonCodes, "COST_ESTIMATED", "SPREAD_APPLIED", "FILLED"],
      eligibleAt,
      expiresAt,
    },
  });
  const fill = await tx.fill.create({
    data: {
      orderId,
      observationId: fillObservationId,
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
      orderId,
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
  const lifecycleId = await ensurePositionLifecycleOnOpen(tx, {
    accountId: input.accountId,
    pairAddress: input.order.pairAddress,
    nextBaseQty: nextPosition.baseQty,
    priorBaseQty: priorQty,
  });
  if (input.order.side === "SELL") {
    await reduceProtectionForFill(tx, {
      accountId: input.accountId,
      pairAddress: input.order.pairAddress,
      lifecycleId,
      reduceQty: quoted.fill.qty,
    });
  }
  await tx.paperAccount.update({
    where: { id: input.accountId },
    data: { cashUsd: applied.state.cashUsd },
  });
  return { status: "FILLED", reason: "FILLED" };
}

async function fillCommittedOrder(
  tx: Prisma.TransactionClient,
  input: {
    accountId: string;
    cycleId: string;
    order: CommitOrder;
    config: StrategyConfig;
    mode: DataMode;
    now: Date;
  },
  eligibleAt: Date,
  expiresAt: Date | null,
): Promise<{ status: "FILLED" | "REJECTED"; reason: ReasonCode | null }> {
  const observation = await tx.marketObservation.findUnique({ where: { id: input.order.observationId } });
  if (!observation || observation.priceUsd === null) {
    await reject(tx, input, "MISSING_PRICE", expiresAt, eligibleAt);
    return { status: "REJECTED", reason: "MISSING_PRICE" };
  }
  const instrumentKey = input.order.instrumentId ?? input.order.pairAddress;
  const needsDexLiquidity =
    !instrumentKey.startsWith("fx:") &&
    !instrumentKey.startsWith("etf:") &&
    !instrumentKey.startsWith("commodity:");
  if (needsDexLiquidity && observation.liquidityUsd === null) {
    await reject(tx, input, "MISSING_LIQUIDITY", expiresAt, eligibleAt);
    return { status: "REJECTED", reason: "MISSING_LIQUIDITY" };
  }
  const freshness = resolveObservationFreshness(observation.freshness, {
    mode: input.mode,
    receivedAt: observation.receivedAt,
    now: input.now,
    liveMaxAgeMs: input.config.liveMaxAgeMs,
    delayedMaxAgeMs: input.config.delayedMaxAgeMs,
  });
  if (input.order.side === "BUY" && freshness !== "LIVE") {
    const demoOk = freshness === "DEMO" && input.config.allowDemoPaperEntries === true;
    const delayedOk = freshness === "DELAYED" && input.config.allowDemoPaperEntries === true;
    if (!demoOk && !delayedOk) {
      const reason = freshnessReason(freshness);
      await reject(tx, input, reason, expiresAt, eligibleAt);
      return { status: "REJECTED", reason };
    }
  }
  if (input.order.side === "SELL" && freshness !== "LIVE") {
    const delayedOk = freshness === "DELAYED" && input.config.allowDelayedExits;
    const demoOk = freshness === "DEMO" && input.config.allowDemoPaperEntries === true;
    if (!delayedOk && !demoOk) {
      const reason = freshnessReason(freshness);
      await reject(tx, input, reason, expiresAt, eligibleAt);
      return { status: "REJECTED", reason };
    }
  }

  const quoted = quoteFill({
    side: input.order.side,
    midPriceUsd: observation.priceUsd.toString(),
    quantity: input.order.qty,
    liquidityUsd: observation.liquidityUsd?.toString() ?? "0",
    feeBps: input.config.feeBps,
    maxSlippageBps: input.config.maxSlippageBps,
    spreadBpsEstimate: input.config.spreadBpsEstimate,
    maxPriceImpactBps: input.config.maxPriceImpactBps,
    instrumentId: input.order.instrumentId ?? input.order.pairAddress,
  });
  if (!quoted.ok) {
    await reject(tx, input, quoted.reason, expiresAt, eligibleAt);
    return { status: "REJECTED", reason: quoted.reason };
  }

  const account = await tx.paperAccount.findUnique({ where: { id: input.accountId } });
  const positions = await tx.position.findMany({ where: { accountId: input.accountId } });
  if (!account) {
    await reject(tx, input, "REJECTED", expiresAt, eligibleAt);
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
  const priorPosition = positions.find((p) => p.pairAddress === input.order.pairAddress);
  const priorQty = priorPosition?.baseQty.toString() ?? "0";
  const applied = applyFill(state, {
    pairAddress: input.order.pairAddress,
    baseSymbol: input.order.baseSymbol,
    side: input.order.side,
    fill: quoted.fill,
  });
  if (!applied.ok) {
    await reject(tx, input, applied.reason, expiresAt, eligibleAt);
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
      filledQty: quoted.fill.qty,
      observationId: observation.id,
      decisionObservationId: observation.id,
      fillObservationId: observation.id,
      reasonCodes: [...input.order.reasonCodes, "COST_ESTIMATED", "SPREAD_APPLIED"],
      executionMode: input.order.executionMode ?? "PAPER",
      venue: input.order.venue ?? "PAPER",
      instrumentId: input.order.instrumentId ?? null,
      strategyVersion: input.order.strategyVersion ?? null,
      submittedAt: input.now,
      eligibleAt,
      expiresAt,
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
  const lifecycleId = await ensurePositionLifecycleOnOpen(tx, {
    accountId: input.accountId,
    pairAddress: input.order.pairAddress,
    nextBaseQty: nextPosition.baseQty,
    priorBaseQty: priorQty,
  });
  if (input.order.side === "SELL") {
    await reduceProtectionForFill(tx, {
      accountId: input.accountId,
      pairAddress: input.order.pairAddress,
      lifecycleId,
      reduceQty: quoted.fill.qty,
    });
  }
  await tx.paperAccount.update({
    where: { id: input.accountId },
    data: { cashUsd: applied.state.cashUsd },
  });
  return { status: "FILLED", reason: "FILLED" };
}

function resolveObservationFreshness(
  stored: string | null | undefined,
  input: {
    mode: DataMode;
    receivedAt: Date;
    now: Date;
    liveMaxAgeMs: number;
    delayedMaxAgeMs: number;
  },
) {
  // Honour explicit DEMO / DELAYED / REPLAY provenance — never promote to LIVE.
  if (stored === "DEMO") return "DEMO" as const;
  if (stored === "DELAYED") return "DELAYED" as const;
  if (stored === "REPLAY") return "REPLAY" as const;
  return classifyFreshness(input);
}

function freshnessReason(freshness: string): ReasonCode {
  if (freshness === "DELAYED") return "DATA_DELAYED";
  if (freshness === "STALE") return "DATA_STALE";
  if (freshness === "REPLAY") return "DATA_REPLAY";
  return "DATA_DEMO";
}

async function reject(
  tx: Prisma.TransactionClient,
  input: { accountId: string; cycleId: string; order: CommitOrder },
  reason: ReasonCode,
  expiresAt: Date | null = null,
  eligibleAt: Date | null = null,
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
      status: reason === "ORDER_EXPIRED" ? "EXPIRED" : "REJECTED",
      qty: input.order.qty,
      reasonCodes: input.order.reasonCodes,
      rejectReason: reason,
      executionMode: input.order.executionMode ?? "PAPER",
      venue: input.order.venue ?? "PAPER",
      instrumentId: input.order.instrumentId ?? null,
      strategyVersion: input.order.strategyVersion ?? null,
      eligibleAt: eligibleAt ?? undefined,
      expiresAt: expiresAt ?? undefined,
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
