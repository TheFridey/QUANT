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
  });
});
