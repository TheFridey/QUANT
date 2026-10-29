import { describe, expect, it } from "vitest";
import {
  checkRowEnvironmentIsolation,
  freshnessFromProvenance,
  inferObservationProvenance,
} from "./observation-origin.js";

describe("observation origin (R09)", () => {
  it("treats Frankfurter delayed FX as DELAYED_FEED not FIXTURE", () => {
    const provenance = inferObservationProvenance({
      source: "fx_stub",
      raw: {
        dataOrigin: "DELAYED_FEED",
        providerId: "frankfurter_fx",
        dataState: "DELAYED",
      },
    });
    expect(provenance.dataOrigin).toBe("DELAYED_FEED");
    expect(freshnessFromProvenance(provenance, "DEMO")).toBe("DELAYED");
    expect(checkRowEnvironmentIsolation(provenance, "MARKET_DATA_PAPER").ok).toBe(true);
  });

  it("still blocks true fixture rows from MARKET_DATA_PAPER", () => {
    const provenance = inferObservationProvenance({
      source: "fx_stub",
      raw: { dataOrigin: "FIXTURE_SEQUENCE" },
    });
    expect(provenance.dataOrigin).toBe("FIXTURE_SEQUENCE");
    const blocked = checkRowEnvironmentIsolation(provenance, "MARKET_DATA_PAPER");
    expect(blocked.ok).toBe(false);
  });

  it("scopes isolation per row — delayed ok while fixture fails independently", () => {
    const delayed = inferObservationProvenance({
      source: "fx_stub",
      raw: { dataOrigin: "DELAYED_FEED", providerId: "frankfurter_fx" },
    });
    const fixture = inferObservationProvenance({
      source: "etf_stub",
      raw: { dataOrigin: "FIXTURE_SEQUENCE" },
    });
    expect(checkRowEnvironmentIsolation(delayed, "MARKET_DATA_PAPER").ok).toBe(true);
    expect(checkRowEnvironmentIsolation(fixture, "MARKET_DATA_PAPER").ok).toBe(false);
  });
});
