import { describe, expect, it } from "vitest";
import {
  isAutomaticEntryEnabled,
  marketSelectionMap,
  resolveMarketInstrumentId,
} from "./market-admission.js";

describe("market admission (D15)", () => {
  it("maps Solana discovery pairs to the universe instrument", () => {
    expect(
      resolveMarketInstrumentId({
        pairAddress: "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE",
        chainId: "solana",
      }),
    ).toBe("solana:spot:universe");
    expect(resolveMarketInstrumentId({ pairAddress: "fx:EURUSD" })).toBe("fx:EURUSD");
    expect(resolveMarketInstrumentId({ pairAddress: "etf:SPY" })).toBe("etf:SPY");
  });

  it("blocks automatic ENTRY when the market is disabled and leaves ungated when map is absent", () => {
    const enabled = marketSelectionMap([
      { instrumentId: "solana:spot:universe", enabled: false },
      { instrumentId: "fx:EURUSD", enabled: true },
    ]);
    expect(
      isAutomaticEntryEnabled(
        { pairAddress: "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE", chainId: "solana" },
        enabled,
      ),
    ).toBe(false);
    expect(isAutomaticEntryEnabled({ pairAddress: "fx:EURUSD" }, enabled)).toBe(true);
    expect(
      isAutomaticEntryEnabled(
        { pairAddress: "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE" },
        null,
      ),
    ).toBe(true);
  });
});
