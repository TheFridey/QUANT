/**
 * GENESIS Phase 7 review fixes, without a database: the summary batches its mark lookups (a fixed number
 * of queries per pair group, not per lot), pages by closedAt, and reuses results within the TTL.
 */
import { reconstructLots, type LotFillInput } from "@odin/analytics";
import { d, usd } from "@odin/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FEEDBACK_SUMMARY_CACHE_TTL_MS, FEEDBACK_SUMMARY_MAX_LIMIT, FeedbackService } from "./feedback.service.js";
import type { TerminalService } from "./terminal.service.js";
import type { TradeLotsService } from "./trade-lots.service.js";

const ACCOUNT = "acct_fs";
const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString();
let seq = 0;
function fill(pair: string, side: "BUY" | "SELL", minute: number): LotFillInput {
  seq += 1;
  const notional = usd(d("10"));
  return {
    id: `f_${String(seq).padStart(4, "0")}`, orderId: `o_${seq}`, accountId: ACCOUNT, pairAddress: pair, baseSymbol: "X", side, qty: "10", priceUsd: "1",
    notionalUsd: notional, feeUsd: "0.03000000", feeKnown: true, slippageBps: "10", createdAt: at(minute), source: "LOCAL_SIM", strategyInstanceId: "inst",
    intent: side === "BUY" ? "ENTRY" : "EXIT", ownerScope: "STRATEGY", reasonCodes: [], strategyVersion: "v1", cycleId: `c_${seq}`, observationId: null,
  };
}

function setup() {
  // 30 closed lots on pair A, 30 on pair B. Lot opened at minute 0 on A closes last (minute 10_000).
  const fills: LotFillInput[] = [fill("pairA", "BUY", 0), fill("pairA", "SELL", 10_000)];
  for (let i = 1; i < 30; i += 1) fills.push(fill("pairA", "BUY", 10_000 + i * 10), fill("pairA", "SELL", 10_000 + i * 10 + 5));
  for (let i = 0; i < 30; i += 1) fills.push(fill("pairB", "BUY", i * 10), fill("pairB", "SELL", i * 10 + 5));
  const history = reconstructLots({ fills, asOf: at(20_000) });
  const counts = { load: 0, marks: 0, fills: 0, observationsById: 0, snapshots: 0 };
  const prisma = {
    tradeLotSnapshot: { findMany: vi.fn(async () => { counts.snapshots += 1; return []; }) },
    fill: { findMany: vi.fn(async () => { counts.fills += 1; return []; }) },
    marketObservation: {
      findMany: vi.fn(async (args: { where: { id?: unknown } }) => {
        if (args.where.id) counts.observationsById += 1;
        else counts.marks += 1;
        return [];
      }),
    },
  };
  const terminal = { activeAccountId: async () => ACCOUNT } as unknown as TerminalService;
  const lots = { load: async () => { counts.load += 1; return { accountId: ACCOUNT, history, truncated: false, fillCount: fills.length }; } } as unknown as TradeLotsService;
  return { service: new FeedbackService(prisma as never, terminal, lots), counts, history };
}

afterEach(() => vi.useRealTimers());

describe("feedback summary (review fixes)", () => {
  it("issues one mark query per pair group, not per lot, and caps the limit at 100", async () => {
    const { service, counts } = setup();
    const summary = await service.summary({ limit: "500" });
    expect(summary.limit).toBe(FEEDBACK_SUMMARY_MAX_LIMIT);
    expect(summary.lotsEvaluated).toBe(60);
    expect(counts).toEqual({ load: 1, marks: 2, fills: 1, observationsById: 0, snapshots: 1 });
  });

  it("pages newest closed lots by closedAt", async () => {
    const { service } = setup();
    const summary = await service.summary({ limit: "1" });
    // Newest close overall: the last pair A lot.
    expect(summary.lots[0]!.closedAt).toBe(at(10_000 + 29 * 10 + 5));
    const all = await service.summary({ limit: "100" });
    const closes = all.lots.map((row) => Date.parse(row.closedAt));
    expect(closes).toEqual([...closes].sort((left, right) => right - left));
    expect(all.lots.findIndex((row) => row.closedAt === at(10_000))).toBeLessThan(all.lots.findIndex((row) => row.closedAt === at(295)));
  });

  it("reuses a summary within the TTL and recomputes after it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(T0));
    const { service, counts } = setup();
    const first = await service.summary({});
    expect(first.cache.hit).toBe(false);
    const second = await service.summary({});
    expect(second.cache.hit).toBe(true);
    expect(counts.load).toBe(1);
    await service.summary({ limit: "3" }); // different key
    expect(counts.load).toBe(2);
    vi.setSystemTime(new Date(T0 + FEEDBACK_SUMMARY_CACHE_TTL_MS + 1));
    const third = await service.summary({});
    expect(third.cache.hit).toBe(false);
    expect(counts.load).toBe(3);
  });
});
