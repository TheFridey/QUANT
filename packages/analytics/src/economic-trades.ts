import { Decimal } from "@odin/shared";

/**
 * OPERATION INTEGRITY F11: economic trades versus fill chunks.
 *
 * The trading engine writes one REALIZED_PNL ledger entry per SELL fill. An exit that exceeds the exit-impact cap
 * is split: the unfilled part becomes a PENDING remainder order whose clientOrderId is the parent's plus
 * `:remN` (`packages/trading-engine/src/store.ts`, `bookExitRemainder`), possibly repeatedly (`X:rem1:rem1`).
 * Counting every entry as a closed trade inflates trade counts and distorts win rate, averages and expectancy.
 *
 * Economic exit identity: the ROOT exit order of a remainder chain, i.e. the clientOrderId with every trailing
 * `:remN` removed. One root = one decision to exit = one economic trade, whatever the number of fills. Distinct
 * root orders are distinct economic exits even on the same position (scale-outs, a stop then a later exit, a
 * flatten), so economically distinct trades are never merged by instrument or position. A realised entry whose
 * order is unknown (no orderId, or the order row is missing: historical lineage) is its own trade and is
 * counted separately, so incomplete lineage is visible instead of silently guessed.
 *
 * P&L, fees and cash are not touched: groups sum their entries exactly (Decimal), so the total realised P&L over
 * economic trades equals the total over entries.
 */
export type RealizedEntryInput = { id: string; amountUsd: string; orderId: string | null };
export type EconomicExit = { key: string; pnlUsd: string; chunks: number; linked: boolean };
export type EconomicTradeSummary = {
  trades: EconomicExit[];
  /** Ledger entries (fill chunks) the trades were built from. */
  chunks: number;
  economicTrades: number;
  /** Entries with no resolvable exit order: each counted as its own trade. */
  unlinkedEntries: number;
  /** Sum over entries; equals the sum over trades. */
  totalRealizedUsd: string;
};

const REMAINDER_SUFFIX = /(?::rem\d+)+$/;

export function exitRootKey(clientOrderId: string): string {
  return clientOrderId.replace(REMAINDER_SUFFIX, "");
}

/**
 * Groups realised entries into economic exits. `clientOrderIdByOrderId` maps Order.id → Order.clientOrderId.
 * Output order follows the first appearance of each exit in `entries` (callers pass newest first).
 */
export function economicExits(entries: readonly RealizedEntryInput[], clientOrderIdByOrderId: ReadonlyMap<string, string>): EconomicTradeSummary {
  const groups = new Map<string, { sum: Decimal; chunks: number; linked: boolean }>();
  let total = new Decimal(0);
  let unlinkedEntries = 0;
  for (const e of entries) {
    const amount = new Decimal(e.amountUsd);
    total = total.plus(amount);
    const coid = e.orderId === null ? undefined : clientOrderIdByOrderId.get(e.orderId);
    const linked = coid !== undefined;
    if (!linked) unlinkedEntries += 1;
    const key = linked ? `exit:${exitRootKey(coid)}` : `entry:${e.id}`;
    const g = groups.get(key);
    if (g) {
      g.sum = g.sum.plus(amount);
      g.chunks += 1;
    } else groups.set(key, { sum: amount, chunks: 1, linked });
  }
  const trades = [...groups.entries()].map(([key, g]) => ({ key, pnlUsd: g.sum.toFixed(8), chunks: g.chunks, linked: g.linked }));
  return { trades, chunks: entries.length, economicTrades: trades.length, unlinkedEntries, totalRealizedUsd: total.toFixed(8) };
}
