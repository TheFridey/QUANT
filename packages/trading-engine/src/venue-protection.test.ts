import { describe, expect, it } from "vitest";
import {
  alpacaBracketOrderFields,
  amendVenueProtectionDesire,
  applyVenueProtectionAck,
  compareDesiredVsConfirmed,
  desireSyntheticProtection,
  desireVenueProtection,
  markVenueProtectionSubmitted,
  oandaProtectiveOrderSpecs,
  transitionOrderAck,
  venueProtectionCapability,
} from "./venue-protection.js";

describe("venue-native protection desired vs ack", () => {
  it("documents Alpaca bracket + OANDA stop capabilities without inventing ACK", () => {
    const alpaca = venueProtectionCapability("alpaca_paper");
    expect(alpaca.supportsNativeOco).toBe(true);
    expect(alpaca.supportsNativeStop).toBe(true);
    const oanda = venueProtectionCapability("oanda_practice");
    expect(oanda.supportsNativeStop).toBe(true);
    expect(oanda.supportsNativeOco).toBe(false);
  });

  it("starts DESIRED_ONLY and only ACKED with venue order id", () => {
    const desire = desireVenueProtection({
      id: "vp1",
      providerId: "alpaca_paper",
      instrumentId: "etf:SPY",
      stopPrice: "95",
      takeProfitPrice: "110",
      qty: "10",
    });
    expect(desire.ackState).toBe("DESIRED_ONLY");
    expect(desire.origin).toBe("VENUE_NATIVE");

    const submitted = markVenueProtectionSubmitted(desire);
    expect(submitted.ackState).toBe("SUBMITTED");

    const rejected = applyVenueProtectionAck(submitted, { ok: false, error: "MISSING_CREDENTIALS" });
    expect(rejected.ackState).toBe("REJECTED");
    expect(rejected.lastConfirmedStopPrice).toBeNull();

    const acked = applyVenueProtectionAck(submitted, {
      ok: true,
      venueOrderId: "alpaca-ord-1",
      stopPrice: "95",
      takeProfitPrice: "110",
    });
    expect(acked.ackState).toBe("ACKED");
    expect(acked.lastConfirmedStopPrice).toBe("95");

    const invent = applyVenueProtectionAck(submitted, { ok: true, venueOrderId: "" });
    expect(invent.ackState).toBe("REJECTED");
  });

  it("amendment failure keeps last confirmed protection", () => {
    let desire = desireVenueProtection({
      id: "vp2",
      providerId: "oanda_practice",
      instrumentId: "fx:EURUSD",
      stopPrice: "1.08",
      takeProfitPrice: "1.12",
      qty: "1000",
    });
    desire = applyVenueProtectionAck(desire, {
      ok: true,
      venueOrderId: "oanda-1",
      stopPrice: "1.08",
      takeProfitPrice: "1.12",
    });
    const failed = amendVenueProtectionDesire(
      desire,
      { stopPrice: "1.07" },
      { ok: false, error: "VENUE_REJECT" },
    );
    expect(failed.stopPrice).toBe("1.08");
    expect(failed.lastConfirmedStopPrice).toBe("1.08");
    expect(failed.ackState).toBe("ACKED");
    expect(failed.lastError).toBe("VENUE_REJECT");
  });

  it("builds Alpaca bracket fields and OANDA protective specs from desire", () => {
    const desire = desireVenueProtection({
      id: "vp3",
      providerId: "alpaca_paper",
      instrumentId: "etf:QQQ",
      stopPrice: "400",
      takeProfitPrice: "450",
      qty: "2",
    });
    const fields = alpacaBracketOrderFields(desire);
    expect(fields.order_class).toBe("bracket");
    expect(fields.stop_loss?.stop_price).toBe("400");

    const oandaDesire = desireVenueProtection({
      id: "vp4",
      providerId: "oanda_practice",
      instrumentId: "fx:GBPUSD",
      stopPrice: "1.20",
      takeProfitPrice: "1.30",
      qty: "1000",
    });
    expect(oandaProtectiveOrderSpecs(oandaDesire)).toEqual([
      { type: "STOP_LOSS", price: "1.20" },
      { type: "TAKE_PROFIT", price: "1.30" },
    ]);
  });

  it("compares desired vs confirmed without inventing venue success", () => {
    let desire = desireVenueProtection({
      id: "vp5",
      providerId: "alpaca_paper",
      instrumentId: "etf:SPY",
      stopPrice: "500",
      takeProfitPrice: "540",
      qty: "1",
    });
    const desiredOnly = compareDesiredVsConfirmed(desire);
    expect(desiredOnly.venueConfirmed).toBe(false);
    expect(desiredOnly.ackState).toBe("DESIRED_ONLY");

    desire = markVenueProtectionSubmitted(desire);
    expect(compareDesiredVsConfirmed(desire).venueConfirmed).toBe(false);

    desire = applyVenueProtectionAck(desire, {
      ok: true,
      venueOrderId: "alpaca-99",
      stopPrice: "500",
      takeProfitPrice: "540",
    });
    const acked = compareDesiredVsConfirmed(desire);
    expect(acked.venueConfirmed).toBe(true);
    expect(acked.isVenueNative).toBe(true);

    // Synthetic helper never counts as venue-confirmed even when locally armed.
    const synthetic = desireSyntheticProtection({
      id: "syn1",
      instrumentId: "fx:EURUSD",
      stopPrice: "1.08",
      takeProfitPrice: "1.12",
      qty: "1000",
    });
    const synReport = compareDesiredVsConfirmed(synthetic);
    expect(synReport.venueConfirmed).toBe(false);
    expect(synReport.isVenueNative).toBe(false);
  });

  it("models durable order ack transitions offline without inventing fill success", () => {
    expect(transitionOrderAck("NEW", "submit")).toBe("SUBMITTED");
    expect(transitionOrderAck("SUBMITTED", "ack")).toBe("ACKED");
    expect(transitionOrderAck("ACKED", "fill")).toBe("FILLED");
    const invalid = transitionOrderAck("FILLED", "ack");
    expect(invalid).toEqual({ ok: false, reason: "INVALID_TRANSITION:FILLED+ack" });
    expect(transitionOrderAck("SUBMITTED", "reject")).toBe("REJECTED");
  });
});
