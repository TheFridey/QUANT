import { describe, expect, it } from "vitest";
import { attributeNetPerformance } from "./attribution.js";

describe("instance-level net performance attribution (C37)", () => {
  it("attributes net PnL and fees per strategy instance", () => {
    const report = attributeNetPerformance([
      { strategyInstanceId: "pulse-crypto", realizedPnlUsd: "10", feeUsd: "0.5" },
      { strategyInstanceId: "pulse-crypto", realizedPnlUsd: "-2", feeUsd: "0.2" },
      { strategyInstanceId: "fx-mean", realizedPnlUsd: "4", feeUsd: "0.1" },
      { strategyInstanceId: null, realizedPnlUsd: "1", feeUsd: "0.05" },
    ]);
    expect(report.sampleSize).toBe(4);
    expect(report.portfolioGrossPnlUsd).toBe("13.00000000");
    expect(report.portfolioFeesUsd).toBe("0.85000000");
    expect(report.portfolioNetPnlUsd).toBe("12.15000000");

    const crypto = report.instances.find((r) => r.strategyInstanceId === "pulse-crypto")!;
    expect(crypto.trades).toBe(2);
    expect(crypto.wins).toBe(1);
    expect(crypto.losses).toBe(1);
    expect(crypto.netPnlUsd).toBe("7.30000000");

    const fx = report.instances.find((r) => r.strategyInstanceId === "fx-mean")!;
    expect(fx.netPnlUsd).toBe("3.90000000");
    expect(report.unattributed.trades).toBe(1);
    expect(Number(crypto.netShare)).toBeGreaterThan(Number(fx.netShare));
  });

  it("handles empty fills without inventing performance", () => {
    const report = attributeNetPerformance([]);
    expect(report.sampleSize).toBe(0);
    expect(report.instances).toEqual([]);
    expect(report.portfolioNetPnlUsd).toBe("0.00000000");
    expect(report.unattributed.winRate).toBeNull();
  });
});
