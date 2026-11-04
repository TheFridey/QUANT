import Decimal from "decimal.js";

/** One formatter for every operator screen (UI item 6). Inputs are decimal strings from the API. */

function present(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value !== "";
}

/** Group the integer part with thousands separators: 1234567.5 -> "1,234,567.5". */
function group(fixed: string): string {
  const [whole, fraction] = fixed.split(".");
  const grouped = (whole ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/** Dollars to cents with thousands separators: "$12,345.67", "-$5.00". */
export function formatUsd(value: string | null | undefined): string {
  if (!present(value)) return "—";
  const amount = new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const sign = amount.isNeg() ? "-" : "";
  return `${sign}$${group(amount.abs().toFixed(2))}`;
}

/** Compact dollars for large figures such as liquidity and volume: "$2.5M", "$740K", "$1.2B". */
export function formatUsdCompact(value: string | null | undefined): string {
  if (!present(value)) return "—";
  const amount = new Decimal(value);
  const abs = amount.abs();
  const sign = amount.isNeg() ? "-" : "";
  const units: Array<[Decimal, string]> = [
    [new Decimal("1e12"), "T"],
    [new Decimal("1e9"), "B"],
    [new Decimal("1e6"), "M"],
    [new Decimal("1e3"), "K"],
  ];
  for (const [size, suffix] of units) {
    if (abs.gte(size)) {
      const scaled = abs.div(size);
      const digits = scaled.gte(100) ? 0 : 1;
      return `${sign}$${scaled.toDecimalPlaces(digits, Decimal.ROUND_HALF_UP).toFixed(digits).replace(/\.0$/, "")}${suffix}`;
    }
  }
  return formatUsd(value);
}

/** Prices to 6 significant figures, grouped: "1,234.56", "0.000123457". */
export function formatPx(value: string | null | undefined): string {
  if (!present(value)) return "—";
  const amount = new Decimal(value).toSignificantDigits(6, Decimal.ROUND_HALF_UP);
  return group(amount.toFixed());
}

/** Quantities trimmed of trailing zeros and grouped: "1,500", "0.25". */
export function formatQty(value: string | null | undefined): string {
  if (!present(value)) return "—";
  const fixed = new Decimal(value).toFixed(8);
  return group(fixed.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ""));
}

/** Signed percentage for returns and P&L: "+1.23%", "-0.50%". */
export function formatPct(value: string | null | undefined): string {
  if (!present(value)) return "—";
  const amount = new Decimal(value);
  const sign = amount.isNeg() ? "" : "+";
  return `${sign}${amount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)}%`;
}

/**
 * Drawdown is a distance below the high-water mark, so it is always shown as a negative
 * percentage ("-0.02%", or "0.00%" at the HWM), never "+x%" (UI bug 4).
 */
export function formatDrawdown(value: string | null | undefined): string {
  if (!present(value)) return "—";
  const amount = new Decimal(value).abs().toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return amount.isZero() ? "0.00%" : `-${amount.toFixed(2)}%`;
}

/** Window caption for an all-history metric, e.g. "All · 12,980 snapshots since 01 Oct 2026". */
export function formatAllHistoryWindow(sampleCount: number | null | undefined, fromIso: string | null | undefined): string {
  if (!sampleCount) return "All · no snapshots";
  const count = `${new Intl.NumberFormat("en-GB").format(sampleCount)} snapshot${sampleCount === 1 ? "" : "s"}`;
  if (!fromIso) return `All · ${count}`;
  const since = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "2-digit", month: "short", year: "numeric" }).format(new Date(fromIso));
  return `All · ${count} since ${since}`;
}

export function formatRate(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  return formatPct(new Decimal(value).mul(100).toString());
}

export function formatLondon(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

export function formatLondonDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

export function formatAge(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function formatDuration(fromIso: string | null | undefined, to = Date.now()): string {
  if (!fromIso) return "—";
  const ms = to - Date.parse(fromIso);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (hours < 48) return `${hours}h ${rem}m`;
  return `${Math.floor(hours / 24)}d`;
}

export function signedClass(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "text-muted";
  try {
    const amount = new Decimal(value);
    if (amount.isZero()) return "text-muted";
    return amount.isNeg() ? "text-loss" : "text-profit";
  } catch {
    return "text-muted";
  }
}
