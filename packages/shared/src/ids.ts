import { createHash, randomUUID } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

/** BullMQ custom ids may not contain ":" unless they have exactly three segments. */
export function stageJobId(stage: string, cycleId: string): string {
  if (!/^[a-z][a-z0-9_-]{0,40}$/i.test(stage) || !/^[A-Za-z0-9_-]{8,80}$/.test(cycleId)) {
    throw new Error("Invalid stage job id");
  }
  return `${stage}-${cycleId}`;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries.map(([key, inner]) => [key, sortValue(inner)]));
  }
  return value;
}
