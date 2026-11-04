import { describe, expect, it } from "vitest";
import { formatAllHistoryWindow, formatDrawdown, formatPct, formatPx, formatQty, formatUsd, formatUsdCompact } from "./format";

describe("shared number formatting (UI items 4 and 6)", () => {
  it("groups dollars with thousands separators", () => {
    expect(formatUsd("1234567.891")).toBe("$1,234,567.89");
    expect(formatUsd("-5")).toBe("-$5.00");
    expect(formatUsd(null)).toBe("—");
  });

  it("compacts large dollar figures", () => {
    expect(formatUsdCompact("2500000")).toBe("$2.5M");
    expect(formatUsdCompact("740000")).toBe("$740K");
    expect(formatUsdCompact("1200000000")).toBe("$1.2B");
    expect(formatUsdCompact("999")).toBe("$999.00");
  });

  it("shows prices to significant figures and trims quantities", () => {
    expect(formatPx("1234.56789")).toBe("1,234.57");
    expect(formatPx("0.000123456789")).toBe("0.000123457");
    expect(formatQty("1500.00000000")).toBe("1,500");
    expect(formatQty("0.25000000")).toBe("0.25");
  });

  it("never shows drawdown as a positive gain", () => {
    expect(formatDrawdown("0.0234")).toBe("-0.02%");
    expect(formatDrawdown("-3.5")).toBe("-3.50%");
    expect(formatDrawdown("0")).toBe("0.00%");
    expect(formatPct("0.02")).toBe("+0.02%");
  });

  it("captions all-history metrics with their sample count and start", () => {
    expect(formatAllHistoryWindow(12980, "2026-10-01T12:00:00.000Z")).toBe("All · 12,980 snapshots since 01 Oct 2026");
    expect(formatAllHistoryWindow(1, null)).toBe("All · 1 snapshot");
    expect(formatAllHistoryWindow(0, null)).toBe("All · no snapshots");
    expect(formatAllHistoryWindow(undefined, undefined)).toBe("All · no snapshots");
  });
});
