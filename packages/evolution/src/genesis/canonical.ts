import { createHash } from "node:crypto";

/**
 * Canonical JSON for GENESIS hashes: object keys sorted by code unit, arrays in order, no whitespace.
 * Strict: refuses values JSON cannot round-trip exactly (non-finite numbers, undefined, functions, symbols,
 * bigints, class instances other than Date), so a stored record always re-hashes to the same value.
 * Dates are encoded as ISO strings.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalise(value, "$"));
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export const HEX64 = /^[a-f0-9]{64}$/;

function normalise(value: unknown, path: string): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalJsonError(`${path} is a non-finite number`);
      return Object.is(value, -0) ? 0 : value;
    case "object": {
      if (value instanceof Date) {
        if (!Number.isFinite(value.getTime())) throw new CanonicalJsonError(`${path} is an invalid date`);
        return value.toISOString();
      }
      if (Array.isArray(value)) return value.map((v, i) => normalise(v, `${path}[${i}]`));
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) throw new CanonicalJsonError(`${path} is not a plain object`);
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        const inner = (value as Record<string, unknown>)[key];
        if (inner === undefined) throw new CanonicalJsonError(`${path}.${key} is undefined`);
        out[key] = normalise(inner, `${path}.${key}`);
      }
      return out;
    }
    default:
      throw new CanonicalJsonError(`${path} has unsupported type ${typeof value}`);
  }
}

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(`canonical JSON: ${message}`);
    this.name = "CanonicalJsonError";
  }
}
