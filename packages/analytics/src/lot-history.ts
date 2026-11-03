import { Decimal, d, MANUAL_INSTANCE_ID, UNATTRIBUTED_INSTANCE_ID, usd } from "@odin/shared";

/**
 * ASCEND-09 lot history: rebuilds per-position lifecycle histories ("lots") from the fill ledger.
 *
 * Pure and read-only. A lot opens on a fill that takes the reconstructed position from 0 to a positive
 * quantity and closes on the fill that returns it to 0. Lot boundaries always come from the fill sequence
 * per (account, pair); a recorded lifecycle id (TradeLotSnapshot, Position, ProtectionOrder) only labels
 * the lot, and every lot says which identity method and source were used.
 *
 * Money arithmetic mirrors the paper ledger (average cost including fees, 8 dp, ROUND_HALF_UP), so the
 * recomputed realised P&L can be reconciled row by row against REALIZED_PNL ledger entries. Anything that
 * does not reconcile is reported, never absorbed. Missing marks are null, never zero.
 */

export const LOT_HISTORY_VERSION = "lot-history-1.0.0";

export type LotFillInput = {
  id: string;
  orderId: string;
  accountId: string;
  pairAddress: string;
  baseSymbol: string;
  side: "BUY" | "SELL";
  qty: string;
  priceUsd: string;
  notionalUsd: string;
  feeUsd: string;
  feeKnown: boolean;
  slippageBps: string;
  /** Fill time (ISO). */
  createdAt: string;
  /** LOCAL_SIM | BROKER */
  source: string;
  /** Fill.strategyInstanceId, falling back to Order.strategyInstanceId. */
  strategyInstanceId: string | null;
  intent: string;
  ownerScope: string | null;
  reasonCodes: string[];
  strategyVersion: string | null;
  cycleId: string | null;
  /** Fill.observationId (the observation the fill was priced on), when known. */
  observationId?: string | null;
};

type Stringish = { toString(): string };

/** Map a Fill row (with its Order) to LotFillInput. Structural types: no database client is imported. */
export function lotFillFromRow(row: {
  id: string;
  orderId: string;
  pairAddress: string;
  side: string;
  qty: Stringish;
  priceUsd: Stringish;
  notionalUsd: Stringish;
  feeUsd: Stringish;
  feeKnown: boolean;
  slippageBps: Stringish;
  source: string;
  strategyInstanceId: string | null;
  observationId?: string | null;
  createdAt: Date;
  order: {
    accountId: string;
    baseSymbol: string;
    intent: string;
    ownerScope: string | null;
    reasonCodes: string[];
    strategyInstanceId: string | null;
    strategyVersion: string | null;
    cycleId: string;
  };
}): LotFillInput {
  return {
    id: row.id,
    orderId: row.orderId,
    accountId: row.order.accountId,
    pairAddress: row.pairAddress,
    baseSymbol: row.order.baseSymbol,
    side: row.side === "SELL" ? "SELL" : "BUY",
    qty: row.qty.toString(),
    priceUsd: row.priceUsd.toString(),
    notionalUsd: row.notionalUsd.toString(),
    feeUsd: row.feeUsd.toString(),
    feeKnown: row.feeKnown,
    slippageBps: row.slippageBps.toString(),
    createdAt: row.createdAt.toISOString(),
    source: row.source,
    strategyInstanceId: row.strategyInstanceId ?? row.order.strategyInstanceId,
    intent: row.order.intent,
    ownerScope: row.order.ownerScope,
    reasonCodes: row.order.reasonCodes ?? [],
    strategyVersion: row.order.strategyVersion,
    cycleId: row.order.cycleId,
    observationId: row.observationId ?? null,
  };
}

export type LifecycleIdSource = "TRADE_LOT_SNAPSHOT" | "POSITION" | "PROTECTION_ORDER";

export type LifecycleHint =
  /** Recorded by the ASCEND-09 writer against the lot's entry fill. */
  | { source: "TRADE_LOT_SNAPSHOT"; accountId: string; pairAddress: string; lifecycleId: string; entryFillId: string }
  /** Position.lifecycleId of an open position: labels the current open lot only. */
  | { source: "POSITION"; accountId: string; pairAddress: string; lifecycleId: string }
  /** ProtectionOrder.lifecycleId: labels the lot whose [open, close] window contains the protection's createdAt. */
  | { source: "PROTECTION_ORDER"; accountId: string; pairAddress: string; lifecycleId: string; at: string };

export type LotEventKind = "ENTRY" | "ADD" | "REDUCE" | "EXIT";

export type ExitReason = { code: string; source: "REASON_CODE" | "INTENT_FALLBACK" };

export type InstanceSlice = { strategyInstanceId: string; qty: string; realizedPnlUsd: string | null; feeUsd: string };

export type LotEvent = {
  fillId: string;
  orderId: string;
  at: string;
  kind: LotEventKind;
  side: "BUY" | "SELL";
  qty: string;
  priceUsd: string;
  notionalUsd: string;
  feeUsd: string;
  feeKnown: boolean;
  slippageBps: string;
  /** Cost of slippage against the mid implied by slippageBps (always ≥ 0 for adverse slippage). */
  slippageUsd: string;
  intent: string;
  ownerScope: string | null;
  reasonCodes: string[];
  exitReason: ExitReason | null;
  strategyInstanceId: string | null;
  strategyVersion: string | null;
  cycleId: string | null;
  positionQtyBefore: string;
  positionQtyAfter: string;
  avgCostBeforeUsd: string;
  avgCostAfterUsd: string;
  /** Recomputed with the ledger's arithmetic; null for BUY fills. */
  realizedPnlUsd: string | null;
  /** How the fill was attributed to strategy instances (mirrors allocation settlement). */
  attribution: InstanceSlice[];
};

export type LotFlag =
  | "SELL_EXCEEDS_RECONSTRUCTED_POSITION"
  | "LIFECYCLE_ID_CONFLICT"
  | "LIFECYCLE_ID_SPANS_LOTS"
  | "FEE_UNKNOWN"
  | "ALLOCATION_SHORTFALL"
  | "ALLOCATION_RESIDUAL_AT_CLOSE"
  | "COST_BASIS_UNKNOWN";

export type LotInstanceAttribution = {
  strategyInstanceId: string;
  boughtQty: string;
  soldQty: string;
  feesUsd: string;
  /** Share of the lot's ledger-basis realised P&L (sell fills split by quantity). Sums to the lot total. */
  realizedPnlUsd: string;
  /** Realised P&L on the instance's own average cost, as StrategyAllocation books it; null when unknown. */
  allocationBasisRealizedPnlUsd: string | null;
};

export type Lot = {
  /** Stable lot key: the id of the fill that opened the lot. */
  lotKey: string;
  identityMethod: "LIFECYCLE_ID" | "FILL_SEQUENCE";
  lifecycleId: string | null;
  lifecycleIdSource: LifecycleIdSource | null;
  /** Boundaries always come from the fill sequence; this field records it explicitly. */
  boundaryMethod: "FILL_SEQUENCE";
  accountId: string;
  pairAddress: string;
  baseSymbol: string;
  status: "OPEN" | "CLOSED";
  openedAt: string;
  closedAt: string | null;
  /** Closed: close − open. Open: asOf − open (labelled by holdingBasis). */
  holdingSeconds: number;
  holdingBasis: "OPEN_TO_CLOSE" | "OPEN_TO_ASOF";
  entryFillId: string;
  events: LotEvent[];
  boughtQty: string;
  soldQty: string;
  openQty: string;
  /** Price of the entry fill: the MAE/MFE reference. */
  entryPriceUsd: string;
  /** Volume-weighted buy price (fees excluded). */
  avgEntryPriceUsd: string;
  /** Ledger average cost (fees included) of the open quantity; "0.00000000" when closed. */
  avgCostUsd: string;
  /** Volume-weighted sell price; null with no sells. */
  avgExitPriceUsd: string | null;
  entryNotionalUsd: string;
  exitNotionalUsd: string;
  feesUsd: string;
  slippageUsd: string;
  realizedPnlUsd: string;
  instances: LotInstanceAttribution[];
  flags: LotFlag[];
};

export type OrphanFill = { fill: LotFillInput; reason: "SELL_WITHOUT_OPEN_LOT" };

export type LotHistory = {
  version: string;
  asOf: string;
  lots: Lot[];
  orphanFills: OrphanFill[];
};

/** Instance id used when an exit quantity cannot be matched to an owning allocation. */
export const UNRESOLVED_ATTRIBUTION_ID = "unresolved";

const ZERO = new Decimal(0);
const EXIT_REASON_PRIORITY = [
  "STOP_LOSS",
  "TAKE_PROFIT",
  "TRAILING_STOP",
  "TIME_EXIT",
  "MAX_HOLDING",
  "EXIT_MOMENTUM",
  "EMERGENCY_STOP",
  "STRATEGY_INSTANCE_EXIT",
  "OPERATOR_OVERRIDE",
  "EXIT_PARTIAL_REMAINDER",
];

/** Most specific exit reason recorded on the order; falls back to the intent (labelled). */
export function exitReasonFor(fill: Pick<LotFillInput, "reasonCodes" | "intent" | "ownerScope">): ExitReason {
  for (const code of EXIT_REASON_PRIORITY) {
    if (fill.reasonCodes.includes(code)) return { code, source: "REASON_CODE" };
  }
  const other = fill.reasonCodes.find((code) => code.startsWith("EXIT_") && code !== "EXIT_QTY_RESERVED");
  if (other) return { code: other, source: "REASON_CODE" };
  return { code: `${fill.ownerScope ?? "UNKNOWN"}:${fill.intent}`, source: "INTENT_FALLBACK" };
}

/** Slippage cost in USD implied by the recorded slippageBps (mid × qty vs executed notional). */
export function slippageUsdFor(fill: Pick<LotFillInput, "side" | "notionalUsd" | "slippageBps">): string {
  const s = d(fill.slippageBps).div(10000);
  const notional = d(fill.notionalUsd);
  // BUY price = mid × (1 + s); SELL price = mid × (1 − s).
  const factor = fill.side === "BUY" ? new Decimal(1).plus(s) : new Decimal(1).minus(s);
  if (factor.lte(0)) return usd(notional);
  return usd(fill.side === "BUY" ? notional.mul(s).div(factor) : notional.mul(s).div(factor));
}

export function compareFills(left: Pick<LotFillInput, "createdAt" | "id">, right: Pick<LotFillInput, "createdAt" | "id">): number {
  const byTime = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (byTime !== 0) return byTime;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

type AllocationState = { qty: Decimal; avg: Decimal; known: boolean };
type LotInstanceAcc = {
  bought: Decimal;
  sold: Decimal;
  fees: Decimal;
  realized: Decimal;
  allocationRealized: Decimal;
  allocationKnown: boolean;
};

type Building = {
  lot: Omit<Lot, "instances" | "flags" | "holdingSeconds" | "holdingBasis" | "boughtQty" | "soldQty" | "openQty" | "entryPriceUsd" | "avgEntryPriceUsd" | "avgCostUsd" | "avgExitPriceUsd" | "entryNotionalUsd" | "exitNotionalUsd" | "feesUsd" | "slippageUsd" | "realizedPnlUsd">;
  flags: Set<LotFlag>;
  instances: Map<string, LotInstanceAcc>;
  bought: Decimal;
  sold: Decimal;
  entryNotional: Decimal;
  exitNotional: Decimal;
  fees: Decimal;
  slippage: Decimal;
  realized: Decimal;
};

function instanceAcc(map: Map<string, LotInstanceAcc>, id: string): LotInstanceAcc {
  let acc = map.get(id);
  if (!acc) {
    acc = { bought: ZERO, sold: ZERO, fees: ZERO, realized: ZERO, allocationRealized: ZERO, allocationKnown: true };
    map.set(id, acc);
  }
  return acc;
}

/** Same pro-rata split as the allocation settlement: floor to 8 dp, the last slice takes the remainder. */
export function proRataSlices(holders: Array<{ strategyInstanceId: string; qty: Decimal }>, fillQty: Decimal): Array<{ strategyInstanceId: string; qty: Decimal }> {
  const total = holders.reduce((sum, row) => sum.plus(row.qty), ZERO);
  if (total.lte(0) || fillQty.lte(0)) return [];
  const sorted = holders
    .filter((row) => row.qty.gt(0))
    .map((row) => ({ strategyInstanceId: row.strategyInstanceId, held: row.qty, share: row.qty.mul(fillQty).div(total) }))
    .sort((a, b) => b.held.cmp(a.held) || a.strategyInstanceId.localeCompare(b.strategyInstanceId));
  let assigned = ZERO;
  const slices = sorted.map((slice, index) => {
    if (index === sorted.length - 1) return { strategyInstanceId: slice.strategyInstanceId, qty: fillQty.minus(assigned) };
    const q = slice.share.toDecimalPlaces(8, Decimal.ROUND_DOWN);
    assigned = assigned.plus(q);
    return { strategyInstanceId: slice.strategyInstanceId, qty: q };
  });
  return slices.filter((slice) => slice.qty.gt(0));
}

/**
 * Split a sell fill across instance allocations, mirroring settleFillByOwnerScope. Returns the slices
 * and any quantity no allocation owns (attributed to UNRESOLVED_ATTRIBUTION_ID and flagged).
 */
function attributeSell(
  fill: LotFillInput,
  allocations: Map<string, AllocationState>,
): { slices: Array<{ strategyInstanceId: string; qty: Decimal }>; unresolved: Decimal } {
  const fillQty = d(fill.qty);
  const scope = fill.ownerScope ?? (fill.strategyInstanceId ? "STRATEGY" : "LEGACY");
  const distributes =
    scope === "NET_CLOSE" ||
    scope === "PROTECTION" ||
    scope === "ACCOUNT_FLATTEN" ||
    (scope === "OPERATOR" && !fill.strategyInstanceId) ||
    fill.intent === "FLATTEN";
  if (distributes) {
    const holders = [...allocations.entries()].map(([strategyInstanceId, state]) => ({ strategyInstanceId, qty: state.qty }));
    const slices = proRataSlices(holders, fillQty);
    if (slices.length === 0) return { slices: [], unresolved: fillQty };
    // forceNetClose: a slice larger than the holding sells only what is held.
    const capped = slices.map((slice) => {
      const held = allocations.get(slice.strategyInstanceId)?.qty ?? ZERO;
      return { strategyInstanceId: slice.strategyInstanceId, qty: slice.qty.gt(held) ? held : slice.qty };
    });
    const covered = capped.reduce((sum, slice) => sum.plus(slice.qty), ZERO);
    return { slices: capped, unresolved: fillQty.minus(covered) };
  }
  const owner = fill.strategyInstanceId;
  const held = owner ? (allocations.get(owner)?.qty ?? ZERO) : ZERO;
  if (!owner || held.lte(0)) return { slices: [], unresolved: fillQty };
  if (fillQty.lte(held)) return { slices: [{ strategyInstanceId: owner, qty: fillQty }], unresolved: ZERO };
  // Local path refuses an oversell entirely; a confirmed broker fill reduces what is held.
  if (fill.source === "BROKER") return { slices: [{ strategyInstanceId: owner, qty: held }], unresolved: fillQty.minus(held) };
  return { slices: [], unresolved: fillQty };
}

function buyOwner(fill: LotFillInput): { strategyInstanceId: string; known: boolean } {
  const scope = fill.ownerScope ?? (fill.strategyInstanceId ? "STRATEGY" : "LEGACY");
  if (scope === "STRATEGY" && fill.strategyInstanceId) return { strategyInstanceId: fill.strategyInstanceId, known: true };
  if (scope === "OPERATOR") return { strategyInstanceId: MANUAL_INSTANCE_ID, known: true };
  return { strategyInstanceId: UNATTRIBUTED_INSTANCE_ID, known: false };
}

function splitByQty(total: Decimal, slices: Array<{ qty: Decimal }>, fillQty: Decimal): Decimal[] {
  let left = total;
  return slices.map((slice, index) => {
    if (index === slices.length - 1) return left;
    const part = d(usd(total.mul(slice.qty).div(fillQty)));
    left = left.minus(part);
    return part;
  });
}

/**
 * Rebuild lots from fills (any order; sorted by fill time, then id). `asOf` is "now" for open lots.
 * Hints label lots with recorded lifecycle ids; boundaries never depend on them.
 */
export function reconstructLots(input: { fills: readonly LotFillInput[]; hints?: readonly LifecycleHint[]; asOf: string }): LotHistory {
  const groups = new Map<string, LotFillInput[]>();
  for (const fill of input.fills) {
    const key = `${fill.accountId}\u0000${fill.pairAddress}`;
    const list = groups.get(key) ?? [];
    list.push(fill);
    groups.set(key, list);
  }
  const lots: Lot[] = [];
  const orphanFills: OrphanFill[] = [];
  for (const fills of groups.values()) {
    const sorted = [...fills].sort(compareFills);
    let qtyHeld = ZERO;
    let avg = ZERO;
    let current: Building | null = null;
    const allocations = new Map<string, AllocationState>();
    const closed: Building[] = [];
    for (const fill of sorted) {
      const fillQty = d(fill.qty);
      const fee = d(fill.feeUsd);
      const notional = d(fill.notionalUsd);
      if (fill.side === "BUY") {
        const opening = qtyHeld.lte(0) || current === null;
        if (opening) {
          current = {
            lot: {
              lotKey: fill.id,
              identityMethod: "FILL_SEQUENCE",
              lifecycleId: null,
              lifecycleIdSource: null,
              boundaryMethod: "FILL_SEQUENCE",
              accountId: fill.accountId,
              pairAddress: fill.pairAddress,
              baseSymbol: fill.baseSymbol,
              status: "OPEN",
              openedAt: fill.createdAt,
              closedAt: null,
              entryFillId: fill.id,
              events: [],
            },
            flags: new Set(),
            instances: new Map(),
            bought: ZERO,
            sold: ZERO,
            entryNotional: ZERO,
            exitNotional: ZERO,
            fees: ZERO,
            slippage: ZERO,
            realized: ZERO,
          };
          qtyHeld = ZERO;
          avg = ZERO;
        }
        const lot = current!;
        const before = qtyHeld;
        const avgBefore = avg;
        const debit = notional.plus(fee);
        const nextQty = qtyHeld.plus(fillQty);
        avg = d(usd(qtyHeld.mul(avg).plus(debit).div(nextQty)));
        qtyHeld = nextQty;
        // Allocation mirror (applyAllocationFill BUY).
        const owner = buyOwner(fill);
        const state = allocations.get(owner.strategyInstanceId) ?? { qty: ZERO, avg: ZERO, known: owner.known };
        const known = state.qty.gt(0) ? state.known && owner.known : owner.known;
        const allocNext = state.qty.plus(fillQty);
        const allocAvg = !known ? ZERO : d(state.qty.mul(state.avg).plus(fillQty.mul(d(fill.priceUsd)).plus(fee)).div(allocNext).toFixed(8));
        allocations.set(owner.strategyInstanceId, { qty: allocNext, avg: allocAvg, known });
        const acc = instanceAcc(lot.instances, owner.strategyInstanceId);
        acc.bought = acc.bought.plus(fillQty);
        acc.fees = acc.fees.plus(fee);
        if (!known) {
          acc.allocationKnown = false;
          lot.flags.add("COST_BASIS_UNKNOWN");
        }
        if (!fill.feeKnown) lot.flags.add("FEE_UNKNOWN");
        const slip = d(slippageUsdFor(fill));
        lot.bought = lot.bought.plus(fillQty);
        lot.entryNotional = lot.entryNotional.plus(notional);
        lot.fees = lot.fees.plus(fee);
        lot.slippage = lot.slippage.plus(slip);
        lot.lot.events.push(event(fill, opening ? "ENTRY" : "ADD", before, qtyHeld, avgBefore, avg, null, [
          { strategyInstanceId: owner.strategyInstanceId, qty: usdQty(fillQty), realizedPnlUsd: null, feeUsd: usd(fee) },
        ]));
        continue;
      }
      // SELL
      if (current === null || qtyHeld.lte(0)) {
        orphanFills.push({ fill, reason: "SELL_WITHOUT_OPEN_LOT" });
        continue;
      }
      const lot: Building = current;
      const before = qtyHeld;
      const avgBefore = avg;
      if (fillQty.gt(qtyHeld)) lot.flags.add("SELL_EXCEEDS_RECONSTRUCTED_POSITION");
      const realized = d(usd(notional.minus(fee).minus(avg.mul(fillQty))));
      const nextQty = qtyHeld.minus(fillQty);
      const closing = nextQty.lte(0);
      qtyHeld = closing ? ZERO : nextQty;
      avg = closing ? ZERO : avg;
      // Attribution: ledger-basis realised split by quantity; allocation basis mirrors applyAllocationFill.
      const { slices, unresolved } = attributeSell(fill, allocations);
      const all = unresolved.gt(0) ? [...slices, { strategyInstanceId: UNRESOLVED_ATTRIBUTION_ID, qty: unresolved }] : slices;
      if (unresolved.gt(0)) lot.flags.add("ALLOCATION_SHORTFALL");
      const realizedParts = splitByQty(realized, all, fillQty);
      const feeParts = splitFee(fee, all, fillQty);
      const attribution: InstanceSlice[] = [];
      all.forEach((slice, index) => {
        const acc = instanceAcc(lot.instances, slice.strategyInstanceId);
        acc.sold = acc.sold.plus(slice.qty);
        acc.realized = acc.realized.plus(realizedParts[index]!);
        acc.fees = acc.fees.plus(feeParts[index]!);
        if (slice.strategyInstanceId === UNRESOLVED_ATTRIBUTION_ID) {
          acc.allocationKnown = false;
        } else {
          const state = allocations.get(slice.strategyInstanceId)!;
          if (state.known) {
            const allocRealized = slice.qty.mul(d(fill.priceUsd)).minus(slice.qty.mul(state.avg)).minus(feeParts[index]!);
            acc.allocationRealized = d(acc.allocationRealized.plus(allocRealized).toFixed(8));
          } else {
            acc.allocationKnown = false;
          }
          const left = state.qty.minus(slice.qty);
          allocations.set(slice.strategyInstanceId, { qty: left.gt(0) ? left : ZERO, avg: state.avg, known: state.known });
        }
        attribution.push({
          strategyInstanceId: slice.strategyInstanceId,
          qty: usdQty(slice.qty),
          realizedPnlUsd: usd(realizedParts[index]!),
          feeUsd: usd(feeParts[index]!),
        });
      });
      if (!fill.feeKnown) lot.flags.add("FEE_UNKNOWN");
      lot.sold = lot.sold.plus(fillQty);
      lot.exitNotional = lot.exitNotional.plus(notional);
      lot.fees = lot.fees.plus(fee);
      lot.slippage = lot.slippage.plus(d(slippageUsdFor(fill)));
      lot.realized = lot.realized.plus(realized);
      lot.lot.events.push(event(fill, closing ? "EXIT" : "REDUCE", before, qtyHeld, avgBefore, avg, usd(realized), attribution));
      if (closing) {
        lot.lot.status = "CLOSED";
        lot.lot.closedAt = fill.createdAt;
        const residual = [...allocations.values()].some((state) => state.qty.gt(0));
        if (residual) lot.flags.add("ALLOCATION_RESIDUAL_AT_CLOSE");
        closed.push(lot);
        current = null;
      }
    }
    if (current) closed.push(current);
    for (const building of closed) lots.push(finalise(building, input.asOf));
  }
  applyHints(lots, input.hints ?? []);
  lots.sort((left, right) => compareFills({ createdAt: left.openedAt, id: left.lotKey }, { createdAt: right.openedAt, id: right.lotKey }));
  return { version: LOT_HISTORY_VERSION, asOf: input.asOf, lots, orphanFills };
}

function splitFee(fee: Decimal, slices: Array<{ qty: Decimal }>, fillQty: Decimal): Decimal[] {
  let left = fee;
  return slices.map((slice, index) => {
    if (index === slices.length - 1) return left;
    const part = fee.mul(slice.qty).div(fillQty).toDecimalPlaces(8, Decimal.ROUND_DOWN);
    left = left.minus(part);
    return part;
  });
}

function usdQty(value: Decimal): string {
  return value.toDecimalPlaces(8, Decimal.ROUND_DOWN).toFixed(8);
}

function event(
  fill: LotFillInput,
  kind: LotEventKind,
  before: Decimal,
  after: Decimal,
  avgBefore: Decimal,
  avgAfter: Decimal,
  realizedPnlUsd: string | null,
  attribution: InstanceSlice[],
): LotEvent {
  return {
    fillId: fill.id,
    orderId: fill.orderId,
    at: fill.createdAt,
    kind,
    side: fill.side,
    qty: fill.qty,
    priceUsd: fill.priceUsd,
    notionalUsd: fill.notionalUsd,
    feeUsd: fill.feeUsd,
    feeKnown: fill.feeKnown,
    slippageBps: fill.slippageBps,
    slippageUsd: slippageUsdFor(fill),
    intent: fill.intent,
    ownerScope: fill.ownerScope,
    reasonCodes: [...fill.reasonCodes],
    exitReason: fill.side === "SELL" ? exitReasonFor(fill) : null,
    strategyInstanceId: fill.strategyInstanceId,
    strategyVersion: fill.strategyVersion,
    cycleId: fill.cycleId,
    positionQtyBefore: usdQty(before),
    positionQtyAfter: usdQty(after),
    avgCostBeforeUsd: usd(avgBefore),
    avgCostAfterUsd: usd(avgAfter),
    realizedPnlUsd,
    attribution,
  };
}

function finalise(building: Building, asOf: string): Lot {
  const lot = building.lot;
  const end = lot.closedAt ?? asOf;
  const last = lot.events.at(-1)!;
  const instances: LotInstanceAttribution[] = [...building.instances.entries()]
    .map(([strategyInstanceId, acc]) => ({
      strategyInstanceId,
      boughtQty: usdQty(acc.bought),
      soldQty: usdQty(acc.sold),
      feesUsd: usd(acc.fees),
      realizedPnlUsd: usd(acc.realized),
      allocationBasisRealizedPnlUsd: acc.allocationKnown ? usd(acc.allocationRealized) : null,
    }))
    .sort((left, right) => left.strategyInstanceId.localeCompare(right.strategyInstanceId));
  return {
    ...lot,
    holdingSeconds: Math.max(0, Math.round((Date.parse(end) - Date.parse(lot.openedAt)) / 1000)),
    holdingBasis: lot.closedAt ? "OPEN_TO_CLOSE" : "OPEN_TO_ASOF",
    boughtQty: usdQty(building.bought),
    soldQty: usdQty(building.sold),
    openQty: last.positionQtyAfter,
    entryPriceUsd: lot.events[0]!.priceUsd,
    avgEntryPriceUsd: building.bought.gt(0) ? usd(building.entryNotional.div(building.bought)) : usd(ZERO),
    avgCostUsd: last.avgCostAfterUsd,
    avgExitPriceUsd: building.sold.gt(0) ? usd(building.exitNotional.div(building.sold)) : null,
    entryNotionalUsd: usd(building.entryNotional),
    exitNotionalUsd: usd(building.exitNotional),
    feesUsd: usd(building.fees),
    slippageUsd: usd(building.slippage),
    realizedPnlUsd: usd(building.realized),
    instances,
    flags: [...building.flags].sort(),
  };
}

const HINT_PRIORITY: Record<LifecycleIdSource, number> = { TRADE_LOT_SNAPSHOT: 0, POSITION: 1, PROTECTION_ORDER: 2 };

function applyHints(lots: Lot[], hints: readonly LifecycleHint[]): void {
  const candidates = new Map<Lot, Array<{ lifecycleId: string; source: LifecycleIdSource }>>();
  const add = (lot: Lot, lifecycleId: string, source: LifecycleIdSource) => {
    const list = candidates.get(lot) ?? [];
    list.push({ lifecycleId, source });
    candidates.set(lot, list);
  };
  for (const hint of hints) {
    const scoped = lots.filter((lot) => lot.accountId === hint.accountId && lot.pairAddress === hint.pairAddress);
    if (hint.source === "TRADE_LOT_SNAPSHOT") {
      const lot = scoped.find((item) => item.entryFillId === hint.entryFillId);
      if (lot) add(lot, hint.lifecycleId, hint.source);
    } else if (hint.source === "POSITION") {
      const open = scoped.filter((item) => item.status === "OPEN");
      if (open.length === 1) add(open[0]!, hint.lifecycleId, hint.source);
    } else {
      const at = Date.parse(hint.at);
      const lot = scoped.find((item) => Date.parse(item.openedAt) <= at && (item.closedAt === null || at <= Date.parse(item.closedAt)));
      if (lot) add(lot, hint.lifecycleId, hint.source);
    }
  }
  const owners = new Map<string, Set<Lot>>();
  for (const [lot, list] of candidates) {
    list.sort((left, right) => HINT_PRIORITY[left.source] - HINT_PRIORITY[right.source]);
    const chosen = list[0]!;
    lot.lifecycleId = chosen.lifecycleId;
    lot.lifecycleIdSource = chosen.source;
    lot.identityMethod = "LIFECYCLE_ID";
    if (new Set(list.map((item) => item.lifecycleId)).size > 1) lot.flags = [...new Set([...lot.flags, "LIFECYCLE_ID_CONFLICT" as const])].sort();
    for (const item of list) {
      const set = owners.get(item.lifecycleId) ?? new Set<Lot>();
      set.add(lot);
      owners.set(item.lifecycleId, set);
    }
  }
  for (const set of owners.values()) {
    if (set.size < 2) continue;
    for (const lot of set) lot.flags = [...new Set([...lot.flags, "LIFECYCLE_ID_SPANS_LOTS" as const])].sort();
  }
}

export type MarkObservation = { pairAddress: string; receivedAt: string; priceUsd: string | null };

export type LotExcursion = {
  windowStart: string;
  windowEnd: string;
  /** True for an OPEN lot, whose window ends at asOf. */
  windowEndIsAsOf: boolean;
  observations: number;
  referencePriceUsd: string;
  highUsd: string | null;
  lowUsd: string | null;
  /** (high / entry fill price − 1) × 100; null when no mark falls in the window. */
  mfePct: string | null;
  /** (low / entry fill price − 1) × 100; null when no mark falls in the window. */
  maePct: string | null;
};

/**
 * Max favourable / adverse excursion from marks received inside [openedAt, closedAt] (open lots: asOf),
 * both ends inclusive, measured against the entry fill price. Marks outside the window, for another pair,
 * or without a positive price are ignored. No marks → nulls.
 */
export function lotExcursion(
  lot: Pick<Lot, "pairAddress" | "openedAt" | "closedAt"> & { referencePriceUsd: string },
  observations: readonly MarkObservation[],
  asOf: string,
): LotExcursion {
  const start = Date.parse(lot.openedAt);
  const endIso = lot.closedAt ?? asOf;
  const end = Date.parse(endIso);
  const reference = d(lot.referencePriceUsd);
  let hi: Decimal | null = null;
  let lo: Decimal | null = null;
  let count = 0;
  for (const row of observations) {
    if (row.pairAddress !== lot.pairAddress || row.priceUsd === null) continue;
    const at = Date.parse(row.receivedAt);
    if (!(at >= start && at <= end)) continue;
    const price = d(row.priceUsd);
    if (price.lte(0)) continue;
    count += 1;
    hi = hi === null || price.gt(hi) ? price : hi;
    lo = lo === null || price.lt(lo) ? price : lo;
  }
  const pct = (value: Decimal | null) => (value === null || reference.lte(0) ? null : value.div(reference).minus(1).mul(100).toDecimalPlaces(4).toFixed(4));
  return {
    windowStart: lot.openedAt,
    windowEnd: endIso,
    windowEndIsAsOf: lot.closedAt === null,
    observations: count,
    referencePriceUsd: usd(reference),
    highUsd: hi === null ? null : usd(hi),
    lowUsd: lo === null ? null : usd(lo),
    mfePct: pct(hi),
    maePct: pct(lo),
  };
}

export type LotMark = {
  markUsd: string | null;
  markAt: string | null;
  /** Open quantity × (mark − average cost incl. fees); null without a mark or for a closed lot. */
  unrealizedPnlUsd: string | null;
};

/** Valuation of an open lot. A missing mark is null, never zero. */
export function lotMark(lot: Pick<Lot, "status" | "openQty" | "avgCostUsd">, mark: { priceUsd: string | null; receivedAt: string } | null): LotMark {
  if (lot.status !== "OPEN") return { markUsd: null, markAt: null, unrealizedPnlUsd: null };
  if (!mark || mark.priceUsd === null || d(mark.priceUsd).lte(0)) return { markUsd: null, markAt: mark?.receivedAt ?? null, unrealizedPnlUsd: null };
  const price = d(mark.priceUsd);
  return {
    markUsd: usd(price),
    markAt: mark.receivedAt,
    unrealizedPnlUsd: usd(d(lot.openQty).mul(price.minus(d(lot.avgCostUsd)))),
  };
}

// ---------------------------------------------------------------------------------------------------
// Reconciliation against the ledger

export type LedgerRowInput = {
  id: string;
  accountId: string;
  type: string;
  amountUsd: string;
  fillId: string | null;
  orderId: string | null;
};

export type UnreconciledItem = {
  kind:
    | "LEDGER_ROW_WITHOUT_FILL"
    | "FILL_WITHOUT_LEDGER_ROW"
    | "FILL_AMOUNT_MISMATCH"
    | "ORPHAN_FILL"
    | "DUPLICATE_LEDGER_ROWS"
    | "POSITION_QTY_MISMATCH";
  type: "REALIZED_PNL" | "FEE" | "POSITION";
  fillId: string | null;
  ledgerEntryIds: string[];
  pairAddress: string | null;
  expected: string | null;
  recorded: string | null;
  difference: string;
};

export type AllocationCheck = {
  strategyInstanceId: string;
  pairAddress: string;
  status: "MATCH" | "MISMATCH" | "NOT_COMPARABLE";
  reconstructedQty: string;
  storedQty: string;
  reconstructedRealizedPnlUsd: string | null;
  storedRealizedPnlUsd: string;
  reconstructedFeesUsd: string;
  storedFeesUsd: string;
};

export type LedgerReconciliation = {
  accountId: string;
  /** PNL_FEES_RECONCILED covers realised P&L, fees and positions only; cash lines are not checked. */
  status: "PNL_FEES_RECONCILED" | "UNRECONCILED";
  tolerance: string;
  realizedPnl: { ledgerTotalUsd: string; lotsTotalUsd: string; unreconciledUsd: string; withinTolerance: boolean };
  fees: { ledgerTotalUsd: string; fillsTotalUsd: string; unreconciledUsd: string; withinTolerance: boolean };
  items: UnreconciledItem[];
  /** StrategyAllocation comparison (attribution caveat; does not change the ledger status). */
  allocationStatus: "MATCH" | "MISMATCH" | "NOT_CHECKED";
  allocations: AllocationCheck[];
};

export const RECONCILIATION_TOLERANCE = "0.00000001";

/**
 * Compare reconstructed lots with the ledger. The sum of lot realised P&L must equal the REALIZED_PNL
 * total and fill fees must equal the FEE rows, within 1e-8, with every row linked to a known fill. Any
 * difference, unlinked row, orphan fill or position mismatch is itemised and makes the result UNRECONCILED.
 * Cash lines (FILL_DEBIT / FILL_CREDIT against PaperAccount.cashUsd) are not part of this check, hence
 * the status name PNL_FEES_RECONCILED.
 */
export function reconcileLotsWithLedger(input: {
  accountId: string;
  history: LotHistory;
  ledger: readonly LedgerRowInput[];
  positions?: ReadonlyArray<{ pairAddress: string; baseQty: string }>;
  allocations?: ReadonlyArray<{ strategyInstanceId: string; pairAddress: string; qty: string; realizedPnlUsd: string; feesUsd: string; costBasisKnown: boolean }>;
}): LedgerReconciliation {
  const tolerance = d(RECONCILIATION_TOLERANCE);
  const lots = input.history.lots.filter((lot) => lot.accountId === input.accountId);
  const orphans = input.history.orphanFills.filter((orphan) => orphan.fill.accountId === input.accountId);
  const items: UnreconciledItem[] = [];

  type Expect = { fillId: string; pairAddress: string; realized: string | null; fee: string };
  const expected = new Map<string, Expect>();
  for (const lot of lots) {
    for (const item of lot.events) expected.set(item.fillId, { fillId: item.fillId, pairAddress: lot.pairAddress, realized: item.realizedPnlUsd, fee: item.feeUsd });
  }
  const orphanIds = new Set<string>();
  for (const orphan of orphans) {
    orphanIds.add(orphan.fill.id);
    items.push({
      kind: "ORPHAN_FILL",
      type: "REALIZED_PNL",
      fillId: orphan.fill.id,
      ledgerEntryIds: [],
      pairAddress: orphan.fill.pairAddress,
      expected: null,
      recorded: null,
      difference: "0.00000000",
    });
  }

  const ledger = input.ledger.filter((row) => row.accountId === input.accountId && (row.type === "REALIZED_PNL" || row.type === "FEE"));
  const byFill = new Map<string, { realized: LedgerRowInput[]; fee: LedgerRowInput[] }>();
  let ledgerRealized = ZERO;
  let ledgerFees = ZERO;
  for (const row of ledger) {
    if (row.type === "REALIZED_PNL") ledgerRealized = ledgerRealized.plus(d(row.amountUsd));
    else ledgerFees = ledgerFees.plus(d(row.amountUsd).neg());
    if (!row.fillId || (!expected.has(row.fillId) && !orphanIds.has(row.fillId))) {
      items.push({
        kind: "LEDGER_ROW_WITHOUT_FILL",
        type: row.type as "REALIZED_PNL" | "FEE",
        fillId: row.fillId,
        ledgerEntryIds: [row.id],
        pairAddress: null,
        expected: null,
        recorded: usd(d(row.amountUsd)),
        difference: usd(d(row.amountUsd)),
      });
      continue;
    }
    const bucket = byFill.get(row.fillId) ?? { realized: [], fee: [] };
    if (row.type === "REALIZED_PNL") bucket.realized.push(row);
    else bucket.fee.push(row);
    byFill.set(row.fillId, bucket);
  }

  let lotsRealized = ZERO;
  let fillFees = ZERO;
  for (const lot of lots) lotsRealized = lotsRealized.plus(d(lot.realizedPnlUsd));
  for (const exp of expected.values()) fillFees = fillFees.plus(d(exp.fee));
  for (const orphan of orphans) fillFees = fillFees.plus(d(orphan.fill.feeUsd));

  const compare = (fillId: string, pairAddress: string, type: "REALIZED_PNL" | "FEE", want: Decimal | null, rows: LedgerRowInput[]) => {
    if (rows.length > 1) {
      items.push({
        kind: "DUPLICATE_LEDGER_ROWS",
        type,
        fillId,
        ledgerEntryIds: rows.map((row) => row.id),
        pairAddress,
        expected: want === null ? null : usd(want),
        recorded: usd(rows.reduce((sum, row) => sum.plus(d(row.amountUsd)), ZERO)),
        difference: usd(rows.reduce((sum, row) => sum.plus(d(row.amountUsd)), ZERO).minus(want ?? ZERO)),
      });
      return;
    }
    if (want === null) return; // orphan fills are already itemised; their rows count in the ledger total
    const row = rows[0];
    if (!row) {
      items.push({ kind: "FILL_WITHOUT_LEDGER_ROW", type, fillId, ledgerEntryIds: [], pairAddress, expected: usd(want), recorded: null, difference: usd(want.neg()) });
      return;
    }
    const diff = d(row.amountUsd).minus(want);
    if (diff.abs().gt(tolerance)) {
      items.push({ kind: "FILL_AMOUNT_MISMATCH", type, fillId, ledgerEntryIds: [row.id], pairAddress, expected: usd(want), recorded: usd(d(row.amountUsd)), difference: usd(diff) });
    }
  };
  for (const exp of expected.values()) {
    const rows = byFill.get(exp.fillId) ?? { realized: [], fee: [] };
    compare(exp.fillId, exp.pairAddress, "REALIZED_PNL", exp.realized === null ? null : d(exp.realized), rows.realized);
    if (exp.realized === null && rows.realized.length > 0) {
      // A BUY fill must not carry a realised P&L row.
      items.push({
        kind: "FILL_AMOUNT_MISMATCH",
        type: "REALIZED_PNL",
        fillId: exp.fillId,
        ledgerEntryIds: rows.realized.map((row) => row.id),
        pairAddress: exp.pairAddress,
        expected: null,
        recorded: usd(rows.realized.reduce((sum, row) => sum.plus(d(row.amountUsd)), ZERO)),
        difference: usd(rows.realized.reduce((sum, row) => sum.plus(d(row.amountUsd)), ZERO)),
      });
    }
    compare(exp.fillId, exp.pairAddress, "FEE", d(exp.fee).neg(), rows.fee);
  }
  for (const orphan of orphans) {
    const rows = byFill.get(orphan.fill.id) ?? { realized: [], fee: [] };
    compare(orphan.fill.id, orphan.fill.pairAddress, "FEE", d(orphan.fill.feeUsd).neg(), rows.fee);
  }

  if (input.positions) {
    const open = new Map<string, Decimal>();
    for (const lot of lots) if (lot.status === "OPEN") open.set(lot.pairAddress, d(lot.openQty));
    const pairs = new Set([...open.keys(), ...input.positions.map((row) => row.pairAddress)]);
    for (const pairAddress of pairs) {
      const recorded = d(input.positions.find((row) => row.pairAddress === pairAddress)?.baseQty ?? "0");
      const want = open.get(pairAddress) ?? ZERO;
      const diff = recorded.minus(want);
      if (diff.abs().gt(tolerance)) {
        items.push({ kind: "POSITION_QTY_MISMATCH", type: "POSITION", fillId: null, ledgerEntryIds: [], pairAddress, expected: usdQty(want), recorded: recorded.toFixed(8), difference: diff.toFixed(8) });
      }
    }
  }

  const realizedDiff = ledgerRealized.minus(lotsRealized);
  const feeDiff = ledgerFees.minus(fillFees);
  const realizedOk = realizedDiff.abs().lte(tolerance);
  const feesOk = feeDiff.abs().lte(tolerance);

  const allocations = input.allocations ? checkAllocations(lots, input.allocations, tolerance) : [];
  return {
    accountId: input.accountId,
    status: realizedOk && feesOk && items.length === 0 ? "PNL_FEES_RECONCILED" : "UNRECONCILED",
    tolerance: RECONCILIATION_TOLERANCE,
    realizedPnl: { ledgerTotalUsd: usd(ledgerRealized), lotsTotalUsd: usd(lotsRealized), unreconciledUsd: usd(realizedDiff), withinTolerance: realizedOk },
    fees: { ledgerTotalUsd: usd(ledgerFees), fillsTotalUsd: usd(fillFees), unreconciledUsd: usd(feeDiff), withinTolerance: feesOk },
    items,
    allocationStatus: !input.allocations ? "NOT_CHECKED" : allocations.every((row) => row.status !== "MISMATCH") ? "MATCH" : "MISMATCH",
    allocations,
  };
}

function checkAllocations(
  lots: readonly Lot[],
  stored: ReadonlyArray<{ strategyInstanceId: string; pairAddress: string; qty: string; realizedPnlUsd: string; feesUsd: string; costBasisKnown: boolean }>,
  tolerance: Decimal,
): AllocationCheck[] {
  type Acc = { qty: Decimal; realized: Decimal; known: boolean; fees: Decimal };
  const acc = new Map<string, Acc>();
  for (const lot of lots) {
    for (const row of lot.instances) {
      if (row.strategyInstanceId === UNRESOLVED_ATTRIBUTION_ID) continue;
      const key = `${row.strategyInstanceId}\u0000${lot.pairAddress}`;
      const cur = acc.get(key) ?? { qty: ZERO, realized: ZERO, known: true, fees: ZERO };
      cur.qty = cur.qty.plus(d(row.boughtQty)).minus(d(row.soldQty));
      cur.fees = cur.fees.plus(d(row.feesUsd));
      if (row.allocationBasisRealizedPnlUsd === null) cur.known = false;
      else cur.realized = cur.realized.plus(d(row.allocationBasisRealizedPnlUsd));
      acc.set(key, cur);
    }
  }
  const keys = new Set([...acc.keys(), ...stored.map((row) => `${row.strategyInstanceId}\u0000${row.pairAddress}`)]);
  const out: AllocationCheck[] = [];
  for (const key of [...keys].sort()) {
    const [strategyInstanceId, pairAddress] = key.split("\u0000") as [string, string];
    const mine = acc.get(key) ?? { qty: ZERO, realized: ZERO, known: true, fees: ZERO };
    const row = stored.find((item) => item.strategyInstanceId === strategyInstanceId && item.pairAddress === pairAddress);
    const storedQty = d(row?.qty ?? "0");
    const storedRealized = d(row?.realizedPnlUsd ?? "0");
    const storedFees = d(row?.feesUsd ?? "0");
    const comparable = mine.known && (row?.costBasisKnown ?? true);
    const qtyOk = storedQty.minus(mine.qty).abs().lte(tolerance);
    const feesOk = storedFees.minus(mine.fees).abs().lte(tolerance);
    const realizedOk = storedRealized.minus(mine.realized).abs().lte(tolerance);
    out.push({
      strategyInstanceId,
      pairAddress,
      status: !qtyOk || !feesOk ? "MISMATCH" : !comparable ? "NOT_COMPARABLE" : realizedOk ? "MATCH" : "MISMATCH",
      reconstructedQty: usdQty(mine.qty),
      storedQty: storedQty.toFixed(8),
      reconstructedRealizedPnlUsd: mine.known ? usd(mine.realized) : null,
      storedRealizedPnlUsd: usd(storedRealized),
      reconstructedFeesUsd: usd(mine.fees),
      storedFeesUsd: usd(storedFees),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Attribution summary

export type InstanceLotSummary = {
  strategyInstanceId: string;
  lots: number;
  closedLots: number;
  wins: number;
  losses: number;
  realizedPnlUsd: string;
  feesUsd: string;
  allocationBasisRealizedPnlUsd: string | null;
};

export type LotAttributionSummary = {
  instances: InstanceLotSummary[];
  totals: { lots: number; openLots: number; closedLots: number; realizedPnlUsd: string; feesUsd: string };
  /** Sum over instances (including UNRESOLVED) equals the lot totals exactly. */
  instancesSumToLots: boolean;
};

/** Per-instance totals across lots. Wins/losses count closed lots where the instance's share was ±. */
export function summariseLotAttribution(lots: readonly Lot[]): LotAttributionSummary {
  const map = new Map<string, { lots: number; closed: number; wins: number; losses: number; realized: Decimal; fees: Decimal; alloc: Decimal; allocKnown: boolean }>();
  let realized = ZERO;
  let fees = ZERO;
  for (const lot of lots) {
    realized = realized.plus(d(lot.realizedPnlUsd));
    fees = fees.plus(d(lot.feesUsd));
    for (const row of lot.instances) {
      const cur = map.get(row.strategyInstanceId) ?? { lots: 0, closed: 0, wins: 0, losses: 0, realized: ZERO, fees: ZERO, alloc: ZERO, allocKnown: true };
      cur.lots += 1;
      cur.realized = cur.realized.plus(d(row.realizedPnlUsd));
      cur.fees = cur.fees.plus(d(row.feesUsd));
      if (row.allocationBasisRealizedPnlUsd === null) cur.allocKnown = false;
      else cur.alloc = cur.alloc.plus(d(row.allocationBasisRealizedPnlUsd));
      if (lot.status === "CLOSED") {
        cur.closed += 1;
        if (d(row.realizedPnlUsd).gt(0)) cur.wins += 1;
        else if (d(row.realizedPnlUsd).lt(0)) cur.losses += 1;
      }
      map.set(row.strategyInstanceId, cur);
    }
  }
  const instances = [...map.entries()]
    .map(([strategyInstanceId, cur]) => ({
      strategyInstanceId,
      lots: cur.lots,
      closedLots: cur.closed,
      wins: cur.wins,
      losses: cur.losses,
      realizedPnlUsd: usd(cur.realized),
      feesUsd: usd(cur.fees),
      allocationBasisRealizedPnlUsd: cur.allocKnown ? usd(cur.alloc) : null,
    }))
    .sort((left, right) => left.strategyInstanceId.localeCompare(right.strategyInstanceId));
  const instRealized = instances.reduce((sum, row) => sum.plus(d(row.realizedPnlUsd)), ZERO);
  const instFees = instances.reduce((sum, row) => sum.plus(d(row.feesUsd)), ZERO);
  return {
    instances,
    totals: {
      lots: lots.length,
      openLots: lots.filter((lot) => lot.status === "OPEN").length,
      closedLots: lots.filter((lot) => lot.status === "CLOSED").length,
      realizedPnlUsd: usd(realized),
      feesUsd: usd(fees),
    },
    instancesSumToLots: instRealized.eq(realized) && instFees.eq(fees),
  };
}
