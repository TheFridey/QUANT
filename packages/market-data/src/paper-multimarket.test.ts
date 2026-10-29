import { describe, expect, it } from "vitest";
import {
  buildFixturePairsAtStep,
  buildFixtureSequence,
  buildPaperMultiMarketPairs,
} from "./paper-multimarket.js";

describe("fixture multi-market isolation", () => {
  it("refuses fixed-level inject without explicitFixtureLaunch", () => {
    expect(buildPaperMultiMarketPairs({ now: new Date() })).toEqual([]);
  });

  it("builds realistic sequences with changing mids and no DEX txns for FX/ETF", () => {
    const seq = buildFixtureSequence();
    expect(seq.length).toBeGreaterThan(10);
    const eurusd = seq.filter((t) => t.instrumentId === "fx:EURUSD");
    expect(eurusd[0]!.mid).not.toEqual(eurusd[2]!.mid);
    expect(eurusd.some((t) => t.note === "no-signal")).toBe(true);
    expect(eurusd.some((t) => t.note === "gap-through-stop")).toBe(true);

    const step = buildFixturePairsAtStep({ stepIndex: 2, now: new Date("2026-10-28T15:00:00Z") });
    expect(step.length).toBeGreaterThan(0);
    for (const pair of step) {
      expect(pair.txnsM5Buys).toBeNull();
      expect(pair.txnsM5Sells).toBeNull();
      expect((pair.raw as { tradingEnvironment?: string }).tradingEnvironment).toBe("FIXTURE");
      expect((pair.raw as { dataOrigin?: string }).dataOrigin).toBe("FIXTURE_SEQUENCE");
    }
  });

  it("explicit fixture launch returns entry-signal step pairs", () => {
    const pairs = buildPaperMultiMarketPairs({ explicitFixtureLaunch: true, now: new Date() });
    expect(pairs.some((p) => p.pairAddress === "fx:EURUSD")).toBe(true);
    expect(pairs.every((p) => (p.raw as { provenance?: string }).provenance === "FIXTURE_SEQUENCE")).toBe(
      true,
    );
  });
});
