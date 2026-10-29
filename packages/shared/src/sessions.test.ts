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
