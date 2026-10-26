import Decimal from "decimal.js";

export function formatUsd(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const amount = new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const sign = amount.isNeg() ? "-" : "";
  return `${sign}$${amount.abs().toFixed(2)}`;
}

export function formatPx(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  return new Decimal(value).toSignificantDigits(8).toString();
}

export function formatQty(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const fixed = new Decimal(value).toFixed(8);
  return fixed.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

export function formatPct(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const amount = new Decimal(value);
  const sign = amount.isNeg() ? "" : "+";
  return `${sign}${amount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)}%`;
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
