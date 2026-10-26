import Decimal from "decimal.js";

export function decimalStringFromJson(value: unknown): string | null {
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    return new Decimal(value.trim()).toString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Decimal(value.toString()).toString();
  }
  return null;
}

export function intFromJson(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && Number.isFinite(value)) return value;
  return null;
}

export function primitives(record: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const fields: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
      fields[key] = value;
    }
  }
  return fields;
}
