import { describe, expect, it } from "vitest";
import { sha256Hex } from "../genesis/canonical.js";
import { predictionCanonical, type PredictionRecord } from "../genesis/shadow.js";
import { readProspectiveCohort } from "./bridge.js";
import { prospectiveEvidence, type ProspectiveRow } from "./stages.js";

/**
 * OPERATION INTEGRITY F09: complete, deterministic, bounded prospective cohort reads. An in-memory store implements
 * the exact keyset contract the reader uses (where / orderBy (decisionTime, id) / take / count), so page boundaries,
 * ties and the cutoff are tested against a full reference computation. Real-Postgres coverage of pagination and
 * snapshot isolation is in `cohort.integration.test.ts`.
 */
const BAR = 3_600_000;
const T0 = Date.UTC(2026, 0, 1);
const MODEL = "model-f09";

type Stored = PredictionRecord & { id: string; recordCanonical: string; recordHash: string; outcome: { hypotheticalFillAvailable: boolean; realisedNetReturn: number | null; positive: boolean | null; costBpsApplied: number | null } | null };

function row(i: number, o: { t: number; instrument?: string; status?: "PREDICTED" | "ABSTAINED"; p?: number | null; net?: number | null; horizonBars?: number; id?: string }): Stored {
  const horizonBars = o.horizonBars ?? 1;
  const status = o.status ?? "PREDICTED";
  const rec: PredictionRecord = {
    modelVersionId: MODEL,
    instrumentKey: o.instrument ?? "SOL",
    status,
    predictedAt: new Date(o.t),
    decisionBarOpenTime: new Date(o.t - BAR),
    decisionTime: new Date(o.t),
    barMs: BAR,
    horizonBars,
    horizonEndsAt: new Date(o.t + horizonBars * BAR),
    features: { f: i % 7 },
    featureHash: "f".repeat(64),
    probability: status === "ABSTAINED" ? null : o.p === undefined ? 0.6 : o.p,
    expectedNetReturn: null,
    confidenceBasis: "test",
    estimatedCostBps: 10,
    abstainReasons: status === "ABSTAINED" ? ["DISAGREEMENT"] : [],
    inputHash: "i".repeat(64),
  };
  const canonical = predictionCanonical(rec);
  const net = o.net === undefined ? (i % 3 === 0 ? -0.001 : 0.002) : o.net;
  return {
    ...rec,
    id: o.id ?? `r${String(i).padStart(7, "0")}`,
    recordCanonical: canonical,
    recordHash: sha256Hex(canonical),
    outcome: status === "PREDICTED" && net !== null ? { hypotheticalFillAvailable: true, realisedNetReturn: net, positive: net > 0, costBpsApplied: 10 } : null,
  };
}

type Where = { modelVersionId: string; OR?: Array<{ decisionTime: { gt: Date } } | { decisionTime: Date; id: { gt: string } }> };
function store(rows: Stored[]) {
  const calls = { findMany: 0, maxTake: 0, rowsReturned: 0 };
  const cmp = (a: Stored, b: Stored) => a.decisionTime.getTime() - b.decisionTime.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const match = (r: Stored, w: Where) =>
    r.modelVersionId === w.modelVersionId &&
    (!w.OR || w.OR.some((c) => ("id" in c ? r.decisionTime.getTime() === c.decisionTime.getTime() && r.id > c.id.gt : r.decisionTime.getTime() > c.decisionTime.gt.getTime())));
  const db = {
    shadowPrediction: {
      findMany: async (q: { where: Where; take: number; orderBy: unknown }) => {
        expect(q.orderBy).toEqual([{ decisionTime: "asc" }, { id: "asc" }]);
        calls.findMany += 1;
        calls.maxTake = Math.max(calls.maxTake, q.take);
        const out = rows.filter((r) => match(r, q.where)).sort(cmp).slice(0, q.take);
        calls.rowsReturned += out.length;
        return out;
      },
      count: async (q: { where: Where }) => rows.filter((r) => match(r, q.where)).length,
    },
  };
  return { db: db as never, calls };
}

/** Reference: everything loaded at once, in the same deterministic order, cut by the same rule. */
function reference(rows: Stored[], target: number, threshold = 0.55): ProspectiveRow[] {
  const all = [...rows].sort((a, b) => a.decisionTime.getTime() - b.decisionTime.getTime() || (a.id < b.id ? -1 : 1));
  let n = 0;
  let lastEnd = Number.NEGATIVE_INFINITY;
  let cutoff = Number.POSITIVE_INFINITY;
  for (const r of all) {
    const ok = r.status === "PREDICTED" && r.outcome && r.probability !== null;
    if (ok && r.probability! >= threshold && r.decisionTime.getTime() >= lastEnd) {
      n += 1;
      lastEnd = r.horizonEndsAt.getTime();
      if (n === target) {
        cutoff = r.decisionTime.getTime();
        break;
      }
    }
  }
  return all.filter((r) => r.decisionTime.getTime() <= cutoff).map((r) => ({ decisionTime: r.decisionTime.getTime() }) as ProspectiveRow);
}

const series = (n: number, f: (i: number) => Parameters<typeof row>[1] = (i) => ({ t: T0 + i * BAR })) => Array.from({ length: n }, (_, i) => row(i, f(i)));
const read = (rows: Stored[], target: number, extra: { pageSize?: number; maxRows?: number } = {}) => {
  const s = store(rows);
  return readProspectiveCohort(s.db, { modelVersionId: MODEL, entryThreshold: 0.55, targetEffectiveSignals: target, pageSize: extra.pageSize ?? 1_000, maxRows: extra.maxRows }).then((c) => ({ ...c, calls: s.calls }));
};

describe("prospective cohort reader (F09)", () => {
  it("empty cohort: nothing read, not reached, not truncated", async () => {
    const c = await read([], 30);
    expect(c).toMatchObject({ rows: [], reached: false, truncated: false, laterRows: 0, pages: 1 });
  });

  it("single row", async () => {
    const c = await read(series(1), 1);
    expect(c.rows).toHaveLength(1);
    expect(c.reached).toBe(true);
  });

  it.each([5_000, 5_001, 15_437])("reads every row of a %i-row cohort that has not reached its target, in pages of at most pageSize", async (n) => {
    const rows = series(n, (i) => ({ t: T0 + i * BAR, status: i % 4 === 0 ? "ABSTAINED" : "PREDICTED", net: null }));
    const c = await read(rows, 5_000);
    expect(c.rows).toHaveLength(n);
    expect(c.reached).toBe(false);
    expect(c.calls.maxTake).toBe(1_000);
    expect(c.calls.rowsReturned).toBe(n);
    expect(new Set(c.rows.map((r) => r.decisionTime)).size).toBe(n);
  });

  it("the old 5,000-row prefix could not reach a target the complete read reaches (horizon 8)", async () => {
    // One decision per bar, horizon 8: about one independent signal per 8 rows.
    const rows = series(16_000, (i) => ({ t: T0 + i * BAR, horizonBars: 8 }));
    const full = await read(rows, 1_200);
    expect(full.reached).toBe(true);
    expect(full.rows.length).toBeGreaterThan(5_000);
    const old = prospectiveEvidence({ rows: full.rows.slice(0, 5_000), entryThreshold: 0.55, horizonBars: 8, barMs: BAR, referenceBrier: null, featureNames: [], now: T0 + 20_000 * BAR, targetEffectiveSignals: 1_200 });
    expect(old.observation.reached).toBe(false);
  });

  it("matches a complete reference calculation, independent of page size, with ties across page boundaries", async () => {
    // Three instruments share every decision time, so ties straddle every page boundary for page sizes 1, 2, 7, 1000.
    const rows: Stored[] = [];
    for (let i = 0; i < 3_000; i += 1) for (const [k, inst] of ["A", "B", "C"].entries()) rows.push(row(i * 3 + k, { t: T0 + i * BAR, instrument: inst, id: `${inst}${String(i).padStart(6, "0")}`, status: (i + k) % 5 === 0 ? "ABSTAINED" : "PREDICTED", p: (i + k) % 2 ? 0.7 : 0.4 }));
    const shuffled = [...rows].reverse();
    const expected = reference(rows, 400).map((r) => r.decisionTime);
    for (const pageSize of [1, 2, 7, 1_000]) {
      const c = await read(shuffled, 400, { pageSize });
      expect(c.reached).toBe(true);
      expect(c.rows.map((r) => r.decisionTime)).toEqual(expected);
      // Every row sharing the cutoff time is in the cohort, none after it.
      const cutoff = c.cutoffDecisionTime!;
      expect(c.rows.filter((r) => r.decisionTime === cutoff)).toHaveLength(3);
      expect(c.laterRows).toBe(rows.filter((r) => r.decisionTime.getTime() > cutoff).length);
    }
  });

  it("stops loading once the cohort is complete: later rows are counted, not loaded", async () => {
    const rows = series(20_000);
    const c = await read(rows, 30);
    expect(c.rows.length).toBeLessThan(100);
    expect(c.calls.rowsReturned).toBeLessThanOrEqual(1_000);
    expect(c.laterRows).toBe(20_000 - c.rows.length);
  });

  it("abstentions and sub-threshold predictions are in the cohort but never count as signals", async () => {
    const rows = series(60, (i) => ({ t: T0 + i * BAR, status: i % 2 ? "ABSTAINED" : "PREDICTED", p: i % 4 === 0 ? 0.9 : 0.3 }));
    const c = await read(rows, 10);
    // Signals are rows 0, 4, 8, … : the 10th is row 36.
    expect(c.cutoffDecisionTime).toBe(T0 + 36 * BAR);
    expect(c.rows).toHaveLength(37);
    const ev = prospectiveEvidence({ rows: c.rows, entryThreshold: 0.55, horizonBars: 1, barMs: BAR, referenceBrier: null, featureNames: [], now: T0 + 100 * BAR, targetEffectiveSignals: 10 });
    expect(ev.abstained).toBe(18);
    expect(ev.effectiveSignals).toBe(10);
  });

  it("a cohort larger than the row bound is truncated and can never be judged sufficient", async () => {
    const rows = series(3_000, (i) => ({ t: T0 + i * BAR, status: "ABSTAINED" }));
    const c = await read(rows, 30, { maxRows: 2_500 });
    expect(c).toMatchObject({ truncated: true, reached: false });
    expect(c.rows).toHaveLength(2_500);
    const ev = prospectiveEvidence({ rows: c.rows, entryThreshold: 0.55, horizonBars: 1, barMs: BAR, referenceBrier: null, featureNames: [], now: T0, targetEffectiveSignals: 30, cohort: { pages: c.pages, rowsRead: 2_500, laterRows: c.laterRows, truncated: true, maxRows: 2_500 } });
    expect(ev.sufficient).toBe(false);
    expect(ev.observation.judgedOn).toBe("NOT_YET_JUDGED");
    expect(ev.missing.join(" ")).toMatch(/truncated cohort is never judged/);
  });

  it("an earlier prediction still awaiting its outcome keeps the sample unjudged (late outcome cannot move the cutoff)", async () => {
    const rows = series(40);
    rows[3] = row(3, { t: T0 + 3 * BAR, net: null }); // no outcome yet
    const c = await read(rows, 20);
    const ev = prospectiveEvidence({ rows: c.rows, entryThreshold: 0.55, horizonBars: 1, barMs: BAR, referenceBrier: null, featureNames: [], now: T0 + 100 * BAR, targetEffectiveSignals: 20 });
    expect(ev.observation).toMatchObject({ reached: false, judgedOn: "NOT_YET_JUDGED", pendingOutcomesInSample: 1 });
    expect(ev.sufficient).toBe(false);
    // When it arrives, the cutoff moves one row earlier: exactly why the sample could not be judged before.
    const resolved = [...rows];
    resolved[3] = row(3, { t: T0 + 3 * BAR, net: 0.002 });
    const c2 = await read(resolved, 20);
    expect(c2.cutoffDecisionTime!).toBeLessThan(c.cutoffDecisionTime!);
  });

  it("a later insert after the cohort is complete does not change the judged cohort", async () => {
    const rows = series(200);
    const before = await read(rows, 50);
    const after = await read([...rows, ...series(50, (i) => ({ t: T0 + (300 + i) * BAR, id: `late${i}` }))], 50);
    expect(after.rows.map((r) => r.decisionTime)).toEqual(before.rows.map((r) => r.decisionTime));
    expect(after.laterRows).toBe(before.laterRows + 50);
  });

  it("rejects invalid page sizes", async () => {
    await expect(read(series(3), 1, { pageSize: 0 })).rejects.toThrow(/positive integers/);
  });

  it("benchmark: 100,000 rows, target unreached, bounded page size", async () => {
    const rows = series(100_000, (i) => ({ t: T0 + i * BAR, status: i % 3 ? "ABSTAINED" : "PREDICTED", net: null }));
    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();
    const c = await read(rows, 5_000, { pageSize: 2_000 });
    const ms = performance.now() - started;
    expect(c.rows).toHaveLength(100_000);
    expect(c.calls.maxTake).toBe(2_000);
    // Recorded in docs/integrity/F09-COHORT-VERIFICATION.md (in-memory store; excludes database time).
    console.info(`F09 benchmark: 100000 rows, ${c.pages} pages, ${ms.toFixed(0)} ms, heap +${((process.memoryUsage().heapUsed - heapBefore) / 1e6).toFixed(1)} MB`);
  }, 120_000);
});
