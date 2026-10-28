import { describe, expect, it } from "vitest";
import { evaluateSession } from "./sessions.js";

describe("market sessions", () => {
  it("keeps crypto open and closes index RTH on weekends", () => {
    const saturday = new Date("2026-10-24T15:00:00.000Z"); // Sat
    expect(evaluateSession({ session: "CRYPTO_24x7", now: saturday }).status).toBe("OPEN");
    expect(evaluateSession({ session: "INDEX_RTH", now: saturday }).status).toBe("CLOSED");
    expect(evaluateSession({ session: "FX_WEEKDAY", now: saturday }).status).toBe("CLOSED");
  });

  it("opens index RTH around a weekday lunch in ET", () => {
    // Wednesday 2026-10-28 16:00 UTC = 12:00 ET (EDT)
    const weekday = new Date("2026-10-28T16:00:00.000Z");
    expect(evaluateSession({ session: "INDEX_RTH", now: weekday }).status).toBe("OPEN");
    expect(evaluateSession({ session: "FX_WEEKDAY", now: weekday }).status).toBe("OPEN");
  });
});
