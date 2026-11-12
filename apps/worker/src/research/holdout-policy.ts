import { createHash } from "node:crypto";
import { programmeTrials } from "@odin/evolution/campaign";
import type { PrismaClient } from "@odin/shared/db";

/**
 * RETIRED (OPERATION INTEGRITY F06). The SINGULARITY-00 check keyed holdout access on strategy × raw instrumentKey ×
 * interval, so a formatting alias of the same instrument ("EUR_USD" vs "EUR/USD") or an overlapping dataset could
 * look unconsumed, and it was read before evaluation but written after it (F03). The only holdout path is now the
 * research campaign's holdout ledger (normalised instrument, market, interval, dataset lineage and window overlap,
 * committed before any holdout bar is read). This stub keeps the export so an old import fails safe: it never grants
 * access, whatever it is asked.
 */
export async function holdoutAvailable(
  _prisma: unknown,
  _input: { strategyId: string; instrumentKey: string; interval: string },
): Promise<false> {
  return false;
}

/**
 * Every trial the programme has run: the ASCEND registry rows (training and full-grid windows), every campaign
 * unit (its settled count, or its full reservation while unsettled), and declared legacy trials. One number
 * for every tool, so a study outside a campaign is deflated by campaign trials too.
 */
export async function programmeTrialCount(prisma: PrismaClient): Promise<number> {
  return (await programmeTrials(prisma)).total;
}

/**
 * OPERATION INTEGRITY F06: the programme count used to deflate a study's DSR. An operator-supplied
 * `--prior-trials` may raise the durable count (for searches the ledger never saw) but never lower it, so a
 * flag cannot make a study look less selected than the authoritative ledger says it is.
 */
export function resolvePriorTrials(supplied: number | null | undefined, durable: number): { priorTrials: number; source: "LEDGER" | "SUPPLIED_ABOVE_LEDGER"; ignoredSupplied: number | null } {
  if (supplied === null || supplied === undefined) return { priorTrials: durable, source: "LEDGER", ignoredSupplied: null };
  if (supplied > durable) return { priorTrials: supplied, source: "SUPPLIED_ABOVE_LEDGER", ignoredSupplied: null };
  return { priorTrials: durable, source: "LEDGER", ignoredSupplied: supplied < durable ? supplied : null };
}

/**
 * OPERATION INTEGRITY F03/F06: the stable identity of one exploratory study run. Same CLI, dataset content, code
 * version and arguments give the same key, so a retry reuses its accounting instead of counting twice or resetting.
 * Keys are sorted so argument order does not create a "new" study.
 */
export function studyKey(identity: Record<string, unknown>): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v === undefined ? null : v;
  return createHash("sha256").update(JSON.stringify(canon(identity))).digest("hex");
}

/** Labels every legacy CLI report: exploration only, never qualified evidence (campaigns are the sole evidence path). */
export const EXPLORATORY_EVIDENCE_CLASS = "EXPLORATORY: not qualified evidence; holdouts withheld; use a research campaign" as const;
