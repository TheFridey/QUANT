import { describe, expect, it, vi } from "vitest";
import {
  createAbortDeadline,
  fetchMandatoryMarks,
  routeHeldTarget,
  selectFairSlice,
} from "./held-refresh.js";

describe("held refresh routing + fairness (D08)", () => {
  it("routes by instrument prefix", () => {
    expect(routeHeldTarget("So11111111111111111111111111111111111111112")).toBe("solana_dex");
    expect(routeHeldTarget("fx:EURUSD")).toBe("fx");
    expect(routeHeldTarget("etf:SPY")).toBe("etf");
    expect(routeHeldTarget("commodity:XAUUSD")).toBe("commodity");
    expect(routeHeldTarget("index:SPX")).toBe("index");
    expect(routeHeldTarget("weird:thing")).toBe("unknown");
  });

  it("fair slice rotates beyond silent 20-cap without permanent drop", () => {
    const items = Array.from({ length: 50 }, (_, i) => `t${i}`);
    const first = selectFairSlice(items, 20, 0);
    expect(first.selected).toHaveLength(20);
    expect(first.deferred).toHaveLength(30);
    expect(first.selected[0]).toBe("t0");
    expect(first.nextOffset).toBe(20);

    const second = selectFairSlice(items, 20, first.nextOffset);
    expect(second.selected[0]).toBe("t20");
    expect(second.selected).toContain("t39");
    expect(second.selected).not.toContain("t0");

    const third = selectFairSlice(items, 20, second.nextOffset);
    expect(third.selected).toContain("t40");
    expect(third.selected).toContain("t0"); // wraps
    const seen = new Set([...first.selected, ...second.selected, ...third.selected]);
    expect(seen.size).toBe(50);
  });

  it("refreshes non-Solana held targets via injected quote router without awaiting discovery", async () => {
    const quotesCalled: string[][] = [];
    const result = await fetchMandatoryMarks({
      targets: [
        { pairAddress: "fx:EURUSD" },
        { pairAddress: "etf:SPY" },
        { pairAddress: "solMissing1111111111111111111111111111111", baseAddress: null },
      ],
      now: new Date("2026-10-28T16:00:00.000Z"),
      timeoutMs: 2_000,
      fetchImpl: async () => {
        // Slow/failing solana — must not block multi-market path completion semantics.
        await new Promise((r) => setTimeout(r, 5));
        return new Response("{}", { status: 500 });
      },
      fetchQuotes: async (ids) => {
        quotesCalled.push(ids);
        return {
          ok: true,
          fetchedAt: "2026-10-28T16:00:00.000Z",
          data: ids.map((id) => ({
            instrumentId: id,
            symbol: id.split(":")[1] ?? id,
            level: id.startsWith("fx:") ? "1.08500000" : "520.10000000",
            currency: "USD",
            dataState: "DELAYED" as const,
            provenance: "test",
            session: "OPEN" as const,
            receivedAt: "2026-10-28T16:00:00.000Z",
            providerId: id.startsWith("fx:") ? ("frankfurter_fx" as const) : ("alpaca_paper" as const),
            bid: id.startsWith("fx:") ? "1.0849" : "520.00",
            ask: id.startsWith("fx:") ? "1.0851" : "520.20",
            eventTime: "2026-10-28T16:00:00.000Z",
          })),
        };
      },
    });

    expect(quotesCalled).toEqual([["fx:EURUSD", "etf:SPY"]]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fetchedAddresses.sort()).toEqual(["etf:SPY", "fx:EURUSD"]);
      expect(result.missing.some((m) => m.startsWith("solMissing"))).toBe(true);
      expect(result.coverage.find((c) => c.pairAddress === "fx:EURUSD")?.route).toBe("fx");
      expect(result.coverage.find((c) => c.pairAddress === "fx:EURUSD")?.refreshed).toBe(true);
    }
  });

  it("aborts hung pair lookups via deadline", async () => {
    const never = new Promise<Response>(() => {
      /* hang forever */
    });
    const fetchImpl = vi.fn(async () => never as Promise<Response>);
    const started = Date.now();
    const result = await fetchMandatoryMarks({
      targets: Array.from({ length: 3 }, (_, i) => ({
        pairAddress: `pair${String(i).padStart(40, "1")}`,
        baseAddress: null,
      })),
      timeoutMs: 50,
      pairLookupBudget: 3,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(2_000);
    expect(result.fetchedAddresses).toHaveLength(0);
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("createAbortDeadline fires and disposes cleanly", async () => {
    const { signal, dispose } = createAbortDeadline(20);
    await new Promise((r) => setTimeout(r, 40));
    expect(signal.aborted).toBe(true);
    dispose();
  });
});
