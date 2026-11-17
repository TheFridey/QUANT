import { describe, expect, it } from "vitest";
import { entriesAllowedInSession, evaluateSession, isUsEquityHoliday } from "./sessions.js";

describe("market sessions", () => {
  it("keeps crypto open and closes index RTH on weekends", () => {
    const saturday = new Date("2026-10-24T15:00:00.000Z"); // Sat
    expect(evaluateSession({ session: "CRYPTO_24x7", now: saturday }).status).toBe("OPEN");
    expect(evaluateSession({ session: "INDEX_RTH", now: saturday }).status).toBe("CLOSED");
    expect(evaluateSession({ session: "FX_WEEKDAY", now: saturday }).reason).toBe("FX_WEEKEND");
  });

  it("opens index RTH around a weekday lunch in ET", () => {
    // Wednesday 2026-10-28 16:00 UTC = 12:00 ET (EDT)
    const weekday = new Date("2026-10-28T16:00:00.000Z");
    expect(evaluateSession({ session: "INDEX_RTH", now: weekday }).status).toBe("OPEN");
    expect(evaluateSession({ session: "FX_WEEKDAY", now: weekday }).status).toBe("OPEN");
    expect(evaluateSession({ session: "INDEX_RTH", now: weekday }).dstActive).toBe(true);
  });

  it("closes FX from Friday 17:00 ET through Sunday before 17:00 ET", () => {
    // Fri 2026-10-23 21:00 UTC = 17:00 EDT → FX closed
    const friClose = new Date("2026-10-23T21:00:00.000Z");
    expect(evaluateSession({ session: "FX_WEEKDAY", now: friClose }).status).toBe("CLOSED");
    expect(evaluateSession({ session: "FX_WEEKDAY", now: friClose }).reason).toBe("FX_WEEKEND");

    // Sat midday
    const sat = new Date("2026-10-24T16:00:00.000Z");
    expect(evaluateSession({ session: "FX_WEEKDAY", now: sat }).status).toBe("CLOSED");

    // Sun 2026-10-25 20:00 UTC = 16:00 EDT → still closed
    const sunBefore = new Date("2026-10-25T20:00:00.000Z");
    expect(evaluateSession({ session: "FX_WEEKDAY", now: sunBefore }).status).toBe("CLOSED");

    // Sun 2026-10-25 21:00 UTC = 17:00 EDT → open
    const sunOpen = new Date("2026-10-25T21:00:00.000Z");
    expect(evaluateSession({ session: "FX_WEEKDAY", now: sunOpen }).status).toBe("OPEN");
    expect(evaluateSession({ session: "FX_WEEKDAY", now: sunOpen }).reason).toBe("FX_WEEKDAY");
  });

  it("closes INDEX_RTH on US equity holidays and keeps FX open on those weekdays", () => {
    // Thanksgiving 2026-11-26 Thursday — midday ET
    const thanksgiving = new Date("2026-11-26T17:00:00.000Z"); // 12:00 EST
    expect(isUsEquityHoliday("2026-11-26")).toBe(true);
    const equity = evaluateSession({ session: "INDEX_RTH", now: thanksgiving });
    expect(equity.status).toBe("CLOSED");
    expect(equity.reason).toBe("US_EQUITY_HOLIDAY");
    expect(equity.dstActive).toBe(false); // EST after DST end
    // FX still weekday-open on Thanksgiving (FX does not follow NYSE holidays in this MVP model).
    expect(evaluateSession({ session: "FX_WEEKDAY", now: thanksgiving }).status).toBe("OPEN");
    expect(entriesAllowedInSession("INDEX_EXTENDED", thanksgiving)).toBe(false);
  });

  it("respects DST boundary: EST winter RTH vs EDT summer RTH at same UTC clock", () => {
    // 14:30 UTC = 09:30 EST (Jan) → RTH open; 14:30 UTC = 10:30 EDT (Jul) → RTH open both.
    // Use 14:00 UTC: Jan = 09:00 EST CLOSED; Jul = 10:00 EDT OPEN.
    const winter = new Date("2026-01-14T14:00:00.000Z");
    const summer = new Date("2026-07-15T14:00:00.000Z");
    const winterEval = evaluateSession({ session: "INDEX_RTH", now: winter });
    const summerEval = evaluateSession({ session: "INDEX_RTH", now: summer });
    expect(winterEval.dstActive).toBe(false);
    expect(summerEval.dstActive).toBe(true);
    expect(winterEval.status).toBe("CLOSED"); // 09:00 EST — before 09:30
    expect(summerEval.status).toBe("OPEN"); // 10:00 EDT
    expect(winterEval.etDate).toBe("2026-01-14");
    expect(summerEval.etDate).toBe("2026-07-15");
  });

  it("opens INDEX_EXTENDED premarket and closes after 20:00 ET", () => {
    // Wed 2026-10-28 09:00 UTC = 05:00 EDT → extended open, RTH closed
    const premarket = new Date("2026-10-28T09:00:00.000Z");
    expect(evaluateSession({ session: "INDEX_EXTENDED", now: premarket }).status).toBe("OPEN");
    expect(evaluateSession({ session: "INDEX_RTH", now: premarket }).status).toBe("CLOSED");
    // 01:00 UTC next day = 21:00 EDT Wed → both closed
    const afterHours = new Date("2026-10-29T01:00:00.000Z");
    expect(evaluateSession({ session: "INDEX_EXTENDED", now: afterHours }).status).toBe("CLOSED");
  });
});

describe("HORIZON Phase II session corrections", () => {
  const at = (iso: string, session: Parameters<typeof evaluateSession>[0]["session"]) => evaluateSession({ session, now: new Date(iso) });

  it("closes RTH at 13:00 ET on an NYSE early-close day (day after Thanksgiving 2026, EST)", () => {
    expect(at("2026-11-27T17:59:00Z", "INDEX_RTH")).toMatchObject({ status: "OPEN", reason: "INDEX_RTH" }); // 12:59 ET
    expect(at("2026-11-27T18:00:00Z", "INDEX_RTH")).toMatchObject({ status: "CLOSED", reason: "US_EQUITY_EARLY_CLOSE" }); // 13:00 ET
    expect(at("2026-11-27T21:30:00Z", "INDEX_RTH")).toMatchObject({ status: "CLOSED", reason: "OUTSIDE_RTH" }); // 16:30 ET
    expect(at("2026-11-27T21:59:00Z", "INDEX_EXTENDED").status).toBe("OPEN"); // 16:59 ET
    expect(at("2026-11-27T22:00:00Z", "INDEX_EXTENDED").status).toBe("CLOSED"); // 17:00 ET
  });

  it("closes early on the day before Independence Day 2025 (EDT)", () => {
    expect(at("2025-07-03T16:59:00Z", "INDEX_RTH").status).toBe("OPEN"); // 12:59 EDT
    expect(at("2025-07-03T17:00:00Z", "INDEX_RTH").reason).toBe("US_EQUITY_EARLY_CLOSE");
  });

  it("leaves a normal day unchanged", () => {
    expect(at("2026-11-17T20:59:00Z", "INDEX_RTH").status).toBe("OPEN"); // 15:59 ET
    expect(at("2026-11-17T21:00:00Z", "INDEX_RTH").status).toBe("CLOSED");
  });

  it("is UNKNOWN (fail closed) for equity years without a holiday table", () => {
    expect(at("2028-03-15T15:00:00Z", "INDEX_RTH")).toMatchObject({ status: "UNKNOWN", reason: "US_EQUITY_CALENDAR_NOT_COVERED" });
    expect(entriesAllowedInSession("INDEX_EXTENDED", new Date("2024-03-15T15:00:00Z"))).toBe(false);
    // Weekends are still plainly closed.
    expect(at("2028-03-18T15:00:00Z", "INDEX_RTH").status).toBe("CLOSED");
    // Crypto and FX do not depend on the equity table.
    expect(at("2028-03-15T15:00:00Z", "CRYPTO_24x7").status).toBe("OPEN");
    expect(at("2028-03-15T15:00:00Z", "FX_WEEKDAY").status).toBe("OPEN");
  });

  it("models the metals/energy CFD daily break and weekend in New York time across DST", () => {
    // Tuesday 17 Nov 2026 (EST, UTC-5)
    expect(at("2026-11-17T21:59:00Z", "METALS_ENERGY_CFD").status).toBe("OPEN"); // 16:59 ET
    expect(at("2026-11-17T22:00:00Z", "METALS_ENERGY_CFD")).toMatchObject({ status: "CLOSED", reason: "CFD_DAILY_BREAK" });
    expect(at("2026-11-17T22:59:00Z", "METALS_ENERGY_CFD").reason).toBe("CFD_DAILY_BREAK");
    expect(at("2026-11-17T23:00:00Z", "METALS_ENERGY_CFD").status).toBe("OPEN"); // 18:00 ET
    // Summer (EDT, UTC-4): the break moves to 21:00-22:00 UTC.
    expect(at("2026-07-14T21:30:00Z", "METALS_ENERGY_CFD").reason).toBe("CFD_DAILY_BREAK");
    expect(at("2026-07-14T22:00:00Z", "METALS_ENERGY_CFD").status).toBe("OPEN");
    // Friday close, Saturday, Sunday before 18:00 ET, Sunday open.
    expect(at("2026-11-20T21:59:00Z", "METALS_ENERGY_CFD").status).toBe("OPEN");
    expect(at("2026-11-20T22:00:00Z", "METALS_ENERGY_CFD").reason).toBe("CFD_WEEKEND");
    expect(at("2026-11-21T15:00:00Z", "METALS_ENERGY_CFD").reason).toBe("CFD_WEEKEND");
    expect(at("2026-11-22T22:59:00Z", "METALS_ENERGY_CFD").reason).toBe("CFD_WEEKEND"); // Sun 17:59 ET
    expect(at("2026-11-22T23:00:00Z", "METALS_ENERGY_CFD").status).toBe("OPEN"); // Sun 18:00 ET
  });
});
