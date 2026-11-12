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
 *  - a unit is deflated by `priorTrials`, frozen in its RESERVED row: everything outside its run, plus every
 *    OTHER unit of its run at that unit's full planned bound. The number does not depend on the order in which
 *    the units of a run happen to execute, so listing a favourite hypothesis first earns no lighter deflation.
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
    // Order-independent prior: the programme outside this run, plus the whole of this run except this unit.
    const own = await tx.$queryRaw<Array<{ counted: bigint | null; planned: bigint | null }>>`
      SELECT
        (SELECT COALESCE(SUM(COALESCE(s."trials", r."trials")), 0) FROM "ResearchTrialLedger" r
           JOIN "ResearchCampaignUnit" u ON u."id" = r."unitId"
           LEFT JOIN "ResearchTrialLedger" s ON s."unitId" = r."unitId" AND s."kind" = 'SETTLED'
          WHERE r."kind" = 'RESERVED' AND u."runId" = ${input.runId}) AS counted,
        (SELECT COALESCE(SUM("plannedTrials"), 0) FROM "ResearchCampaignUnit" WHERE "runId" = ${input.runId}) AS planned`;
    const outsideRun = (await programmeTrials(tx)).total - Number(own[0]?.counted ?? 0);
    const prior = outsideRun + Number(own[0]?.planned ?? 0) - input.planned;
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
  // Review L2: a manual declaration must not be able to impersonate a study's open or close row.
  if (/^study-(open|close):/i.test(input.note.trim())) throw new Error("legacy declaration notes may not start with study-open: or study-close:");
  return campaignTx(prisma, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${TRIAL_LEDGER_LOCK})`;
    return tx.researchTrialLedger.create({ data: { kind: "LEGACY_DECLARED", trials: input.trials, actor: input.actor, note: input.note.trim() } });
  });
}

/**
 * OPERATION INTEGRITY F03/F06: trial accounting for the exploratory (non-campaign) research CLIs.
 *
 * Campaigns are the only lifecycle that produces qualified evidence. The legacy CLIs remain for offline exploration,
 * withhold every holdout, and must still count every trial they compute, because a human reading their output can
 * select on it. Their trial counts depend on data-scaled grids, so an exact bound is not known before computation.
 * The rule is therefore OPEN before computing, CLOSE before disclosing:
 *  - OPEN: one LEGACY_DECLARED row (0 trials, note `study-open:<key>`) under TRIAL_LEDGER_LOCK, freezing the programme
 *    count the study is deflated by. A retry of the same study key reuses it, so the prior cannot drift.
 *  - CLOSE: one LEGACY_DECLARED row with the trials actually computed (note `study-close:<key>`), committed before any
 *    result is printed. A retry of a closed key adds nothing (the study is deterministic per key, as for a campaign
 *    unit retry). If the close cannot be written the caller must not print results.
 *  - A crash between OPEN and CLOSE leaves an unclosed OPEN row: nothing was disclosed, so nothing was selected on.
 *    `openStudies` reports it for operator reconciliation; it is never silently dropped.
 *  - Other ledger activity between OPEN and CLOSE (a concurrent study or campaign) is reported as `concurrentTrials`,
 *    so a study whose frozen prior is stale says so instead of looking less selected than it was.
 * No schema change: the existing CHECK permits LEGACY_DECLARED rows with `trials >= 0` and a non-empty note.
 */
export const STUDY_OPEN_PREFIX = "study-open:";
export const STUDY_CLOSE_PREFIX = "study-close:";

export type StudyOpen = { status: "OPENED" | "ALREADY_OPEN" | "ALREADY_CLOSED"; studyKey: string; priorTrials: number; openedAt: Date; closedTrials: number | null };

function assertStudyKey(key: string): void {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("study key must be a 64-hex sha256 of the study identity");
}

export async function openStudy(prisma: PrismaClient, input: { studyKey: string; actor: string; note: string }): Promise<StudyOpen> {
  assertStudyKey(input.studyKey);
  if (!input.note.trim()) throw new Error("a study needs a note naming the CLI, dataset and code version");
  return campaignTx(prisma, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${TRIAL_LEDGER_LOCK})`;
    const open = await tx.researchTrialLedger.findFirst({ where: { kind: "LEGACY_DECLARED", note: { startsWith: `${STUDY_OPEN_PREFIX}${input.studyKey} ` } }, orderBy: { createdAt: "asc" } });
    const close = await tx.researchTrialLedger.findFirst({ where: { kind: "LEGACY_DECLARED", note: { startsWith: `${STUDY_CLOSE_PREFIX}${input.studyKey} ` } }, orderBy: { createdAt: "asc" } });
    if (open) {
      // Review M2: a retry (possibly hours later) is deflated by at least everything committed since, never less
      // than the frozen count. For a crashed run whose own rows are already counted this overstates: safe direction.
      const prior = close ? (open.priorTrials ?? 0) : Math.max(open.priorTrials ?? 0, (await programmeTrials(tx)).total);
      return { status: close ? ("ALREADY_CLOSED" as const) : ("ALREADY_OPEN" as const), studyKey: input.studyKey, priorTrials: prior, openedAt: open.createdAt, closedTrials: close?.trials ?? null };
    }
    const prior = (await programmeTrials(tx)).total;
    const row = await tx.researchTrialLedger.create({ data: { kind: "LEGACY_DECLARED", trials: 0, priorTrials: prior, actor: input.actor, note: `${STUDY_OPEN_PREFIX}${input.studyKey} ${input.note.trim()}` } });
    return { status: "OPENED" as const, studyKey: input.studyKey, priorTrials: prior, openedAt: row.createdAt, closedTrials: null };
  });
}

export type StudyClose = { status: "CLOSED" | "ALREADY_CLOSED"; trials: number; concurrentTrials: number };

export async function closeStudy(prisma: PrismaClient, input: { studyKey: string; trials: number; actor: string; note: string; registryTrials?: number }): Promise<StudyClose> {
  assertStudyKey(input.studyKey);
  if (!Number.isInteger(input.trials) || input.trials < 0) throw new Error("study trial count must be a non-negative integer");
  return campaignTx(prisma, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${TRIAL_LEDGER_LOCK})`;
    const open = await tx.researchTrialLedger.findFirst({ where: { kind: "LEGACY_DECLARED", note: { startsWith: `${STUDY_OPEN_PREFIX}${input.studyKey} ` } }, orderBy: { createdAt: "asc" } });
    if (!open) throw new Error(`TRIAL_ACCOUNTING: study ${input.studyKey} was never opened; open it before computing`);
    const existing = await tx.researchTrialLedger.findFirst({ where: { kind: "LEGACY_DECLARED", note: { startsWith: `${STUDY_CLOSE_PREFIX}${input.studyKey} ` } }, orderBy: { createdAt: "asc" } });
    // Review M1: a key is one deterministic study. A rerun that computed a different number of trials is a
    // different study under a reused key (for example changed code without a version) and is refused.
    if (existing && existing.trials !== input.trials) throw new Error(`TRIAL_ACCOUNTING: study ${input.studyKey} was closed with ${existing.trials} trials; this run computed ${input.trials}, so it is not the same study; refusing to disclose it under this key`);
    const own = (existing ? existing.trials : input.trials) + (input.registryTrials ?? 0);
    if (!existing) await tx.researchTrialLedger.create({ data: { kind: "LEGACY_DECLARED", trials: input.trials, actor: input.actor, note: `${STUDY_CLOSE_PREFIX}${input.studyKey} ${input.note.trim() || "closed"}` } });
    // Trials anyone else committed (ledger or registry) since this study froze its prior: its deflation is stale by
    // at least this much. Never negative: a retry of a closed study has nothing of its own left to add.
    const concurrentTrials = Math.max(0, (await programmeTrials(tx)).total - (open.priorTrials ?? 0) - own);
    return { status: existing ? ("ALREADY_CLOSED" as const) : ("CLOSED" as const), trials: existing ? existing.trials : input.trials, concurrentTrials };
  });
}

/** Studies opened but never closed (crashed or interrupted before disclosure), for operator reconciliation. */
export async function openStudies(db: Db): Promise<Array<{ studyKey: string; actor: string; openedAt: Date; note: string }>> {
  const rows = await db.$queryRaw<Array<{ note: string; actor: string; createdAt: Date }>>`
    SELECT o."note", o."actor", o."createdAt" FROM "ResearchTrialLedger" o
     WHERE o."kind" = 'LEGACY_DECLARED' AND o."note" LIKE ${`${STUDY_OPEN_PREFIX}%`}
       AND NOT EXISTS (SELECT 1 FROM "ResearchTrialLedger" c WHERE c."kind" = 'LEGACY_DECLARED'
             AND c."note" LIKE ${STUDY_CLOSE_PREFIX} || substr(o."note", ${STUDY_OPEN_PREFIX.length + 1}::int, 64) || ' %')
     ORDER BY o."createdAt" ASC`;
  return rows.map((r) => ({ studyKey: r.note.slice(STUDY_OPEN_PREFIX.length, STUDY_OPEN_PREFIX.length + 64), actor: r.actor, openedAt: r.createdAt, note: r.note }));
}
