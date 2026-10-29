import { describe, expect, it } from "vitest";
import { MarketDataGateway } from "./gateway.js";
import { AlpacaPaperProvider } from "./providers/alpaca-paper.js";
import { FrankfurterFxProvider } from "./providers/frankfurter-fx.js";
import { OandaPracticeProvider } from "./providers/oanda-practice.js";

describe("MarketDataGateway", () => {
  it("routes FX to Frankfurter when OANDA is not READY; ETF to Alpaca", async () => {
    const gateway = new MarketDataGateway({
      frankfurter: new FrankfurterFxProvider({
        now: () => new Date("2026-10-28T16:00:00.000Z"),
        fetchImpl: async () =>
          Response.json({ rates: { USD: 1.085 }, date: "2026-10-28" }),
      }),
      alpaca: new AlpacaPaperProvider(
        {
          apiKeyPresent: false,
          apiSecretPresent: false,
          baseUrl: "https://paper-api.alpaca.markets",
          dataUrl: "https://data.alpaca.markets",
        },
        { now: () => new Date("2026-10-28T16:00:00.000Z") },
      ),
      oanda: new OandaPracticeProvider(
        {
          tokenPresent: false,
          accountIdPresent: false,
          apiUrl: "https://api-fxpractice.oanda.com",
          accountId: "",
        },
        { now: () => new Date("2026-10-28T16:00:00.000Z") },
      ),
    });

    const readiness = gateway.readiness();
    expect(readiness.frankfurter_fx).toBe("READY");
    expect(readiness.alpaca_paper).toBe("MISSING_CREDENTIALS");
    expect(readiness.oanda_practice).toBe("MISSING_CREDENTIALS");

    const fx = await gateway.getQuotes(["fx:EURUSD"]);
    expect(fx.ok).toBe(true);
    if (fx.ok) {
      expect(fx.data[0]?.providerId).toBe("frankfurter_fx");
      expect(fx.data[0]?.level).not.toBeNull();
      expect(fx.data[0]?.dataState).toBe("DELAYED");
    }

    const etf = await gateway.getQuotes(["etf:SPY"]);
    // Alpaca missing credentials → soft-fail, no invented SPY level.
    expect(etf.ok).toBe(false);

    const spec = gateway.buildOrderSpec("etf:SPY", "BUY");
    expect(spec.allowed).toBe(false);
    expect(spec.reasonCodes).toContain("MISSING_CREDENTIALS");
  });

  it("fromEnv builds without throwing when credentials absent", () => {
    const gateway = MarketDataGateway.fromEnv({});
    expect(gateway.readiness().alpaca_paper).toBe("MISSING_CREDENTIALS");
  });
});
