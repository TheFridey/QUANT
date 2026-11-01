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

/** Every selection trial ever recorded (training and full-grid windows), across all runs, datasets and versions. */
export async function programmeTrialCount(prisma: Pick<PrismaClient, "researchTrial">): Promise<number> {
  return prisma.researchTrial.count({ where: { window: { in: ["TRAIN", "FULL_GRID"] } } });
}
