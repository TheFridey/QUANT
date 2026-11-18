import Decimal from "decimal.js";
import type { HistoricalBar } from "./integrity.js";

/**
 * CATALYST: deterministic aggregation of canonical lower-timeframe bars (OANDA M1, `price=MBA`) into a higher
 * timeframe. **Pure.** Exact decimal text in, exact decimal text out; the same input always gives the same bytes.
 *
 * Rules:
 * - A bucket is [anchor + k·target, anchor + (k+1)·target). `anchorMs` 0 gives the UTC grid; a 17:00 New York
 *   anchor gives NY-aligned buckets (pass it explicitly; DST is the caller's calendar's job).
 * - open = first member open, close = last member close, high = max, low = min; bid/ask OHLC likewise when
 *   *every* member carries them; otherwise the bucket's bid/ask are null (never partially filled in).
 * - tickVolume is summed only when every member reports it.
 * - availableAt = max(bucket end, every member's availableAt): an aggregate is never usable before its last
 *   member was, and never before the bucket closes.
 * - A bucket with fewer members than `expectedMembers` (from the caller's session calendar) is kept but flagged
 *   `complete: false` with the missing count. Nothing is fabricated for absent minutes.
 * - Input must be strictly increasing, aligned to the source interval, and valid OHLC; otherwise it is refused.
 *
 * Expected difference from native provider candles (to be measured, not assumed):
 * - Native OANDA candles omit intervals with no ticks, so a sum over present M1 bars should match native tick
 *   volume, and OHLC should match whenever no M1 inside the bucket was missing or incomplete.
 * - Differences arise from minutes dropped as incomplete at acquisition, daily alignment, and weekend stub bars.
 * - Native and aggregated datasets have distinct identities and must never be spliced.
 */

export type AggregatedBar = HistoricalBar & { members: number; expectedMembers: number | null; complete: boolean };

export type AggregateRefusal = "EMPTY" | "NOT_INCREASING" | "MISALIGNED" | "INVALID_OHLC" | "INVALID_INTERVAL";

const SIDES = ["bid", "ask"] as const;
const PARTS = ["o", "h", "l", "c"] as const;

function dec(v: string | number | null | undefined): Decimal | null {
  if (v === null || v === undefined || v === "") return null;
  try {
    const x = new Decimal(v);
    return x.isFinite() && x.gt(0) ? x : null;
  } catch {
    return null;
  }
}

function validOhlc(o: Decimal | null, h: Decimal | null, l: Decimal | null, c: Decimal | null): boolean {
  return !!o && !!h && !!l && !!c && h.gte(o) && h.gte(c) && h.gte(l) && l.lte(o) && l.lte(c);
}

export function aggregateBars(
  bars: readonly HistoricalBar[],
  opts: { sourceMs: number; targetMs: number; anchorMs?: number; expectedMembers?: (bucketStartMs: number) => number | null },
): { ok: true; bars: AggregatedBar[] } | { ok: false; reason: AggregateRefusal; index?: number } {
  const { sourceMs, targetMs } = opts;
  const anchor = opts.anchorMs ?? 0;
  if (!(sourceMs > 0) || !(targetMs > sourceMs) || targetMs % sourceMs !== 0) return { ok: false, reason: "INVALID_INTERVAL" };
  if (bars.length === 0) return { ok: false, reason: "EMPTY" };
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (i > 0 && !(b.openTime > bars[i - 1]!.openTime)) return { ok: false, reason: "NOT_INCREASING", index: i };
    if ((((b.openTime - anchor) % sourceMs) + sourceMs) % sourceMs !== 0) return { ok: false, reason: "MISALIGNED", index: i };
    if (!validOhlc(dec(b.open), dec(b.high), dec(b.low), dec(b.close))) return { ok: false, reason: "INVALID_OHLC", index: i };
  }
  const out: AggregatedBar[] = [];
  let i = 0;
  while (i < bars.length) {
    const start = anchor + Math.floor((bars[i]!.openTime - anchor) / targetMs) * targetMs;
    const end = start + targetMs;
    const members: HistoricalBar[] = [];
    while (i < bars.length && bars[i]!.openTime < end) members.push(bars[i++]!);
    const first = members[0]!;
    const last = members[members.length - 1]!;
    const highs = members.map((m) => dec(m.high)!);
    const lows = members.map((m) => dec(m.low)!);
    const extra: Record<string, string | number | null> = { aggregatedFromMs: sourceMs, priceComponents: first.extra?.priceComponents ?? null };
    for (const side of SIDES) {
      const vals = members.map((m) => PARTS.map((p) => dec(m.extra?.[`${side}_${p}`] as string | null)));
      const allPresent = vals.every((v) => validOhlc(v[0]!, v[1]!, v[2]!, v[3]!));
      extra[`${side}_o`] = allPresent ? String(first.extra![`${side}_o`]) : null;
      extra[`${side}_c`] = allPresent ? String(last.extra![`${side}_c`]) : null;
      extra[`${side}_h`] = allPresent ? Decimal.max(...vals.map((v) => v[1]!)).toFixed() : null;
      extra[`${side}_l`] = allPresent ? Decimal.min(...vals.map((v) => v[2]!)).toFixed() : null;
    }
    const bidC = dec(extra.bid_c as string | null);
    const askC = dec(extra.ask_c as string | null);
    extra.spread_c = bidC && askC ? askC.minus(bidC).toFixed() : null;
    const ticks = members.map((m) => m.extra?.tickVolume);
    extra.tickVolume = ticks.every((t) => typeof t === "number" && Number.isFinite(t)) ? (ticks as number[]).reduce((a, b) => a + b, 0) : null;
    const expected = opts.expectedMembers ? opts.expectedMembers(start) : null;
    out.push({
      openTime: start,
      availableAt: Math.max(end, ...members.map((m) => m.availableAt)),
      open: first.open,
      high: Decimal.max(...highs).toFixed(),
      low: Decimal.min(...lows).toFixed(),
      close: last.close,
      volume: members.every((m) => m.volume !== null) ? members.reduce((s, m) => s.plus(m.volume!), new Decimal(0)).toFixed() : null,
      extra,
      members: members.length,
      expectedMembers: expected,
      complete: expected === null ? false : members.length >= expected,
    });
  }
  return { ok: true, bars: out };
}
