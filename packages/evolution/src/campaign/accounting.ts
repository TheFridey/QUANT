import type { Prisma, PrismaClient } from "@odin/shared/db";
import { campaignTx } from "./tx.js";

/**
 * OPERATION EVIDENCE programme-wide trial accounting.
 *
 * Why it exists: every Sharpe is deflated by the number of configurations the whole programme has tried. If a
 * crash, a retry or two campaigns starting together can make that number smaller, every later DSR is too kind.
 *
 * Rules (statistical rationale in docs/evidence/ADR-0001-research-campaigns.md):
 *  - scheduled (unit PENDING, never started): counts 0. Nothing was computed, so nothing was selected on.
 *  - started: a RESERVED row is committed, under one advisory lock, BEFORE the first trial runs, at the unit's
 *    declared upper bound. From that moment the unit counts in full for every other reader.
 *  - completed: a SETTLED row replaces the bound by the actual count (never above the bound) in the same
 *    transaction that stores the result.
 *  - failed, abandoned, cancelled after starting, or crashed: no SETTLED row is ever written, so the unit
 *    counts at its full reservation for ever. Its trials may have run and been seen.
 *  - retry of the same unit: finds its own RESERVED row and reuses it, including the frozen `priorTrials`. It
 *    adds nothing (the retry repeats the same deterministic trials) and can never lower or reset the count.
 *  - intentional rerun: a new run has new units, so it reserves and counts again. Double counting an identical
 *    rerun overstates the search, which is the safe direction.
 * The count is the sum of: the legacy registry (ResearchTrial rows of the ASCEND CLIs), declared legacy trials
 * (LEGACY_DECLARED), and for every campaign unit its SETTLED count, else its RESERVED bound.
 */

export const TRIAL_LEDGER_LOCK = 8_080_803;

type Db = PrismaClient | Prisma.TransactionClient;

export type ProgrammeTrials = { total: number; legacyRegistry: number; legacyDeclared: number; campaignSettled: number; campaignOutstanding: number };

export async function programmeTrials(db: Db): Promise<ProgrammeTrials> {
  const [legacyRegistry, ledger] = await Promise.all([
    db.researchTrial.count({ where: { window: { in: ["TRAIN", "FULL_GRID"] } } }),
    db.$queryRaw<Array<{ legacy: bigint | null; settled: bigint | null; outstanding: bigint | null }>>`
      SELECT
        (SELECT COALESCE(SUM("trials"), 0) FROM "ResearchTrialLedger" WHERE "kind" = 'LEGACY_DECLARED') AS legacy,
        (SELECT COALESCE(SUM("trials"), 0) FROM "ResearchTrialLedger" WHERE "kind" = 'SETTLED') AS settled,
        (SELECT COALESCE(SUM(r."trials"), 0) FROM "ResearchTrialLedger" r
          WHERE r."kind" = 'RESERVED'
            AND NOT EXISTS (SELECT 1 FROM "ResearchTrialLedger" s WHERE s."kind" = 'SETTLED' AND s."unitId" = r."unitId")) AS outstanding`,
  ]);
  const row = ledger[0];
  const legacyDeclared = Number(row?.legacy ?? 0);
  const campaignSettled = Number(row?.settled ?? 0);
  const campaignOutstanding = Number(row?.outstanding ?? 0);
  return { total: legacyRegistry + legacyDeclared + campaignSettled + campaignOutstanding, legacyRegistry, legacyDeclared, campaignSettled, campaignOutstanding };
}

export type TrialReservation = { status: "RESERVED" | "ALREADY_RESERVED"; priorTrials: number; reserved: number } | { status: "REFUSED"; reason: string };

/**
 * Reserves a unit's trial bound. One short transaction under TRIAL_LEDGER_LOCK, so concurrent campaigns are
 * serialised and each sees every earlier reservation. Idempotent per unit.
 */
export async function reserveTrials(prisma: PrismaClient, input: { unitId: string; runId: string; planned: number; maxTrials: number; actor: string }): Promise<TrialReservation> {
  return campaignTx(prisma, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${TRIAL_LEDGER_LOCK})`;
    const existing = await tx.researchTrialLedger.findUnique({ where: { unitId_kind: { unitId: input.unitId, kind: "RESERVED" } } });
    if (existing) return { status: "ALREADY_RESERVED" as const, priorTrials: existing.priorTrials ?? 0, reserved: existing.trials };
    // The run's own declared trial limit counts every reservation of the run, settled or not.
    const used = await tx.$queryRaw<Array<{ used: bigint | null }>>`
      SELECT COALESCE(SUM(l."trials"), 0) AS used FROM "ResearchTrialLedger" l
        JOIN "ResearchCampaignUnit" u ON u."id" = l."unitId"
       WHERE l."kind" = 'RESERVED' AND u."runId" = ${input.runId}`;
    const runUsed = Number(used[0]?.used ?? 0);
    if (runUsed + input.planned > input.maxTrials) {
      return { status: "REFUSED" as const, reason: `TRIAL_LIMIT: run has reserved ${runUsed} trials; ${input.planned} more would exceed limits.maxTrials ${input.maxTrials}` };
    }
    const prior = (await programmeTrials(tx)).total;
    await tx.researchTrialLedger.create({ data: { kind: "RESERVED", unitId: input.unitId, trials: input.planned, priorTrials: prior, actor: input.actor } });
    return { status: "RESERVED" as const, priorTrials: prior, reserved: input.planned };
  });
}

/** Records the actual trial count with the result. Refuses a count above the reservation: the bound was wrong. */
export async function settleTrials(tx: Prisma.TransactionClient, input: { unitId: string; actual: number; actor: string }): Promise<void> {
  const reserved = await tx.researchTrialLedger.findUnique({ where: { unitId_kind: { unitId: input.unitId, kind: "RESERVED" } } });
  if (!reserved) throw new Error(`TRIAL_ACCOUNTING: unit ${input.unitId} has no reservation to settle`);
  if (input.actual > reserved.trials) throw new Error(`TRIAL_ACCOUNTING: unit ${input.unitId} ran ${input.actual} trials, above its reservation of ${reserved.trials}`);
  await tx.researchTrialLedger.create({ data: { kind: "SETTLED", unitId: input.unitId, trials: input.actual, actor: input.actor } });
}

/** Declares trials that were run before the ledger existed (for example read-only CLI studies). Append-only. */
export async function declareLegacyTrials(prisma: PrismaClient, input: { trials: number; actor: string; note: string }) {
  if (!Number.isInteger(input.trials) || input.trials < 1) throw new Error("legacy trial count must be a positive integer");
  if (!input.note.trim()) throw new Error("a legacy declaration needs a note saying where the count comes from");
  return campaignTx(prisma, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${TRIAL_LEDGER_LOCK})`;
    return tx.researchTrialLedger.create({ data: { kind: "LEGACY_DECLARED", trials: input.trials, actor: input.actor, note: input.note.trim() } });
  });
}
