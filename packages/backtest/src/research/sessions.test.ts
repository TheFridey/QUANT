import { describe, expect, it } from "vitest";
import { seededRng } from "../stats.js";
import { validateResearchBars } from "./feature-set.js";
import { buildTradeLabels } from "./labels.js";
import { runMlPipeline } from "./ml2.js";
import { isContiguous, nyseHolidays } from "./sessions.js";
import type { ResearchBar } from "./simulate.js";

const D = 86_400_000;

/**
 * Independent fixture clock (not the code under test): US DST runs from the second Sunday of March to the first
 * Sunday of November. A New York midnight is still EST on the spring-forward day and still EDT on fall-back day.
 */
function nyMidnightUtc(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const sunday = (month: number, n: number) => {
    const first = new Date(Date.UTC(y, month - 1, 1)).getUTCDay();
    return 1 + ((7 - first) % 7) + 7 * (n - 1);
  };
  const t = Date.UTC(y, m - 1, d);
  const edt = t > Date.UTC(y, 2, sunday(3, 2)) && t <= Date.UTC(y, 10, sunday(11, 1));
  return t + (edt ? 4 : 5) * 3_600_000;
}

const HOLIDAYS = new Set(["2024-11-28", "2024-12-25", "2025-01-01", "2025-01-09", "2025-01-20", "2025-02-17", "2025-04-18"]);

function sessionDates(from: string, to: string, holidays: (ymd: string) => boolean): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += D) {
    const ymd = new Date(t).toISOString().slice(0, 10);
    const w = new Date(t).getUTCDay();
    if (w !== 0 && w !== 6 && !holidays(ymd)) out.push(ymd);
  }
  return out;
}

function dailyBars(dates: string[], seed: number): ResearchBar[] {
  const rng = seededRng(seed);
  let p = 400;
  return dates.map((ymd) => {
    const open = p;
    p *= Math.exp(0.012 * (rng() - 0.5) * 3);
    return { t: nyMidnightUtc(ymd), open, high: Math.max(open, p) * 1.002, low: Math.min(open, p) * 0.998, close: p, volume: 1e6 * (1 + rng()) };
  });
}

describe("US equity session calendar (GENESIS-4 defect: NY-midnight daily bars)", () => {
  // Oct 2024 – Apr 2025: crosses the 3 Nov 2024 and 9 Mar 2025 DST changes, weekends and seven NYSE closures.
  const dates = sessionDates("2024-10-01", "2025-04-30", (d) => HOLIDAYS.has(d));
  const bars = dailyBars(dates, 1);

  it("computes the NYSE full-day closures", () => {
    expect([...nyseHolidays(2025)].sort()).toEqual(["2025-01-01", "2025-01-09", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25"]);
    expect(nyseHolidays(2022).has("2021-12-31")).toBe(false); // New Year's Day on a Saturday is not observed
    expect(nyseHolidays(2021).has("2021-12-24")).toBe(true); // Christmas on a Saturday → Friday
  });

  it("accepts a DST-crossing New York-midnight daily series with weekends and holidays", () => {
    expect(new Set(bars.map((b) => new Date(b.t).getUTCHours()))).toEqual(new Set([4, 5]));
    expect(validateResearchBars(bars, { barMs: D, calendar: "US_EQUITY" })).toEqual([]);
    // The fixed UTC grid is what produced the defect.
    expect(validateResearchBars(bars, { barMs: D }).some((i) => i.code === "MISALIGNED")).toBe(true);
  });

  it("still refuses a genuinely misaligned bar, and bars on a weekend or holiday", () => {
    const shifted = bars.map((b, i) => (i === 40 ? { ...b, t: b.t + 3_600_000 } : b));
    const issues = validateResearchBars(shifted, { barMs: D, calendar: "US_EQUITY" });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ index: 40, code: "MISALIGNED" });
    const k = dates.indexOf("2024-11-29");
    const holiday = [...bars.slice(0, k), { ...bars[k]!, t: nyMidnightUtc("2024-11-28") }, ...bars.slice(k)];
    expect(validateResearchBars(holiday, { barMs: D, calendar: "US_EQUITY" }).map((i) => i.code)).toContain("OFF_SESSION");
    const s = dates.indexOf("2024-10-07");
    const saturday = [...bars.slice(0, s), { ...bars[s]!, t: nyMidnightUtc("2024-10-05") }, ...bars.slice(s)];
    expect(validateResearchBars(saturday, { barMs: D, calendar: "US_EQUITY" }).map((i) => i.code)).toContain("OFF_SESSION");
    expect(() => runMlPipeline({ bars: shifted, barMs: D, calendar: "US_EQUITY", labelSpec: { horizon: 5, feeBpsPerSide: 1, slippageBpsPerSide: 2 } })).toThrow(/REFUSED: .*MISALIGNED/);
  });

  it("labels span weekends and holidays but not a missing trading day", () => {
    const next = (a: ResearchBar, b: ResearchBar) => isContiguous(a.t, b.t, D, "US_EQUITY");
    const labels = buildTradeLabels(bars, { horizon: 2, feeBpsPerSide: 0, slippageBpsPerSide: 0 }, { barMs: D, isContiguous: next });
    const wedBeforeThanksgiving = dates.indexOf("2024-11-27");
    expect(labels[wedBeforeThanksgiving]).not.toBeNull(); // 27 Nov → 29 Nov → 2 Dec
    expect(labels[dates.indexOf("2024-11-01")]).not.toBeNull(); // crosses the DST change
    // Drop 10 Dec 2024 (a trading day): labels whose window includes it are null.
    const missing = dates.indexOf("2024-12-10");
    const gapped = [...bars.slice(0, missing), ...bars.slice(missing + 1)];
    const g = buildTradeLabels(gapped, { horizon: 2, feeBpsPerSide: 0, slippageBpsPerSide: 0 }, { barMs: D, isContiguous: next });
    expect(g[missing - 1]).toBeNull(); // 9 Dec would span 9 → 11 Dec
    expect(g[missing - 2]).toBeNull();
    expect(g[missing]).not.toBeNull(); // 11 Dec onwards is contiguous again
  });

  it("runs the pipeline on a US_EQUITY series the UTC grid refuses, and honours bar availability", () => {
    const long = dailyBars(sessionDates("2018-01-02", "2025-06-30", (d) => nyseHolidays(Number(d.slice(0, 4))).has(d)), 2);
    const spec = { horizon: 5, feeBpsPerSide: 1, slippageBpsPerSide: 2 };
    expect(() => runMlPipeline({ bars: long, barMs: D, labelSpec: spec })).toThrow(/MISALIGNED.*US_EQUITY calendar/);
    const report = runMlPipeline({ bars: long, barMs: D, calendar: "US_EQUITY", labelSpec: spec, barAvailableAt: long.map((b) => b.t + D) });
    expect(report.calendar).toBe("US_EQUITY");
    expect(report.data.labelled).toBeGreaterThan(long.length * 0.9);
    // A bar published after its decision time makes the feature row reading it unavailable at decision: refused.
    const late = long.map((b, i) => b.t + D + (i === 1500 ? 3_600_000 : 0));
    expect(() => runMlPipeline({ bars: long, barMs: D, calendar: "US_EQUITY", labelSpec: spec, barAvailableAt: late })).toThrow(/available after the decision time/);
    // Availability before the bar closes is itself invalid.
    const early = long.map((b, i) => b.t + D - (i === 10 ? 1 : 0));
    expect(() => runMlPipeline({ bars: long, barMs: D, calendar: "US_EQUITY", labelSpec: spec, barAvailableAt: early })).toThrow(/BAD_AVAILABILITY/);
  }, 120_000);
});
