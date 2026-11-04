import { describe, expect, it } from "vitest";
import { reservationDecision, reservationEstimateUsd } from "./budget-store.js";
import { reviewResearchEvidence } from "./research-adversary.js";
import {
  expectedBarCount,
  loadPointInTimeDataset,
  measureSignalsOnBars,
  pinResearchDataset,
  researchCostPerSide,
  type HistoricalReader,
  type PinnedDataset,
} from "./research-dataset.js";
import { canonicalStrategySource, candidateIdentity } from "./research-redundancy.js";
import { choosePinnedDataset, scoreResearchTasks, type TaskCandidate } from "./research-scheduler.js";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 0, 1);

type Row = { datasetId: string; openTime: Date; availableAt: Date; open: string; high: string; low: string; close: string; volume: string | null; hash: string };

function bars(datasetId: string, count: number): Row[] {
  return Array.from({ length: count }, (_, i) => {
    const price = (100 + Math.sin(i / 7) * 5 + i * 0.01).toFixed(6);
    return { datasetId, openTime: new Date(T0 + i * HOUR), availableAt: new Date(T0 + (i + 1) * HOUR), open: price, high: price, low: price, close: price, volume: "10", hash: `h${i}` };
  });
}

const dataset = { id: "ds1", sourceId: "src", instrumentKey: "POOL_A", instrumentKind: "SOLANA_POOL", cohort: "LIQUID_MAJOR", interval: "1h", versionHash: "v1".padEnd(64, "0"), barCount: 800 };

/** Test double for the warehouse. `ignoreAsOf` makes it return future bars, to prove the adapter drops them. */
function reader(rows: Row[], options: { ignoreAsOf?: boolean; datasetRow?: Record<string, unknown> | null } = {}): HistoricalReader {
  const row = options.datasetRow === undefined ? dataset : options.datasetRow;
  const lte = (where: { availableAt?: { lte?: Date; gt?: Date } }, bar: Row) =>
    (!where.availableAt?.lte || options.ignoreAsOf || bar.availableAt <= where.availableAt.lte) && (!where.availableAt?.gt || bar.availableAt > where.availableAt.gt);
  return {
    historicalDataset: {
      findUnique: async () => row,
      findMany: async () => (row ? [row] : []),
    },
    historicalBar: {
      findMany: async ({ where, take }: { where: { availableAt?: { lte?: Date } }; take?: number }) =>
        rows.filter((bar) => lte(where, bar)).sort((a, b) => b.openTime.getTime() - a.openTime.getTime()).slice(0, take ?? rows.length),
      count: async ({ where }: { where: { availableAt?: { gt?: Date } } }) => rows.filter((bar) => lte(where, bar)).length,
    },
  } as unknown as HistoricalReader;
}

const pinned = (asOfIndex: number, overrides: Partial<PinnedDataset> = {}): PinnedDataset => ({
  datasetId: "ds1",
  versionHash: dataset.versionHash,
  sourceId: "src",
  instrumentKey: "POOL_A",
  instrumentKind: "SOLANA_POOL",
  interval: "1h",
  barCount: 800,
  asOf: new Date(T0 + asOfIndex * HOUR).toISOString(),
  adapter: "genesis-pit-1",
  ...overrides,
});

describe("GENESIS point-in-time dataset adapter", () => {
  it("returns only bars available at or before the as-of time, and records dataset id, version, window and count", async () => {
    const rows = bars("ds1", 800);
    for (const ignoreAsOf of [false, true]) {
      const loaded = await loadPointInTimeDataset(reader(rows, { ignoreAsOf }), { pinned: pinned(600), hypothesisInstrumentIds: ["POOL_A"] });
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.bars).toHaveLength(600);
      expect(Math.max(...loaded.bars.map((bar) => bar.availableAt))).toBeLessThanOrEqual(T0 + 600 * HOUR);
      expect(loaded.evidence).toMatchObject({ datasetId: "ds1", versionHash: dataset.versionHash, barCount: 600, excludedAfterAsOf: 200, asOf: pinned(600).asOf });
      expect(loaded.evidence.window.lastAvailableAt).toBe(new Date(T0 + 600 * HOUR).toISOString());
      expect(loaded.evidence.filteredAfterAsOf).toBe(ignoreAsOf ? 200 : 0);
      expect(loaded.evidence.windowHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("refuses a stale versionHash, an instrument mismatch, too few bars and a missing dataset with typed codes", async () => {
    const rows = bars("ds1", 800);
    const stale = await loadPointInTimeDataset(reader(rows), { pinned: pinned(600, { versionHash: "old".padEnd(64, "0") }), hypothesisInstrumentIds: ["POOL_A"] });
    expect(stale).toMatchObject({ ok: false, code: "DATASET_VERSION_STALE" });
    const mismatch = await loadPointInTimeDataset(reader(rows), { pinned: pinned(600), hypothesisInstrumentIds: ["POOL_B"] });
    expect(mismatch).toMatchObject({ ok: false, code: "INSTRUMENT_MISMATCH" });
    const pinnedOther = await loadPointInTimeDataset(reader(rows), { pinned: pinned(600, { instrumentKey: "POOL_B" }), hypothesisInstrumentIds: ["POOL_A", "POOL_B"] });
    expect(pinnedOther).toMatchObject({ ok: false, code: "INSTRUMENT_MISMATCH" });
    const short = await loadPointInTimeDataset(reader(rows), { pinned: pinned(100), hypothesisInstrumentIds: ["POOL_A"] });
    expect(short).toMatchObject({ ok: false, code: "INSUFFICIENT_BARS" });
    const gone = await loadPointInTimeDataset(reader(rows, { datasetRow: null }), { pinned: pinned(600), hypothesisInstrumentIds: ["POOL_A"] });
    expect(gone).toMatchObject({ ok: false, code: "DATASET_NOT_FOUND" });
  });

  it("pins deterministically and refuses when the hypothesis has no versioned dataset", async () => {
    const pin = await pinResearchDataset(reader([]), { instrumentIds: ["POOL_A"], asOf: new Date(T0) });
    expect(pin).toMatchObject({ ok: true, pinned: { datasetId: "ds1", versionHash: dataset.versionHash, asOf: new Date(T0).toISOString() } });
    expect(await pinResearchDataset(reader([], { datasetRow: null }), { instrumentIds: ["POOL_A"], asOf: new Date(T0) })).toMatchObject({ ok: false, code: "DATASET_UNAVAILABLE" });
    expect(await pinResearchDataset(reader([]), { instrumentIds: [], asOf: new Date(T0) })).toMatchObject({ ok: false, code: "DATASET_UNAVAILABLE" });
  });

  it("prices costs point-in-time and refuses without a basis (never assumes a cost)", async () => {
    let seen: Date | null = null;
    const none = { marketObservation: { findFirst: async (args: { where: { receivedAt: { lte: Date } } }) => ((seen = args.where.receivedAt.lte), null) } } as never;
    const asOf = new Date(T0);
    expect(await researchCostPerSide(none, { instrumentKind: "SOLANA_POOL", instrumentKey: "POOL_A" }, asOf)).toMatchObject({ ok: false, code: "COST_UNAVAILABLE" });
    expect(seen).toEqual(asOf);
    const etf = await researchCostPerSide(none, { instrumentKind: "EQUITY_ETF", instrumentKey: "SPY" }, asOf);
    expect(etf.ok && etf.cost.bpsPerSide > 0).toBe(true);
  });

  it("counts calendar-expected bars (weekday daily bars skip weekends)", () => {
    const monday = Date.UTC(2026, 0, 5);
    expect(expectedBarCount(monday, monday + 6 * 86_400_000, 86_400_000, "WEEKDAYS")).toBe(5);
    expect(expectedBarCount(monday, monday + 6 * 86_400_000, 86_400_000, "CONTINUOUS")).toBe(7);
  });

  it("measures signals with next-bar fills and costs; a signal on the last bars cannot move earlier results", () => {
    const rows = bars("ds1", 600);
    const points = rows.map((row) => ({ openTime: row.openTime.getTime(), availableAt: row.availableAt.getTime(), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), closeText: row.close, volume: 10, hash: row.hash }));
    const intents = points.map((_, i) => (i % 20 === 0 ? "ENTER_LONG" : i % 20 === 10 ? "EXIT_LONG" : "HOLD"));
    const cheap = measureSignalsOnBars({ bars: points, intents, costBpsPerSide: 1, periodsPerYear: 8760 });
    const dear = measureSignalsOnBars({ bars: points, intents, costBpsPerSide: 50, periodsPerYear: 8760 });
    expect(cheap.full.trades).toBeGreaterThan(20);
    expect(dear.full.netReturn).toBeLessThan(cheap.full.netReturn);
    expect(cheap.folds).toHaveLength(4);
    expect(cheap.holdoutStartIndex).toBe(480);
    const changedTail = intents.map((intent, i) => (i >= 590 ? "ENTER_LONG" : intent));
    const tail = measureSignalsOnBars({ bars: points, intents: changedTail, costBpsPerSide: 1, periodsPerYear: 8760 });
    expect(tail.folds).toEqual(cheap.folds);
  });
});

describe("GENESIS redundancy identity", () => {
  const source = `export function onBar(input) {\n  // momentum\n  return { intent: "HOLD", reasonCodes: ["A"] };\n}\n`;
  it("hashes the canonical source: comments and formatting do not change identity; the name never matters", () => {
    const reformatted = `/* renamed copy */ export function onBar( input ){ return {intent:"HOLD",reasonCodes:["A"]} ;}`;
    expect(canonicalStrategySource(reformatted)).toBe(canonicalStrategySource(source));
    const a = candidateIdentity({ source, family: "F", params: { p: 1 }, strategyId: "strat_one" });
    const b = candidateIdentity({ source: reformatted, family: "F", params: { p: 1 }, strategyId: "strat_renamed" });
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(b.holdoutStrategyId).toBe(a.holdoutStrategyId);
    expect(candidateIdentity({ source: source.replace('"A"', '"B"'), family: "F", params: { p: 1 }, strategyId: "strat_one" }).fingerprint).not.toBe(a.fingerprint);
    expect(candidateIdentity({ source, family: "F", params: { p: 2 }, strategyId: "strat_one" }).fingerprint).not.toBe(a.fingerprint);
    // String contents are kept verbatim (a "//" inside a string is not a comment).
    expect(canonicalStrategySource(`const u = "a // b";`)).toContain('"a // b"');
  });
});

describe("GENESIS task scorer", () => {
  const base = (id: string, createdAt: string, extra: Partial<TaskCandidate> = {}): TaskCandidate => ({
    hypothesisId: id,
    createdAt,
    family: "FORGED_SANDBOX:SPOT_CRYPTO_PAIR",
    datasets: [{ datasetId: `ds_${id}`, versionHash: "v1", barCount: 600 }],
    priorExperiments: [],
    ...extra,
  });
  const candidates: TaskCandidate[] = [
    base("h_old", "2026-01-01T00:00:00.000Z"),
    base("h_gap", "2026-01-03T00:00:00.000Z"),
    base("h_active", "2026-01-01T00:00:00.000Z", { priorExperiments: [{ state: "TEST", pinned: null }] }),
    base("h_review", "2026-01-01T00:00:00.000Z", { priorExperiments: [{ state: "REVIEW", pinned: null }] }),
    base("h_failed_same", "2026-01-01T00:00:00.000Z", { priorExperiments: [{ state: "FAILED", pinned: { datasetId: "ds_h_failed_same", versionHash: "v1" } }] }),
    base("h_failed_new", "2026-01-02T00:00:00.000Z", { priorExperiments: [{ state: "REJECTED", pinned: { datasetId: "ds_h_failed_new", versionHash: "v0" } }] }),
    base("h_abandoned", "2026-01-01T00:00:00.000Z", { priorExperiments: [{ state: "ABANDONED", pinned: null }] }),
    base("h_nodata", "2025-12-01T00:00:00.000Z", { datasets: [] }),
  ];
  const stats = { trialsByDataset: { ds_h_old: 3 }, trialsByFamily: {} };

  it("is deterministic and independent of input order", () => {
    const first = scoreResearchTasks(candidates, stats);
    const second = scoreResearchTasks([...candidates].reverse(), stats);
    expect(second.ranked).toEqual(first.ranked);
    expect(first.ranked.map((row) => row.hypothesisId)).toEqual(["h_failed_new", "h_gap", "h_old", "h_nodata"]);
  });

  it("judges new evidence on the dataset the pin would choose, not on any dataset of the hypothesis (two datasets)", () => {
    const two = (pinnedVersion: string, chosenVersion: string, otherVersion: string) =>
      base("h_two", "2026-01-01T00:00:00.000Z", {
        datasets: [
          { datasetId: "ds_small", versionHash: otherVersion, barCount: 500 },
          { datasetId: "ds_big", versionHash: chosenVersion, barCount: 900 },
        ],
        priorExperiments: [{ state: "FAILED", pinned: { datasetId: "ds_big", versionHash: pinnedVersion } }],
      });
    // The never-pinned smaller dataset is not new evidence, however often the scorer runs.
    expect(scoreResearchTasks([two("v1", "v1", "v1")], { trialsByDataset: {}, trialsByFamily: {} }).skipped).toEqual([{ hypothesisId: "h_two", reason: "NO_NEW_EVIDENCE" }]);
    expect(scoreResearchTasks([two("v1", "v1", "v9")], { trialsByDataset: {}, trialsByFamily: {} }).skipped).toEqual([{ hypothesisId: "h_two", reason: "NO_NEW_EVIDENCE" }]);
    // A new version of the dataset that would be pinned is.
    expect(scoreResearchTasks([two("v1", "v2", "v1")], { trialsByDataset: {}, trialsByFamily: {} }).ranked[0]).toEqual(expect.objectContaining({ hypothesisId: "h_two", components: expect.objectContaining({ newData: 300 }) }));
    expect(choosePinnedDataset([{ datasetId: "b", barCount: 5 }, { datasetId: "a", barCount: 5 }])?.datasetId).toBe("a");
  });

  it("prioritises knowledge gaps and new data; retries failures only on new evidence; skips active, review and abandoned", () => {
    const { ranked, skipped } = scoreResearchTasks(candidates, stats);
    const byId = Object.fromEntries(ranked.map((row) => [row.hypothesisId, row]));
    expect(byId.h_gap!.components.knowledgeGap).toBeGreaterThan(byId.h_old!.components.knowledgeGap);
    expect(byId.h_failed_new!.components.newData).toBe(300);
    expect(byId.h_nodata!.score).toBe(0);
    expect(Object.fromEntries(skipped.map((row) => [row.hypothesisId, row.reason]))).toEqual({
      h_active: "ACTIVE_OR_IN_REVIEW",
      h_review: "ACTIVE_OR_IN_REVIEW",
      h_failed_same: "NO_NEW_EVIDENCE",
      h_abandoned: "OPERATOR_ABANDONED",
    });
  });
});

describe("GENESIS adversarial reviewer", () => {
  const folds = [1, 2, 3, 4].map((fold) => ({ fold, trades: 10, netReturn: 0.02 }));
  const good = {
    dataset: { asOf: "2026-02-01T00:00:00.000Z", maxAvailableAt: "2026-01-31T00:00:00.000Z", barCount: 800 },
    measuredAt: "2026-02-01T00:00:00.000Z",
    measuredSampleSize: 60,
    untouchedSampleSize: 12,
    cost: { bpsPerSide: 12, basis: "conservative", isProxy: true },
    folds,
    fullNetReturnDoubleCost: 0.03,
    redundancy: { checked: ["DUPLICATE_EXPERIMENT"] },
    candidate: { fingerprint: "f" },
  };
  const review = (test: Record<string, unknown>, holdoutConsumedElsewhere = false) =>
    reviewResearchEvidence({ test, minBars: 500, minSampleTrades: 30, holdoutConsumedElsewhere });

  it("passes complete, point-in-time, costed, stable evidence", () => {
    expect(review(good)).toEqual({ passed: true, reasonCodes: [], findings: [] });
  });

  it("rejects leakage, small samples, missing costs, unstable folds and reused data with reason codes", () => {
    expect(review({ ...good, dataset: { ...good.dataset, maxAvailableAt: "2026-02-02T00:00:00.000Z" } }).reasonCodes).toEqual(["LEAKAGE_AVAILABLE_AT"]);
    expect(review({ ...good, measuredSampleSize: 5 }).reasonCodes).toEqual(["INSUFFICIENT_SAMPLE"]);
    expect(review({ ...good, cost: undefined }).reasonCodes).toEqual(["MISSING_COSTS"]);
    expect(review({ ...good, folds: folds.map((fold, i) => ({ ...fold, netReturn: i === 0 ? 0.1 : -0.01 })) }).reasonCodes).toEqual(["UNSTABLE_FOLDS"]);
    expect(review({ ...good, fullNetReturnDoubleCost: -0.01 }).reasonCodes).toEqual(["UNSTABLE_FOLDS"]);
    expect(review(good, true).reasonCodes).toEqual(["REUSED_DATA"]);
    expect(review({ ...good, redundancy: undefined }).reasonCodes).toEqual(["REUSED_DATA"]);
  });
});

describe("GENESIS budget reservation (pure part)", () => {
  it("reserves the worst case over the chain and fails closed", () => {
    const reserve = reservationEstimateUsd({ endpoints: [{ costPer1kInputUsd: "0.002", costPer1kOutputUsd: "0.008" }], promptTokens: 1000, maxCompletionTokens: 500 });
    expect(reserve).toBe("0.02000000"); // 2 attempts × (1k × 0.002 + 1k × 0.008)
    expect(reservationDecision({ capUsd: "1", spentUsd: "0.99", reserveUsd: reserve })).toMatchObject({ ok: false });
    expect(reservationDecision({ capUsd: "1", spentUsd: "0.5", reserveUsd: reserve })).toEqual({ ok: true, remainingAfterUsd: "0.48000000" });
    expect(reservationDecision({ capUsd: "1", spentUsd: "not-a-number", reserveUsd: reserve })).toMatchObject({ ok: false });
  });
});
