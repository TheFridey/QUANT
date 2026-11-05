import { describe, expect, it } from "vitest";
import { parseHorizonArgs } from "./horizon-args.js";

describe("parseHorizonArgs", () => {
  it("parses a warehouse run with defaults", () => {
    const a = parseHorizonArgs(["ds_1", "--market", "FX"]);
    expect(a).toMatchObject({ datasetId: "ds_1", csvPath: null, market: "FX", instrument: null, priorTrials: null, ml: true, mlHorizons: "PRIMARY", strategies: null });
  });

  it("parses a CSV run with every option", () => {
    const a = parseHorizonArgs(["--csv", "x.csv", "--market", "FX", "--instrument", "USD/JPY", "--prior-trials", "1200", "--interval", "1h", "--ml", "off", "--ml-horizons", "ALL", "--strategies", "hz_atr_breakout, hz_vol_expansion", "--folds", "5", "--seed", "3", "--fee-bps", "0", "--spread", "1.5", "--slippage", "0.3"]);
    expect(a).toMatchObject({ csvPath: "x.csv", market: "FX", instrument: "USD/JPY", priorTrials: 1200, interval: "1h", ml: false, mlHorizons: "ALL", strategies: ["hz_atr_breakout", "hz_vol_expansion"], folds: 5, seed: 3, feeBps: 0, spread: 1.5, slippage: 0.3 });
  });

  it("refuses ambiguous or under-specified runs", () => {
    expect(() => parseHorizonArgs(["ds_1"])).toThrow(/--market is required/);
    expect(() => parseHorizonArgs(["ds_1", "--csv", "x.csv", "--market", "FX"])).toThrow(/exactly one source/);
    expect(() => parseHorizonArgs(["--csv", "x.csv", "--market", "FX", "--prior-trials", "0"])).toThrow(/--instrument/);
    expect(() => parseHorizonArgs(["--csv", "x.csv", "--market", "FX", "--instrument", "EUR/USD"])).toThrow(/--prior-trials/);
    expect(() => parseHorizonArgs(["ds_1", "--market", "BONDS"])).toThrow(/--market must be one of/);
    expect(() => parseHorizonArgs(["ds_1", "--market", "FX", "--prior-trials", "-1"])).toThrow(/integer/);
    expect(() => parseHorizonArgs(["ds_1", "--market", "FX", "--spread", "x"])).toThrow(/non-negative/);
    expect(() => parseHorizonArgs(["ds_1", "--market", "FX", "--holdout", "yes"])).toThrow(/unknown option/);
    expect(() => parseHorizonArgs(["ds_1", "--market"])).toThrow(/needs a value/);
  });
});
