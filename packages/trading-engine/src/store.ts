import { classifyFreshness, d, newId, type DataMode, type ReasonCode, type StrategyConfig } from "@odin/shared";
import { Prisma, type PrismaClient } from "@odin/shared/db";
import { findEligibleFillObservation } from "./eligible-observation.js";
import { applyFill, type BookState } from "./ledger.js";
import { quoteFill, type FillQuote } from "./fill.js";
import { ensurePositionLifecycleOnOpen, reduceProtectionForFill } from "./position-lifecycle.js";
import {
  releaseExitQty,
  reserveExitQty,
  settleFillByOwnerScope,
  type OwnerScope,
} from "./strategy-allocations.js";

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
  /** Durable StrategyInstance owner (§5/§8). */
  strategyInstanceId?: string | null;
  intentId?: string | null;
  ownerScope?: OwnerScope | null;
  estimatedCostUsd?: string | null;
  estimatedNotionalUsd?: string | null;
  submissionState?: string | null;
};

export async function lockAccount(tx: Prisma.TransactionClient, accountId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "PaperAccount" WHERE id = ${accountId} FOR UPDATE`;
}

type FillGateInput = { order: CommitOrder; config: StrategyConfig; mode: DataMode; now: Date };
type MarketObservation = Prisma.MarketObservationGetPayload<object>;

/** Long-only book: every non-ENTRY SELL (EXIT, FLATTEN, protection close, OPERATOR) reduces risk. */
export function isRiskReducing(order: Pick<CommitOrder, "side" | "intent">): boolean {
  return order.side === "SELL" && order.intent !== "ENTRY";
}

/**
 * Single freshness → liquidity → quote gate shared by both fill paths (immediate and pending).
 * Entries need LIVE data; DELAYED never opens risk. DEMO entries need the flag AND DATA_MODE=demo.
 * Risk-reducing SELLs use the exit execution policy instead of the entry impact caps.
 */
async function gateAndQuote(
  tx: Prisma.TransactionClient,
  input: FillGateInput,
): Promise<{ ok: true; observation: MarketObservation; fill: FillQuote } | { ok: false; reason: ReasonCode }> {
  const observation = await tx.marketObservation.findUnique({ where: { id: input.order.observationId } });
  if (!observation || observation.priceUsd === null) return { ok: false, reason: "MISSING_PRICE" };
  const instrumentKey = input.order.instrumentId ?? input.order.pairAddress;
  const needsDexLiquidity =
    !instrumentKey.startsWith("fx:") && !instrumentKey.startsWith("etf:") && !instrumentKey.startsWith("commodity:");
  if (needsDexLiquidity && observation.liquidityUsd === null) return { ok: false, reason: "MISSING_LIQUIDITY" };
  const freshness = resolveObservationFreshness(observation.freshness, {
    mode: input.mode,
    receivedAt: observation.receivedAt,
    now: input.now,
    liveMaxAgeMs: input.config.liveMaxAgeMs,
    delayedMaxAgeMs: input.config.delayedMaxAgeMs,
  });
  if (input.order.side === "BUY" && freshness !== "LIVE") {
    const demoOk = freshness === "DEMO" && input.config.allowDemoPaperEntries === true && input.mode === "demo";
    if (!demoOk) return { ok: false, reason: freshnessReason(freshness) };
  }
  if (input.order.side === "SELL" && freshness !== "LIVE") {
    const delayedOk = freshness === "DELAYED" && input.config.allowDelayedExits;
    // Exits reduce risk: in DATA_MODE=demo they may use DEMO quotes even with DEMO entries off (review F12).
    const demoOk = freshness === "DEMO" && (input.config.allowDemoPaperEntries === true || input.mode === "demo");
    if (!delayedOk && !demoOk) return { ok: false, reason: freshnessReason(freshness) };
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
    instrumentId: instrumentKey,
    exitPolicy: isRiskReducing(input.order) ? { maxExitImpactBps: input.config.maxExitImpactBps } : null,
  });
  if (!quoted.ok) return { ok: false, reason: quoted.reason };
  return { ok: true, observation, fill: quoted.fill };
}

/**
 * Exit policy remainder: the part of a risk-reducing SELL above maxExitImpactBps becomes a new
 * PENDING order, eligible now, that the next cycle's settle phase retries against a fresh quote.
 * A remainder of an already-pending STRATEGY exit keeps that order's reservation (settlement
 * released only the filled qty); a remainder of an immediate fill reserves its own qty.
 */
async function bookExitRemainder(
  tx: Prisma.TransactionClient,
  input: { accountId: string; cycleId: string; order: CommitOrder; config: StrategyConfig; now: Date },
  remainderQty: string,
  alreadyReserved: boolean,
): Promise<void> {
  if (d(remainderQty).lte(0)) return;
  // Reserve before booking. If the owner cannot reserve the remainder, book nothing: the unsold
  // quantity stays in the position and the next cycle plans a fresh exit (review F2).
  if (!alreadyReserved && (input.order.ownerScope ?? "LEGACY") === "STRATEGY" && input.order.strategyInstanceId) {
    const reserved = await reserveExitQty(tx, {
      accountId: input.accountId,
      strategyInstanceId: input.order.strategyInstanceId,
      pairAddress: input.order.pairAddress,
      qty: remainderQty,
    });
    if (!reserved.ok) return;
  }
  const existing = await tx.order.count({ where: { clientOrderId: { startsWith: `${input.order.clientOrderId}:rem` } } });
  await tx.order.create({
    data: {
      clientOrderId: `${input.order.clientOrderId}:rem${existing + 1}`,
      cycleId: input.cycleId,
      accountId: input.accountId,
      pairAddress: input.order.pairAddress,
      baseSymbol: input.order.baseSymbol,
      side: "SELL",
      intent: input.order.intent,
      status: "PENDING",
      qty: remainderQty,
      filledQty: 0,
      observationId: input.order.observationId,
      decisionObservationId: input.order.observationId,
      reasonCodes: [...input.order.reasonCodes, "EXIT_PARTIAL_REMAINDER", "ORDER_PENDING"],
      executionMode: input.order.executionMode ?? "PAPER",
      venue: input.order.venue ?? "PAPER",
      instrumentId: input.order.instrumentId ?? null,
      strategyVersion: input.order.strategyVersion ?? null,
      strategyInstanceId: input.order.strategyInstanceId ?? null,
      intentId: input.order.intentId ?? null,
      ownerScope: input.order.ownerScope ?? "LEGACY",
      submissionState: input.order.submissionState ?? "LOCAL",
      submittedAt: input.now,
      eligibleAt: input.now,
      expiresAt: new Date(input.now.getTime() + input.config.orderExpiryMs),
    },
  });
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

  // Local STRATEGY sells: refuse before booking venue when the instance does not own the qty.
  if (input.order.side === "SELL" && (input.order.ownerScope ?? "LEGACY") === "STRATEGY") {
    const gate = await assertStrategyOwnsSell(tx, input.accountId, input.order);
    if (!gate.ok) {
      await reject(tx, input, gate.reason, expiresAt, eligibleAt);
      return { status: "REJECTED", reason: gate.reason };
    }
  }

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
        strategyInstanceId: input.order.strategyInstanceId ?? null,
        intentId: input.order.intentId ?? null,
        ownerScope: input.order.ownerScope ?? "LEGACY",
        submissionState: input.order.submissionState ?? "LOCAL",
        submittedAt: input.now,
        eligibleAt,
        expiresAt,
      },
    });
    // Pending STRATEGY exit reserves owned qty so concurrent cycles cannot oversell.
    if (
      input.order.side === "SELL" &&
      (input.order.ownerScope ?? "LEGACY") === "STRATEGY" &&
      input.order.strategyInstanceId
    ) {
      await reserveExitQty(tx, {
        accountId: input.accountId,
        strategyInstanceId: input.order.strategyInstanceId,
        pairAddress: input.order.pairAddress,
        qty: input.order.qty,
      });
    }
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
    await releasePendingExitReservation(tx, order);
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
    await releasePendingExitReservation(tx, order);
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
      strategyInstanceId: order.strategyInstanceId,
      strategyVersion: order.strategyVersion,
      intentId: order.intentId,
      ownerScope: order.ownerScope as OwnerScope,
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
  // settlePendingOrder is the only place a pending order's exit reservation is released (review F3):
  // here for gate/quote/ledger rejections, above for expiry and missing observation.
  if (result.status === "REJECTED" || result.status === "EXPIRED") await releasePendingExitReservation(tx, order);
  // Report what actually filled; a capped exit fills less than requested (review F8).
  const after = result.status === "FILLED" ? await tx.order.findUnique({ where: { id: order.id } }) : null;
  return {
    ...result,
    filledQty: after ? after.filledQty.toString() : order.qty.toString(),
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
  const quoted = await gateAndQuote(tx, input);
  if (!quoted.ok) {
    await tx.order.update({
      where: { id: orderId },
      data: { status: "REJECTED", rejectReason: quoted.reason },
    });
    return { status: "REJECTED", reason: quoted.reason };
  }
  const observation = quoted.observation;

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
      strategyInstanceId: input.order.strategyInstanceId ?? null,
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
    create: {
      accountId: input.accountId,
      ...nextPosition,
      strategyInstanceId: input.order.strategyInstanceId ?? null,
    },
    update: {
      ...nextPosition,
      ...(input.order.side === "BUY" && input.order.strategyInstanceId
        ? { strategyInstanceId: input.order.strategyInstanceId }
        : {}),
    },
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
  const settled = await settleFillByOwnerScope(tx, {
    accountId: input.accountId,
    order: input.order,
    fillQty: quoted.fill.qty,
    priceUsd: quoted.fill.priceUsd,
    feeUsd: quoted.fill.feeUsd,
    lifecycleId,
  });
  if (!settled.ok) {
    // Local path already booked venue — surface recovery via settleFill (local STRATEGY was pre-gated).
    // For other scopes this should not happen; leave venue book intact and open recovery inside settle.
  }
  await tx.paperAccount.update({
    where: { id: input.accountId },
    data: { cashUsd: applied.state.cashUsd },
  });
  await bookExitRemainder(tx, input, quoted.fill.remainderQty, true);
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
  const quoted = await gateAndQuote(tx, input);
  if (!quoted.ok) {
    await reject(tx, input, quoted.reason, expiresAt, eligibleAt);
    return { status: "REJECTED", reason: quoted.reason };
  }
  const observation = quoted.observation;

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
      strategyInstanceId: input.order.strategyInstanceId ?? null,
      intentId: input.order.intentId ?? null,
      ownerScope: input.order.ownerScope ?? "LEGACY",
      submissionState: input.order.submissionState ?? "LOCAL",
      submittedAt: input.now,
      eligibleAt,
      expiresAt,
    },
  });
  const fill = await tx.fill.create({
    data: {
      orderId: order.id,
      observationId: observation.id,
      source: "LOCAL_SIM",
      pairAddress: input.order.pairAddress,
      side: input.order.side,
      qty: quoted.fill.qty,
      priceUsd: quoted.fill.priceUsd,
      notionalUsd: quoted.fill.notionalUsd,
      feeUsd: quoted.fill.feeUsd,
      slippageBps: quoted.fill.slippageBps,
      liquidityUsd: quoted.fill.liquidityUsd,
      strategyInstanceId: input.order.strategyInstanceId ?? null,
      feeKnown: true,
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
    create: {
      accountId: input.accountId,
      ...nextPosition,
      strategyInstanceId: input.order.strategyInstanceId ?? null,
    },
    update: {
      ...nextPosition,
      ...(input.order.side === "BUY" && input.order.strategyInstanceId
        ? { strategyInstanceId: input.order.strategyInstanceId }
        : {}),
    },
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
  await settleFillByOwnerScope(tx, {
    accountId: input.accountId,
    order: input.order,
    fillQty: quoted.fill.qty,
    priceUsd: quoted.fill.priceUsd,
    feeUsd: quoted.fill.feeUsd,
    lifecycleId,
  });
  await tx.paperAccount.update({
    where: { id: input.accountId },
    data: { cashUsd: applied.state.cashUsd },
  });
  await bookExitRemainder(tx, input, quoted.fill.remainderQty, false);
  return { status: "FILLED", reason: "FILLED" };
}

async function assertStrategyOwnsSell(
  tx: Prisma.TransactionClient,
  accountId: string,
  order: CommitOrder,
): Promise<{ ok: true } | { ok: false; reason: ReasonCode }> {
  const strategyInstanceId = order.strategyInstanceId;
  if (!strategyInstanceId) return { ok: false, reason: "ALLOCATION_NOT_OWNED" };
  const row = await tx.strategyAllocation.findUnique({
    where: {
      accountId_strategyInstanceId_pairAddress: {
        accountId,
        strategyInstanceId,
        pairAddress: order.pairAddress,
      },
    },
  });
  if (!row) return { ok: false, reason: "ALLOCATION_NOT_OWNED" };
  const available = d(row.qty.toString()).minus(d(row.reservedExitQty.toString()));
  if (d(order.qty).gt(available)) return { ok: false, reason: "SELL_EXCEEDS_POSITION" };
  return { ok: true };
}

/**
 * Apply a broker-confirmed execution to a durable Order (SANDBOX path).
 * Never discards a confirmed fill to preserve an internal invariant — shortfalls open RecoveryCase.
 * Idempotent on (orderId, brokerExecutionId).
 */
export async function applyExternalFill(
  tx: Prisma.TransactionClient,
  input: {
    accountId: string;
    orderId: string;
    brokerExecutionId: string;
    qty: string;
    priceUsd: string | null;
    feeUsd: string | null;
    feeKnown: boolean;
    executedAt: Date;
    currency?: string;
  },
): Promise<{ status: "FILLED" | "PARTIAL" | "REPLAY" | "REJECTED"; reason: string | null }> {
  const existing = await tx.fill.findUnique({
    where: {
      orderId_brokerExecutionId: { orderId: input.orderId, brokerExecutionId: input.brokerExecutionId },
    },
  });
  if (existing) return { status: "REPLAY", reason: "IDEMPOTENT_REPLAY" };

  const order = await tx.order.findUnique({ where: { id: input.orderId } });
  if (!order || order.accountId !== input.accountId) {
    return { status: "REJECTED", reason: "ORDER_MISSING" };
  }
  if (!input.priceUsd || d(input.priceUsd).lte(0)) {
    // Incomplete broker fill — do not invent a price; open recovery and leave UNKNOWN.
    await tx.recoveryCase.upsert({
      where: { dedupeKey: `FILL_INCOMPLETE|${input.orderId}|${input.brokerExecutionId}` },
      create: {
        dedupeKey: `FILL_INCOMPLETE|${input.orderId}|${input.brokerExecutionId}`,
        accountId: input.accountId,
        kind: "FILL_INCOMPLETE",
        severity: "ERROR",
        orderId: input.orderId,
        clientOrderId: order.clientOrderId,
        pairAddress: order.pairAddress,
        detail: { brokerExecutionId: input.brokerExecutionId, qty: input.qty, priceUsd: input.priceUsd },
        status: "OPEN",
      },
      update: { attempts: { increment: 1 } },
    });
    await tx.order.update({
      where: { id: order.id },
      data: { submissionState: "UNKNOWN", lastBrokerStatus: "FILL_PRICE_MISSING" },
    });
    return { status: "REJECTED", reason: "FILL_INCOMPLETE" };
  }

  const fillQty = d(input.qty);
  const price = d(input.priceUsd);
  const fee = d(input.feeUsd ?? "0");
  const notional = fillQty.mul(price);
  const account = await tx.paperAccount.findUnique({ where: { id: input.accountId } });
  const positions = await tx.position.findMany({ where: { accountId: input.accountId } });
  if (!account) return { status: "REJECTED", reason: "ACCOUNT_MISSING" };

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
  const priorPosition = positions.find((p) => p.pairAddress === order.pairAddress);
  const priorQty = priorPosition?.baseQty.toString() ?? "0";
  const applied = applyFill(state, {
    pairAddress: order.pairAddress,
    baseSymbol: order.baseSymbol,
    side: order.side as "BUY" | "SELL",
    fill: {
      qty: fillQty.toFixed(8),
      priceUsd: price.toFixed(8),
      notionalUsd: notional.toFixed(8),
      feeUsd: fee.toFixed(8),
      slippageBps: "0",
      liquidityUsd: "0",
      estimatedCostUsd: notional.plus(fee).toFixed(8),
      spreadBps: "0",
      impactBps: "0",
      remainderQty: "0",
    },
  });
  if (!applied.ok) return { status: "REJECTED", reason: applied.reason };

  const fill = await tx.fill.create({
    data: {
      orderId: order.id,
      observationId: null,
      source: "BROKER",
      brokerExecutionId: input.brokerExecutionId,
      executedAt: input.executedAt,
      currency: input.currency ?? "USD",
      feeKnown: input.feeKnown,
      pairAddress: order.pairAddress,
      side: order.side,
      qty: fillQty.toFixed(8),
      priceUsd: price.toFixed(8),
      notionalUsd: notional.toFixed(8),
      feeUsd: fee.toFixed(8),
      slippageBps: "0",
      liquidityUsd: "0",
      strategyInstanceId: order.strategyInstanceId,
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
  const nextPosition = applied.state.positions.find((position) => position.pairAddress === order.pairAddress);
  if (!nextPosition) throw new Error("POSITION_MISSING_AFTER_FILL");
  await tx.position.upsert({
    where: { accountId_pairAddress: { accountId: input.accountId, pairAddress: order.pairAddress } },
    create: {
      accountId: input.accountId,
      ...nextPosition,
      strategyInstanceId: order.strategyInstanceId,
    },
    update: nextPosition,
  });
  const lifecycleId = await ensurePositionLifecycleOnOpen(tx, {
    accountId: input.accountId,
    pairAddress: order.pairAddress,
    nextBaseQty: nextPosition.baseQty,
    priorBaseQty: priorQty,
  });
  const newFilled = d(order.filledQty.toString()).plus(fillQty);
  const fullyFilled = newFilled.gte(d(order.qty.toString()));
  await tx.order.update({
    where: { id: order.id },
    data: {
      filledQty: newFilled.toFixed(8),
      status: fullyFilled ? "FILLED" : "PENDING",
      submissionState: fullyFilled ? "TERMINAL" : order.submissionState,
      lastBrokerSyncAt: input.executedAt,
      lastBrokerStatus: fullyFilled ? "FILLED" : "PARTIALLY_FILLED",
    },
  });
  await settleFillByOwnerScope(tx, {
    accountId: input.accountId,
    order: {
      side: order.side as "BUY" | "SELL",
      intent: order.intent,
      pairAddress: order.pairAddress,
      instrumentId: order.instrumentId,
      strategyInstanceId: order.strategyInstanceId,
      ownerScope: order.ownerScope,
      clientOrderId: order.clientOrderId,
    },
    fillQty: fillQty.toFixed(8),
    priceUsd: price.toFixed(8),
    feeUsd: fee.toFixed(8),
    lifecycleId,
    externalConfirmed: true,
  });
  await tx.paperAccount.update({
    where: { id: input.accountId },
    data: { cashUsd: applied.state.cashUsd },
  });
  return { status: fullyFilled ? "FILLED" : "PARTIAL", reason: null };
}

/** Release exit reservation when a pending STRATEGY sell is cancelled/expired/rejected. */
export async function releasePendingExitReservation(
  tx: Prisma.TransactionClient,
  order: { accountId: string; side: string; ownerScope: string | null; strategyInstanceId: string | null; pairAddress: string; qty: { toString(): string } | string },
): Promise<void> {
  if (order.side !== "SELL" || (order.ownerScope ?? "LEGACY") !== "STRATEGY" || !order.strategyInstanceId) return;
  await releaseExitQty(tx, {
    accountId: order.accountId,
    strategyInstanceId: order.strategyInstanceId,
    pairAddress: order.pairAddress,
    qty: order.qty.toString(),
  });
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
      strategyInstanceId: input.order.strategyInstanceId ?? null,
      intentId: input.order.intentId ?? null,
      ownerScope: input.order.ownerScope ?? "LEGACY",
      submissionState: input.order.submissionState ?? "LOCAL",
      eligibleAt: eligibleAt ?? undefined,
      expiresAt: expiresAt ?? undefined,
    },
  });
}

// newId kept for future RecoveryCase ids from this module.
void newId;

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
