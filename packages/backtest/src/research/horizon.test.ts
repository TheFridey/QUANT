import { describe, expect, it } from "vitest";
import { seededRng } from "../stats.js";
import { validateResearchBars } from "./feature-set.js";
import { runHorizonStudy, regimeLookup } from "./horizon.js";
import { costGatePasses, horizonStrategySpecs, inSessionWindow } from "./horizon-strategies.js";
import { buildTradeLabels } from "./labels.js";
import { costBpsPerSideAt, costWindowAt, horizonBars, isTradeableAt, MARKET_CONFIGS, marketConfigHash, pipSizeFor, unitToBps, validationCostBpsPerSide, type MarketResearchConfig } from "./market-config.js";
import { createMemoryHoldoutGate } from "./ml2.js";
import { fxSessionState, isContiguous } from "./sessions.js";
import { simulate, type ResearchBar } from "./simulate.js";
import { expandGrid } from "./strategies.js";

const H = 3_600_000;
const D = 86_400_000;
const FX = MARKET_CONFIGS.FX;
const ETF = MARKET_CONFIGS.ETF;
const iso = (s: string) => Date.parse(s);

/** Hourly open times on the FX calendar from a Sunday open; maintenance/holiday hours are skipped unless asked. */
function fxHourlyTimes(start: string, n: number, includeNonTrading = false): number[] {
  const out: number[] = [];
  for (let t = iso(start); out.length < n; t += H) {
    const s = fxSessionState(t);
    if (s === "OPEN" || (includeNonTrading && s !== "WEEKEND")) out.push(t);
  }
  return out;
}

type Plant = { every: number; jump: number; drift: number; len: number };

/** Gaussian-noise bars on given times; an optional planted edge: a wide up bar followed by `len` bars of drift. */
function pathBars(times: number[], seed: number, opts: { price0: number; sigma: number; plant?: Plant }): ResearchBar[] {
  const rng = seededRng(seed);
  const z = () => Math.sqrt(-2 * Math.log(rng() || 1e-12)) * Math.cos(2 * Math.PI * rng());
  const { sigma, plant } = opts;
  // Base drift offsets the planted drift, so buy-and-hold has roughly no edge.
  const base = plant ? -((plant.jump + plant.drift * plant.len) / plant.every) * sigma : 0;
  let p = opts.price0;
  let remaining = 0;
  return times.map((t) => {
    const open = p;
    let r: number;
    let event = false;
    if (plant && remaining === 0 && rng() < 1 / plant.every) {
      r = plant.jump * sigma;
      remaining = plant.len;
      event = true;
    } else if (remaining > 0) {
      r = plant!.drift * sigma + 0.5 * sigma * z();
      remaining -= 1;
    } else {
      r = base + sigma * z();
    }
    p = open * Math.exp(r);
    const hi = event ? p * (1 + 0.05 * sigma) : Math.max(open, p) * Math.exp(Math.abs(z()) * 0.3 * sigma);
    const lo = event ? open * (1 - 0.05 * sigma) : Math.min(open, p) * Math.exp(-Math.abs(z()) * 0.3 * sigma);
    return { t, open, high: hi, low: lo, close: p, volume: 1000 };
  });
}

describe("FX/metals session calendar (Sun 22:00 - Fri 22:00 UTC, 21:00-22:00 maintenance)", () => {
  it("classifies weekend, maintenance, holiday and open instants", () => {
    expect(fxSessionState(iso("2025-03-08T12:00:00Z"))).toBe("WEEKEND"); // Saturday
    expect(fxSessionState(iso("2025-03-09T21:00:00Z"))).toBe("WEEKEND"); // Sunday before the open
    expect(fxSessionState(iso("2025-03-09T22:00:00Z"))).toBe("OPEN"); // Sunday open
    expect(fxSessionState(iso("2025-03-10T21:00:00Z"))).toBe("MAINTENANCE");
    expect(fxSessionState(iso("2025-03-14T21:00:00Z"))).toBe("MAINTENANCE"); // Friday's last hour
    expect(fxSessionState(iso("2025-03-14T22:00:00Z"))).toBe("WEEKEND"); // Friday close
    expect(fxSessionState(iso("2025-12-24T22:00:00Z"))).toBe("HOLIDAY"); // the 25 Dec trading day
    expect(fxSessionState(iso("2025-12-25T22:00:00Z"))).toBe("OPEN");
  });

  it("refuses weekend bars but accepts maintenance-hour bars", () => {
    const t0 = iso("2025-03-14T19:00:00Z");
    const mk = (t: number): ResearchBar => ({ t, open: 1.1, high: 1.1, low: 1.1, close: 1.1, volume: 1 });
    const weekend = validateResearchBars([mk(t0), mk(t0 + H), mk(t0 + 3 * H)], { barMs: H, calendar: "FX_24_5" });
    expect(weekend.map((i) => i.code)).toEqual(["OFF_SESSION"]); // Friday 22:00
    expect(validateResearchBars([mk(t0), mk(t0 + H), mk(t0 + 2 * H)], { barMs: H, calendar: "FX_24_5" })).toEqual([]);
    // A Saturday daily bar is refused; Friday and Monday are fine.
    const daily = [iso("2025-03-14T00:00:00Z"), iso("2025-03-15T00:00:00Z"), iso("2025-03-17T00:00:00Z")].map(mk);
    expect(validateResearchBars(daily, { barMs: D, calendar: "FX_24_5" }).map((i) => i.index)).toEqual([1]);
  });

  it("treats the weekend, a missing maintenance bar and a holiday as session boundaries, not gaps", () => {
    const c = (a: string, b: string, ms = H) => isContiguous(iso(a), iso(b), ms, "FX_24_5");
    expect(c("2025-03-14T20:00:00Z", "2025-03-16T22:00:00Z")).toBe(true); // Fri 20:00 → Sun 22:00
    expect(c("2025-03-10T20:00:00Z", "2025-03-10T22:00:00Z")).toBe(true); // maintenance bar absent
    expect(c("2025-03-10T20:00:00Z", "2025-03-10T21:00:00Z")).toBe(true); // maintenance bar present
    expect(c("2025-03-10T20:00:00Z", "2025-03-10T23:00:00Z")).toBe(false); // 22:00 missing: a gap
    expect(c("2025-03-14T20:00:00Z", "2025-03-16T23:00:00Z")).toBe(false); // Sunday open missing: a gap
    expect(c("2025-12-24T20:00:00Z", "2025-12-25T22:00:00Z")).toBe(true); // 25 Dec trading day skipped
    expect(c("2025-03-14T00:00:00Z", "2025-03-17T00:00:00Z", D)).toBe(true); // daily Fri → Mon
    expect(c("2025-03-12T00:00:00Z", "2025-03-14T00:00:00Z", D)).toBe(false); // Thursday missing
  });

  it("labels never span a real gap but do span the weekend", () => {
    const times = fxHourlyTimes("2025-03-09T22:00:00Z", 200);
    const bars = pathBars(times, 3, { price0: 1.1, sigma: 0.001 });
    const withGap = bars.filter((_, i) => i !== 50);
    const labels = buildTradeLabels(withGap, { horizon: 5, feeBpsPerSide: 0, slippageBpsPerSide: 0 }, { barMs: H, isContiguous: (a, b) => isContiguous(a.t, b.t, H, "FX_24_5") });
    // Bars 49 → 50 of `withGap` straddle the removed bar: every label whose window crosses that step is null.
    expect(labels[44]).not.toBeNull();
    for (let i = 45; i <= 49; i += 1) expect(labels[i]).toBeNull();
    expect(labels[50]).not.toBeNull();
    // Friday's last bars label straight into Sunday's open.
    const fri = withGap.findIndex((b) => b.t === iso("2025-03-14T20:00:00Z"));
    expect(labels[fri]).not.toBeNull();
  });

  it("never enters for a fill in the maintenance hour, a holiday or the weekend", () => {
    const times = fxHourlyTimes("2024-12-01T22:00:00Z", 1500, true);
    const bars = pathBars(times, 9, { price0: 1.1, sigma: 0.0015, plant: { every: 12, jump: 5, drift: 0.8, len: 6 } });
    const specs = horizonStrategySpecs({ market: FX, instrument: "EUR/USD", barMs: H, regimeAt: regimeLookup(bars, H, FX) });
    let trades = 0;
    for (const spec of specs) {
      for (const params of expandGrid(spec.grid)) {
        const sim = simulate({ strategy: spec.build!(params), bars, startIndex: 0, endIndex: bars.length, costBpsPerSide: 1 });
        for (const tr of sim.trades) {
          trades += 1;
          expect(fxSessionState(tr.entryT)).toBe("OPEN");
        }
      }
    }
    expect(trades).toBeGreaterThan(50);
    expect(bars.some((b) => fxSessionState(b.t) === "MAINTENANCE")).toBe(true);
    expect(bars.some((b) => fxSessionState(b.t) === "HOLIDAY")).toBe(true);
  });
});

describe("US equity sessions for ETFs", () => {
  it("only regular hours on NYSE sessions are tradeable; open and close windows widen the spread", () => {
    expect(isTradeableAt(ETF, iso("2025-03-11T14:30:00Z"), H)).toBe(true); // 10:30 New York (EDT)
    expect(isTradeableAt(ETF, iso("2025-03-11T12:00:00Z"), H)).toBe(false); // 08:00 pre-market
    expect(isTradeableAt(ETF, iso("2025-07-04T15:00:00Z"), H)).toBe(false); // Independence Day
    expect(isTradeableAt(ETF, iso("2025-03-15T15:00:00Z"), H)).toBe(false); // Saturday
    expect(costWindowAt(ETF, iso("2025-03-11T13:30:00Z"), H)).toBe("SESSION_OPEN"); // 09:30 EDT
    expect(costWindowAt(ETF, iso("2025-03-11T19:30:00Z"), H)).toBe("SESSION_CLOSE"); // 15:30 EDT
    const normal = costBpsPerSideAt(ETF, "SPY", iso("2025-03-11T15:30:00Z"), 500, H);
    const open = costBpsPerSideAt(ETF, "SPY", iso("2025-03-11T13:30:00Z"), 500, H);
    expect(open).toBeGreaterThan(normal);
    expect(inSessionWindow("RTH_OPEN", iso("2025-03-11T13:30:00Z"))).toBe(true);
    expect(inSessionWindow("RTH_OPEN", iso("2025-03-11T16:30:00Z"))).toBe(false); // 12:30 EDT
    expect(inSessionWindow("RTH", iso("2025-11-27T16:30:00Z"))).toBe(false); // Thanksgiving
  });

  it("London and New York open windows follow local daylight saving time", () => {
    expect(inSessionWindow("LONDON_OPEN", iso("2025-01-15T08:00:00Z"))).toBe(true); // GMT
    expect(inSessionWindow("LONDON_OPEN", iso("2025-07-15T08:00:00Z"))).toBe(true); // 09:00 BST
    expect(inSessionWindow("LONDON_OPEN", iso("2025-07-15T10:00:00Z"))).toBe(false); // 11:00 BST
    expect(inSessionWindow("NY_OPEN", iso("2025-07-15T12:00:00Z"))).toBe(true); // 08:00 EDT
    expect(inSessionWindow("NY_OPEN", iso("2025-01-15T12:00:00Z"))).toBe(false); // 07:00 EST
  });
});

describe("cost model and pip scaling", () => {
  it("resolves USD/JPY to a 0.01 pip and converts at the bar's price", () => {
    expect(pipSizeFor("FX", "USD/JPY")).toBe(0.01);
    expect(pipSizeFor("FX", "EUR/USD")).toBe(0.0001);
    expect(pipSizeFor("GOLD", "XAU/USD")).toBe(0.01);
    expect(pipSizeFor("CRYPTO", "SOL/USDC")).toBeNull();
    expect(unitToBps(1, "PIPS", 0.01, 150)).toBeCloseTo(0.6667, 4);
    expect(unitToBps(1, "PIPS", 0.0001, 1.1)).toBeCloseTo(0.9091, 4);
    const t = iso("2025-03-11T10:00:00Z");
    const jpy = costBpsPerSideAt(FX, "USD/JPY", t, 150, H);
    const eur = costBpsPerSideAt(FX, "EUR/USD", t, 1.1, H);
    // Both majors cost well under 1 bp per side; a mis-scaled JPY pip would be 100× off either way.
    expect(jpy).toBeGreaterThan(0.3);
    expect(jpy).toBeLessThan(1);
    expect(eur).toBeGreaterThan(0.3);
    expect(eur).toBeLessThan(1);
    expect(jpy / eur).toBeCloseTo((0.01 / 150) / (0.0001 / 1.1), 6);
  });

  it("widens the spread at the weekly open, around the roll and in the maintenance hour", () => {
    const at = (s: string) => costBpsPerSideAt(FX, "EUR/USD", iso(s), 1.1, H);
    const normal = at("2025-03-11T10:00:00Z");
    expect(at("2025-03-09T22:00:00Z")).toBeGreaterThan(normal); // Sunday open
    expect(at("2025-03-11T20:00:00Z")).toBeGreaterThan(normal); // before the roll
    expect(at("2025-03-11T21:00:00Z")).toBeGreaterThan(at("2025-03-11T20:00:00Z")); // maintenance
    expect(at("2025-03-14T19:00:00Z")).toBeGreaterThan(normal); // Friday close
  });

  it("ATR thresholds are scale-free: the same path at a USD/JPY level gives the same decisions", () => {
    const times = fxHourlyTimes("2025-01-05T22:00:00Z", 800);
    const eur = pathBars(times, 21, { price0: 1.1, sigma: 0.002, plant: { every: 15, jump: 5, drift: 0.8, len: 6 } });
    const k = 150 / 1.1;
    const jpy = eur.map((b) => ({ ...b, open: b.open * k, high: b.high * k, low: b.low * k, close: b.close * k }));
    const se = horizonStrategySpecs({ market: FX, instrument: "EUR/USD", barMs: H, regimeAt: regimeLookup(eur, H, FX) });
    const sj = horizonStrategySpecs({ market: FX, instrument: "USD/JPY", barMs: H, regimeAt: regimeLookup(jpy, H, FX) });
    let trades = 0;
    se.forEach((spec, s) => {
      for (const params of expandGrid(spec.grid)) {
        const a = simulate({ strategy: spec.build!(params), bars: eur, startIndex: 0, endIndex: eur.length, costBpsPerSide: 1 });
        const b = simulate({ strategy: sj[s]!.build!(params), bars: jpy, startIndex: 0, endIndex: jpy.length, costBpsPerSide: 1 });
        expect(b.trades.map((x) => x.entryT)).toEqual(a.trades.map((x) => x.entryT));
        trades += a.trades.length;
      }
    });
    expect(trades).toBeGreaterThan(20);
  });

  it("the cost gate abstains when the round-trip cost exceeds the forecast move", () => {
    const hctx = { market: FX, instrument: "EUR/USD", barMs: H };
    const t = iso("2025-03-11T10:00:00Z");
    const rt = (2 * costBpsPerSideAt(FX, "EUR/USD", t, 1.1, H)) / 10_000;
    expect(costGatePasses(hctx, t, 1.1, FX.costGate.k * rt * 0.99)).toBe(false);
    expect(costGatePasses(hctx, t, 1.1, FX.costGate.k * rt * 1.01)).toBe(true);

    const times = fxHourlyTimes("2025-01-05T22:00:00Z", 800);
    const bars = pathBars(times, 5, { price0: 1.1, sigma: 0.002, plant: { every: 15, jump: 5, drift: 0.8, len: 6 } });
    const expensive: MarketResearchConfig = { ...FX, cost: { ...FX.cost, spreadFull: 500 } }; // 500 pips ≫ any 1-ATR move
    const count = (market: MarketResearchConfig) =>
      horizonStrategySpecs({ market, instrument: "EUR/USD", barMs: H, regimeAt: regimeLookup(bars, H, market) }).reduce(
        (n, spec) => n + expandGrid(spec.grid).reduce((m, params) => m + simulate({ strategy: spec.build!(params), bars, startIndex: 0, endIndex: bars.length, costBpsPerSide: 1 }).trades.length, 0),
        0,
      );
    expect(count(FX)).toBeGreaterThan(20);
    expect(count(expensive)).toBe(0);
  });

  it("validation cost is a quantile of per-bar costs over tradeable bars only", () => {
    const times = fxHourlyTimes("2025-01-05T22:00:00Z", 500, true);
    const bars = pathBars(times, 1, { price0: 1.1, sigma: 0.001 });
    const c = validationCostBpsPerSide(FX, "EUR/USD", bars, H);
    const maint = costBpsPerSideAt(FX, "EUR/USD", iso("2025-01-07T21:00:00Z"), 1.1, H);
    expect(c).toBeGreaterThan(costBpsPerSideAt(FX, "EUR/USD", iso("2025-01-07T10:00:00Z"), 1.1, H) - 1e-9);
    expect(c).toBeLessThan(maint);
  });

  it("horizons convert from trading hours to bars per market", () => {
    expect(horizonBars(FX, 8, H)).toBe(8);
    expect(horizonBars(ETF, 6.5, D)).toBe(1);
    expect(horizonBars(ETF, 32.5, D)).toBe(5);
    expect(horizonBars(MARKET_CONFIGS.CRYPTO, 24, 300_000)).toBe(288);
  });
});

describe("config hash", () => {
  it("is stable, key-order independent, sensitive to any change, and pinned per version", () => {
    for (const cfg of Object.values(MARKET_CONFIGS)) {
      const reordered = Object.fromEntries(Object.entries(cfg).reverse()) as MarketResearchConfig;
      expect(marketConfigHash(reordered)).toBe(marketConfigHash(cfg));
      expect(marketConfigHash({ ...cfg, cost: { ...cfg.cost, slippagePerSide: cfg.cost.slippagePerSide + 0.01 } })).not.toBe(marketConfigHash(cfg));
    }
    expect(new Set(Object.values(MARKET_CONFIGS).map(marketConfigHash)).size).toBe(4);
    // Pinned: changing a market configuration must bump MARKET_CONFIG_VERSION and update these on purpose.
    expect(Object.fromEntries(Object.values(MARKET_CONFIGS).map((c) => [c.id, marketConfigHash(c).slice(0, 16)]))).toEqual(PINNED_HASHES);
  });
});

const PINNED_HASHES = { CRYPTO: "336f32f33a3bd075", GOLD: "5ee66d2b4d1597f2", FX: "db7bfaeda97feafa", ETF: "f48a4b74b634ff6d" };

describe("no look-ahead", () => {
  it("every HORIZON strategy's decisions on a prefix equal its decisions on the full series (regime included)", () => {
    const times = fxHourlyTimes("2025-01-05T22:00:00Z", 900);
    const full = pathBars(times, 13, { price0: 1.1, sigma: 0.002, plant: { every: 15, jump: 5, drift: 0.8, len: 6 } });
    const prefix = full.slice(0, 600);
    const sf = horizonStrategySpecs({ market: FX, instrument: "EUR/USD", barMs: H, regimeAt: regimeLookup(full, H, FX) });
    const sp = horizonStrategySpecs({ market: FX, instrument: "EUR/USD", barMs: H, regimeAt: regimeLookup(prefix, H, FX) });
    sf.forEach((spec, s) => {
      for (const params of expandGrid(spec.grid)) {
        const a = simulate({ strategy: spec.build!(params), bars: full, startIndex: 0, endIndex: 600, costBpsPerSide: 1 });
        const b = simulate({ strategy: sp[s]!.build!(params), bars: prefix, startIndex: 0, endIndex: 600, costBpsPerSide: 1 });
        expect(b.barReturns).toEqual(a.barReturns);
      }
    });
    const rf = regimeLookup(full, H, FX);
    const rp = regimeLookup(prefix, H, FX);
    for (const b of prefix) expect(rp(b.t)).toEqual(rf(b.t));
  });
});

describe("runHorizonStudy", () => {
  const times = fxHourlyTimes("2024-06-02T22:00:00Z", 4000);
  const planted = pathBars(times, 42, { price0: 1.1, sigma: 0.0015, plant: { every: 40, jump: 6, drift: 1, len: 12 } });

  it("finds a planted edge through walk-forward and a once-evaluated, recorded holdout", () => {
    const gate = createMemoryHoldoutGate();
    const report = runHorizonStudy({ bars: planted, barMs: H, market: FX, instrument: "EUR/USD", datasetKey: "EURUSD|1h", codeVersion: "test", priorTrials: 0, holdoutGate: gate, ml: { enabled: false } });
    const found = report.strategies.filter((s) => s.verdict === "VALIDATED_CANDIDATE");
    expect(found.length, JSON.stringify(report.strategies.map((s) => [s.id, s.verdict, s.reasons]))).toBeGreaterThan(0);
    expect(report.verdict).toBe("CANDIDATE");
    expect(report.holdoutPolicy).toBe("RECORDED_GATE");
    for (const s of found) {
      expect(s.holdout.evaluated).toBe(true);
      expect(gate.consumed.has(`${s.id}|EURUSD|1h`)).toBe(true);
      expect(s.controls.beatsBuyAndHold).toBe(true);
      expect(s.controls.beatsRandom).toBe(true);
    }
    // Only candidates consume a holdout.
    expect(gate.consumed.size).toBe(report.strategies.filter((s) => s.walkForwardPassed).length);
    // Every trial is recorded and counted programme-wide.
    expect(report.programme.runTrials).toBe(report.strategies.reduce((n, s) => n + s.trialCount, 0));
    expect(report.strategies.every((s) => s.trials.length >= s.trialCount)).toBe(true);

    // The same gate refuses a second look.
    const again = runHorizonStudy({ bars: planted, barMs: H, market: FX, instrument: "EUR/USD", datasetKey: "EURUSD|1h", codeVersion: "test", priorTrials: report.programme.total, holdoutGate: gate, ml: { enabled: false } });
    expect(again.strategies.every((s) => !s.holdout.evaluated)).toBe(true);
    expect(again.verdict).not.toBe("CANDIDATE");
  });

  it("withholds the holdout without a recording gate", () => {
    const report = runHorizonStudy({ bars: planted, barMs: H, market: FX, instrument: "EUR/USD", datasetKey: "EURUSD|1h", codeVersion: "test", priorTrials: 0, ml: { enabled: false } });
    expect(report.holdoutPolicy).toBe("WITHHELD_READ_ONLY");
    expect(report.strategies.some((s) => s.verdict === "VALIDATED_CANDIDATE")).toBe(false);
    expect(report.strategies.some((s) => s.walkForwardPassed)).toBe(true);
    expect(report.strategies.every((s) => !s.holdout.evaluated)).toBe(true);
    expect(report.verdict).toBe("CANDIDATE_PENDING_HOLDOUT");
  });

  it("gives NO_SKILL or INSUFFICIENT_EVIDENCE on noise, strategies and ML 2.0 alike", () => {
    const noise = pathBars(fxHourlyTimes("2024-06-02T22:00:00Z", 3000), 7, { price0: 1.1, sigma: 0.0015 });
    const gate = createMemoryHoldoutGate();
    const report = runHorizonStudy({
      bars: noise,
      barMs: H,
      market: FX,
      instrument: "EUR/USD",
      datasetKey: "NOISE|1h",
      codeVersion: "test",
      priorTrials: 500,
      holdoutGate: gate,
      ml: { enabled: true, learners: [{ family: "BASE_RATE" }, { family: "LOGISTIC_L2", params: { lambda: 0.01, iterations: 150, rate: 0.2 } }], config: { bootstrapResamples: 100, randomControls: 50, prefixProbes: 4 } },
    });
    expect(["NO_SKILL", "INSUFFICIENT_EVIDENCE"]).toContain(report.verdict);
    expect(report.strategies.some((s) => s.verdict === "VALIDATED_CANDIDATE")).toBe(false);
    expect(report.ml).toHaveLength(1);
    const ml = report.ml[0]!;
    expect("verdict" in ml && ml.verdict).not.toBe("CANDIDATE");
    expect(report.programme.total).toBe(500 + report.programme.runTrials);
    expect(gate.consumed.size).toBe(report.strategies.filter((s) => s.walkForwardPassed).length);
  });

  it("reports INSUFFICIENT_EVIDENCE below the market's minimum sample", () => {
    const short = pathBars(fxHourlyTimes("2024-06-02T22:00:00Z", 600), 8, { price0: 1.1, sigma: 0.0015 });
    const report = runHorizonStudy({ bars: short, barMs: H, market: FX, instrument: "EUR/USD", datasetKey: "SHORT|1h", codeVersion: "test", priorTrials: 0, ml: { enabled: false } });
    expect(report.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(report.strategies.every((s) => s.verdict === "REJECTED_DATA")).toBe(true);
  });

  it("refuses bars off the market's calendar and rejects bars that arrived after their close", () => {
    const sat = iso("2025-03-08T12:00:00Z");
    const bars = pathBars([...fxHourlyTimes("2025-03-03T00:00:00Z", 50)], 1, { price0: 1.1, sigma: 0.001 });
    const bad = [...bars.filter((b) => b.t < sat), { ...bars.at(-1)!, t: sat }];
    expect(() => runHorizonStudy({ bars: bad, barMs: H, market: FX, instrument: "EUR/USD", datasetKey: "X", codeVersion: "t", priorTrials: 0, ml: { enabled: false } })).toThrow(/OFF_SESSION/);
    const late = runHorizonStudy({ bars, barMs: H, barAvailableAt: bars.map((b, i) => (i === 10 ? b.t + 5 * H : b.t + H)), market: FX, instrument: "EUR/USD", datasetKey: "X", codeVersion: "t", priorTrials: 0, ml: { enabled: false } });
    expect(late.data.lateBars).toBe(1);
    expect(late.strategies.every((s) => s.verdict === "REJECTED_DATA")).toBe(true);
    expect(late.verdict).toBe("REJECTED_DATA");
  });
});
