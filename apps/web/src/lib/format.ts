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
