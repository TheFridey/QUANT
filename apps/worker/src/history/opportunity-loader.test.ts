import { describe, expect, it } from "vitest";
import { counterfactualBarBounds, CYCLE_BATCH, iterateOpportunityBatches } from "./opportunity-loader.js";

const H = 3_600_000;
const S = 1_000;
const T0 = Date.UTC(2026, 9, 1, 12);

type Where = { availableAt?: { gte: Date; lte: Date }; cycleId?: { in: string[] } };

/** Minimal read-only Prisma stand-in: just the findMany calls the loader makes. */
function fakePrisma(input: { cycles: Array<{ id: string; startedAt: Date }>; funnel: Array<{ cycleId: string; pairAddress: string; createdAt: Date }>; bars: Array<{ openTime: number; close: string }> }) {
  const barQueries: Array<{ gte: number; lte: number }> = [];
  const prisma = {
    cycleRun: { findMany: async () => input.cycles.map((c) => ({ ...c, accountId: "acct", tradingEnvironment: "PAPER", dataMode: "live" })) },
    opportunityFunnelEvent: {
      findMany: async ({ where }: { where: Where }) =>
        input.funnel.filter((f) => where.cycleId!.in.includes(f.cycleId)).map((f, i) => ({ id: `f${i}`, accountId: "acct", instrumentId: null, stage: "DISCOVERED", reasonCodes: [], detail: null, ...f })),
    },
    agentDecision: { findMany: async () => [] },
    tradeIntent: { findMany: async () => [] },
    historicalDataset: { findMany: async () => [{ id: "ds1", instrumentKey: "POOL", interval: "1h", lastOpenTime: new Date(input.bars.at(-1)!.openTime) }] },
    historicalBar: {
      findMany: async ({ where }: { where: Where }) => {
        const gte = where.availableAt!.gte.getTime();
        const lte = where.availableAt!.lte.getTime();
        barQueries.push({ gte, lte });
        return input.bars
          .map((b) => ({ openTime: new Date(b.openTime), availableAt: new Date(b.openTime + H), close: { toString: () => b.close } }))
          .filter((b) => b.availableAt.getTime() >= gte && b.availableAt.getTime() <= lte);
      },
    },
  };
  return { prisma: prisma as never, barQueries };
}

describe("GENESIS opportunity loader counterfactual bounds", () => {
  it("covers reference bars before the earliest decision and exits up to the latest decision + horizon", () => {
    expect(counterfactualBarBounds(T0, T0 + 10 * 60_000, 24 * H)).toEqual({ fromMs: T0, untilMs: T0 + 10 * 60_000 + 24 * H });
  });

  it("loads the exit bar for a decision near the end of a batch even when it lies beyond the batch's time range", async () => {
    // One batch of cycles spanning T0 .. T0+9min; the last cycle decides at +5 s. The 4 h exit bar closes at
    // T0+9min+4h-ish, far past the batch's own cycles, and the pool is sparse after it.
    const cycles = Array.from({ length: CYCLE_BATCH }, (_, i) => ({ id: `c${i}`, startedAt: new Date(T0 + i * 60_000) }));
    const last = cycles.at(-1)!;
    const decisionAt = last.startedAt.getTime() + 5 * S;
    const bars = [
      { openTime: T0 - 2 * H, close: "1.00" }, // reference: closes T0 - 1h
      { openTime: T0 - H, close: "1.01" }, // reference: closes T0
      { openTime: T0 + 3 * H, close: "1.20" }, // closes T0+4h: the +4h exit for the last cycle
      { openTime: T0 + 30 * H, close: "2.00" }, // sparse: next trade more than a day later
    ];
    const { prisma, barQueries } = fakePrisma({ cycles, funnel: [{ cycleId: last.id, pairAddress: "POOL", createdAt: new Date(decisionAt) }], bars });
    const batches = [];
    for await (const rows of iterateOpportunityBatches(prisma, { from: new Date(T0), to: new Date(T0 + H), counterfactualHorizonsMs: [H, 4 * H] })) batches.push(rows);
    expect(batches).toHaveLength(1);
    const row = batches[0]!.find((r) => r.cycleId === last.id)!;
    expect(barQueries[0]!.lte).toBeGreaterThanOrEqual(decisionAt + 4 * H);
    expect(row.hypothetical!.label).toBe("HYPOTHETICAL");
    expect(row.hypothetical!.referenceClose).toBe("1.01");
    // +1h: no newer close yet in a sparse pool, but the dataset continues, so it is not BEYOND_DATA.
    expect(row.hypothetical!.horizons[0]).toMatchObject({ exitClose: null, reason: "NO_FORWARD_BAR" });
    expect(row.hypothetical!.horizons[1]).toMatchObject({ exitClose: "1.20", reason: null });
  });
});
