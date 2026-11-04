import { describe, expect, it } from "vitest";
import { parseBarsCsv, parseMlArgs } from "./ml-args.js";

describe("ml-cli arguments", () => {
  it("parses a warehouse or CSV source and known flags, and refuses anything else", () => {
    const w = parseMlArgs(["ds1", "--horizon", "6", "--scheme", "ROLLING", "--seed", "0"]);
    expect(w).toMatchObject({ datasetId: "ds1", csvPath: null, horizon: 6, scheme: "ROLLING", seed: 0, target: "NET_POSITIVE" });
    const c = parseMlArgs(["--csv", "bars.csv", "--fee-bps", "10", "--slippage-bps", "5", "--interval", "1h"]);
    expect(c).toMatchObject({ datasetId: null, csvPath: "bars.csv", feeBps: 10, slippageBps: 5, interval: "1h" });
    expect(() => parseMlArgs(["--csv", "bars.csv"])).toThrow(/fee-bps/);
    expect(() => parseMlArgs(["ds1", "--csv", "b.csv", "--fee-bps", "1", "--slippage-bps", "1"])).toThrow(/exactly one source/);
    expect(() => parseMlArgs(["ds1", "--record"])).toThrow(/needs a value|unknown option/);
    expect(() => parseMlArgs(["ds1", "--record", "x"])).toThrow(/unknown option/);
    expect(() => parseMlArgs(["ds1", "--horizon", "0"])).toThrow(/positive integer/);
    expect(() => parseMlArgs(["ds1", "--target", "TARGET_BEFORE_STOP"])).toThrow(/stop-pct/);
    expect(() => parseMlArgs(["ds1", "--calibration", "MAGIC"])).toThrow(/must be one of/);
  });

  it("reads time,open,high,low,close,volume without repairing the data", () => {
    const csv = "Time,Open,High,Low,Close,Volume\n0,1,2,0.5,1.5,10\n3600000,1.5,2,1,1.2,\n3600000,1.5,2,1,1.2,3\n2026-01-01T00:00:00Z,1,1,1,1,1\n";
    const bars = parseBarsCsv(csv);
    expect(bars).toHaveLength(4);
    expect(bars[1]!.volume).toBeNull();
    expect(bars[2]!.t).toBe(bars[1]!.t); // duplicate kept for the pipeline to refuse
    expect(bars[3]!.t).toBe(Date.parse("2026-01-01T00:00:00Z"));
    expect(() => parseBarsCsv("time,open,high,low,close\n0,1,1,1,1")).toThrow(/volume/);
    expect(() => parseBarsCsv("time,open,high,low,close,volume\n2026-01-01 00:00,1,1,1,1,1")).toThrow(/line 2/);
    expect(() => parseBarsCsv("time,open,high,low,close,volume\n0,abc,1,1,1,1")).toThrow(/invalid open/);
    expect(bars[0]!.availableAt).toBeNull();
  });

  it("reads an available_at column after time as each bar's availability", () => {
    const csv = "time,available_at,open,high,low,close,volume\n2025-01-02T05:00:00.000Z,2025-01-03T05:00:00.000Z,1,2,0.5,1.5,10\n1735880400000,1735966800000,1.5,2,1,1.2,3\n";
    const bars = parseBarsCsv(csv);
    expect(bars.map((b) => [b.t, b.availableAt])).toEqual([
      [Date.parse("2025-01-02T05:00:00Z"), Date.parse("2025-01-03T05:00:00Z")],
      [1735880400000, 1735966800000],
    ]);
    expect(bars[0]!.open).toBe(1); // columns are read by name, not position
    expect(() => parseBarsCsv("time,available_at,open,high,low,close,volume\n0,,1,1,1,1,1")).toThrow(/available_at is empty/);
    expect(() => parseBarsCsv("time,available_at,open,high,low,close,volume\n0,soon,1,1,1,1,1")).toThrow(/available_at/);
  });

  it("accepts --calendar and leaves it unset by default", () => {
    expect(parseMlArgs(["ds1"]).calendar).toBeNull();
    expect(parseMlArgs(["--csv", "a.csv", "--fee-bps", "1", "--slippage-bps", "2", "--calendar", "US_EQUITY"]).calendar).toBe("US_EQUITY");
    expect(() => parseMlArgs(["ds1", "--calendar", "LSE"])).toThrow(/must be one of/);
    expect(parseMlArgs(["ds1", "--prefix-probes", "24"]).prefixProbes).toBe(24);
    expect(() => parseMlArgs(["ds1", "--prefix-probes", "0"])).toThrow(/positive integer/);
  });
});
