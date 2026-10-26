import { d, qty, usd, type OrderSide, type ReasonCode } from "@odin/shared";
import type { FillQuote } from "./fill.js";

export type BookPosition = {
  pairAddress: string;
  baseSymbol: string;
  baseQty: string;
  avgCostUsd: string;
  realizedPnlUsd: string;
};

export type BookState = {
  cashUsd: string;
  positions: BookPosition[];
};

export type LedgerLine = {
  type: "FILL_DEBIT" | "FILL_CREDIT" | "FEE" | "REALIZED_PNL";
  amountUsd: string;
  affectsCash: boolean;
  note: string;
};

export function applyFill(
  state: BookState,
  input: { pairAddress: string; baseSymbol: string; side: OrderSide; fill: FillQuote },
): { ok: true; state: BookState; lines: LedgerLine[]; realizedPnlUsd: string } | { ok: false; reason: ReasonCode } {
  const current = state.positions.find((position) => position.pairAddress === input.pairAddress) ?? {
    pairAddress: input.pairAddress,
    baseSymbol: input.baseSymbol,
    baseQty: "0.00000000",
    avgCostUsd: "0.00000000",
    realizedPnlUsd: "0.00000000",
  };
  if (input.side === "BUY") return buy(state, current, input.fill, input.baseSymbol);
  return sell(state, current, input.fill);
}

function buy(
  state: BookState,
  current: BookPosition,
  fill: FillQuote,
  baseSymbol: string,
): { ok: true; state: BookState; lines: LedgerLine[]; realizedPnlUsd: string } | { ok: false; reason: ReasonCode } {
  const debit = d(fill.notionalUsd).plus(d(fill.feeUsd));
  const cash = d(state.cashUsd).minus(debit);
  if (cash.lt(0)) return { ok: false, reason: "INSUFFICIENT_CASH" };
  const nextQty = d(current.baseQty).plus(d(fill.qty));
  const cost = d(current.baseQty).mul(d(current.avgCostUsd)).plus(debit);
  const next: BookPosition = {
    pairAddress: current.pairAddress,
    baseSymbol,
    baseQty: qty(nextQty),
    avgCostUsd: usd(cost.div(nextQty)),
    realizedPnlUsd: current.realizedPnlUsd,
  };
  return {
    ok: true,
    realizedPnlUsd: "0.00000000",
    lines: [
      { type: "FILL_DEBIT", amountUsd: usd(d(fill.notionalUsd).neg()), affectsCash: true, note: "Paper buy notional" },
      { type: "FEE", amountUsd: usd(d(fill.feeUsd).neg()), affectsCash: true, note: "Paper buy fee" },
    ],
    state: { cashUsd: usd(cash), positions: replace(state.positions, next) },
  };
}

function sell(
  state: BookState,
  current: BookPosition,
  fill: FillQuote,
): { ok: true; state: BookState; lines: LedgerLine[]; realizedPnlUsd: string } | { ok: false; reason: ReasonCode } {
  if (d(fill.qty).gt(d(current.baseQty))) return { ok: false, reason: "SELL_EXCEEDS_POSITION" };
  const proceeds = d(fill.notionalUsd).minus(d(fill.feeUsd));
  if (proceeds.lt(0)) return { ok: false, reason: "INSUFFICIENT_CASH" };
  const costRemoved = d(current.avgCostUsd).mul(d(fill.qty));
  const realized = proceeds.minus(costRemoved);
  const nextQty = d(current.baseQty).minus(d(fill.qty));
  const next: BookPosition = {
    ...current,
    baseQty: qty(nextQty),
    avgCostUsd: nextQty.eq(0) ? "0.00000000" : current.avgCostUsd,
    realizedPnlUsd: usd(d(current.realizedPnlUsd).plus(realized)),
  };
  return {
    ok: true,
    realizedPnlUsd: usd(realized),
    lines: [
      { type: "FILL_CREDIT", amountUsd: usd(d(fill.notionalUsd)), affectsCash: true, note: "Paper sell notional" },
      { type: "FEE", amountUsd: usd(d(fill.feeUsd).neg()), affectsCash: true, note: "Paper sell fee" },
      { type: "REALIZED_PNL", amountUsd: usd(realized), affectsCash: false, note: "Realized paper P&L" },
    ],
    state: { cashUsd: usd(d(state.cashUsd).plus(proceeds)), positions: replace(state.positions, next) },
  };
}

export function cashFromLines(openingUsd: string, lines: LedgerLine[]): string {
  return usd(
    lines.filter((line) => line.affectsCash).reduce((total, line) => total.plus(d(line.amountUsd)), d(openingUsd)),
  );
}

function replace(positions: BookPosition[], next: BookPosition): BookPosition[] {
  const others = positions.filter((position) => position.pairAddress !== next.pairAddress);
  return [...others, next];
}
