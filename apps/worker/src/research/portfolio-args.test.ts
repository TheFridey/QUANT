import { describe, expect, it } from "vitest";
import { defaultRebalanceBars, parseArgs } from "./portfolio-args.js";

describe("portfolio-cli arguments", () => {
  it("parses dataset ids and known flags, and refuses anything else", () => {
    expect(parseArgs(["a", "--lookback", "90", "b", "--rebalance", "24"])).toEqual({ datasetIds: ["a", "b"], flags: { "--lookback": 90, "--rebalance": 24 } });
    expect(() => parseArgs(["a", "b", "--record"])).toThrow(/unknown option/);
    expect(() => parseArgs(["a", "b", "--lookback=90"])).toThrow(/unknown option/);
    expect(() => parseArgs(["a", "b", "--lookback", "x"])).toThrow(/positive integer/);
  });

  it("derives about a month of bars from the interval", () => {
    expect(defaultRebalanceBars(3_600_000, "CONTINUOUS")).toBe(720);
    expect(defaultRebalanceBars(86_400_000, "CONTINUOUS")).toBe(30);
    expect(defaultRebalanceBars(300_000, "CONTINUOUS")).toBe(8640);
    expect(defaultRebalanceBars(86_400_000, "WEEKDAYS")).toBe(21);
  });
});
