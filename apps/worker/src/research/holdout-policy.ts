import { programmeTrials } from "@odin/evolution/campaign";
import type { PrismaClient } from "@odin/shared/db";

/**
 * SINGULARITY-00 holdout policy. The registry's unique key (strategy × version × dataset) only stops an exact
 * repeat. A version bump or a re-imported dataset of the same instrument would otherwise get a fresh look at
 * the same final bars. So a strategy id may consume a holdout once per instrument and interval, across every
 * version and dataset. Renaming a strategy still evades this; that is caught by review, and the programme
 * trial count below deflates every DSR regardless of name.
 */
export async function holdoutAvailable(
  prisma: Pick<PrismaClient, "historicalDataset" | "researchHoldoutAccess">,
  input: { strategyId: string; instrumentKey: string; interval: string },
): Promise<boolean> {
  const siblings = await prisma.historicalDataset.findMany({ where: { instrumentKey: input.instrumentKey, interval: input.interval }, select: { id: true } });
  const prior = await prisma.researchHoldoutAccess.findFirst({ where: { strategyId: input.strategyId, datasetId: { in: siblings.map((d) => d.id) } }, select: { id: true } });
  return prior === null;
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
