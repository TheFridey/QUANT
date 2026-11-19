import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@odin/shared/db";

/**
 * HELIOS (D11): durable, bounded persistence for gold shadow reference quotes. **Never executable**: the database
 * refuses `executionEligible = true`, and these tables have no relation to orders, fills, positions or ledgers.
 *
 * Guarantees, each covered by `shadow-store.integration.test.ts` on a disposable PostgreSQL:
 * - one canonical quote per (provider, environment, instrument, sampling policy, bucket), enforced by a unique index,
 *   so restarts and concurrent workers cannot store a second one; later responses in the bucket are counted;
 * - a provider event is stored once (identity = SHA-256 of the provider's verbatim timestamp); the same event with a
 *   different payload is a CONFLICT, recorded inside persist as bounded evidence, and never overwrites the quote;
 * - one writer per instrument at a time (advisory transaction lock), so the daily budget is exact; the budget is
 *   counted in the database, so a restart does not reset it, and a repeated poll never spends or ends it;
 * - a single live lease per instrument; a writer that lost its lease cannot persist;
 * - rejection evidence is capped (CHECK: at most 50 samples per run), so an outage cannot flood rows;
 * - quotes are append-only (row and TRUNCATE triggers);
 * - every timestamp in SQL is an explicit ISO `::timestamptz` cast, independent of the session TimeZone.
 * Documented limitation: lease expiry uses the caller's clock, so a skewed worker clock can shorten or extend a lease.
 */

export const SHADOW_PROVIDER = "oanda_practice";
export const SHADOW_ENVIRONMENT = "PRACTICE";
export const MAX_REJECTION_SAMPLES = 50;
/** A persist that cannot finish in this time fails (and is retried at the next poll) rather than holding the run row. */
export const PERSIST_TRANSACTION_LIMITS = { timeout: 10_000, maxWait: 5_000 } as const;

export type ShadowQuoteInput = {
  instrument: string;
  /** Provider timestamp exactly as received, e.g. 2026-11-18T21:51:14.379123456Z. */
  providerTimeRaw: string;
  receivedAt: Date;
  /** The raw pricing row as received, for the payload hash. */
  rawRow: unknown;
  bid: string;
  ask: string;
  providerTradeable: boolean | null;
  sessionState: "OPEN" | "CLOSED" | "UNKNOWN";
  qualityVerdict: "ACCEPTED" | "FLAGGED";
  qualityReasons: string[];
};

export type ShadowPolicies = {
  qualityPolicyHash: string;
  samplingPolicyHash: string;
  /** Sampling bucket width; one canonical quote per bucket. */
  bucketMs: number;
  /** Maximum stored quotes per UTC day per instrument (restart-safe). */
  maxQuotesPerDay: number;
};

export type PersistOutcome =
  | { status: "STORED"; quoteId: string }
  | { status: "DUPLICATE" }
  | { status: "SUPPRESSED_SAME_BUCKET" }
  | { status: "CONFLICT" }
  | { status: "BUDGET_EXHAUSTED" }
  | { status: "LEASE_LOST" }
  | { status: "INVALID"; reason: string };

export const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Canonical JSON (sorted keys) so the payload hash does not depend on key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

const RAW_TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.(\d{1,9}))?Z$/;

/** Parses an RFC3339 UTC timestamp with up to nanosecond precision: ms, exact microseconds, and an ISO microsecond form. */
export function parseProviderTime(raw: string): { ms: number; micros: number; iso: string } | null {
  const m = RAW_TIME.exec(raw);
  if (!m) return null;
  const base = Date.parse(`${m[1]}Z`);
  if (!Number.isFinite(base)) return null;
  const frac = (m[3] ?? "").padEnd(9, "0");
  const micros = Number(frac.slice(0, 6));
  return { ms: base + Math.floor(micros / 1000), micros: base * 1000 + micros, iso: `${m[1]}.${frac.slice(0, 6)}Z` };
}

const DECIMAL = /^(0|[1-9]\d{0,15})(\.\d{1,8})?$/;

export function eventIdentity(instrument: string, providerTimeRaw: string): string {
  return sha256(`${SHADOW_PROVIDER}|${SHADOW_ENVIRONMENT}|${instrument}|${providerTimeRaw}`);
}

export class GoldShadowStore {
  constructor(private readonly prisma: PrismaClient) {}

  /** Starts a run if no other worker holds a live lease for the instrument. */
  async startRun(input: { instrument: string; owner: string; leaseMs: number; configHash: string; policies: ShadowPolicies; now: Date }) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`gold-shadow:${input.instrument}`}))`;
      const live = await tx.goldShadowIngestRun.findFirst({
        where: { instrument: input.instrument, status: "RUNNING", leaseExpiresAt: { gt: input.now }, NOT: { leaseOwner: input.owner } },
      });
      if (live) return { ok: false as const, reason: "LEASE_HELD" as const, runId: live.id };
      // Any earlier RUNNING run is closed, never resumed silently: expired leases, and this owner's own live run
      // (a restart inside the lease window), so at most one RUNNING run exists per instrument.
      await tx.goldShadowIngestRun.updateMany({
        where: { instrument: input.instrument, status: "RUNNING", OR: [{ leaseExpiresAt: { lte: input.now } }, { leaseOwner: input.owner }] },
        data: { status: "STOPPED", finishedAt: input.now, leaseExpiresAt: input.now, lastErrorCode: "SUPERSEDED_OR_EXPIRED" },
      });
      const run = await tx.goldShadowIngestRun.create({
        data: {
          provider: SHADOW_PROVIDER,
          environment: SHADOW_ENVIRONMENT,
          instrument: input.instrument,
          transport: "REST_POLL",
          configHash: input.configHash,
          qualityPolicyHash: input.policies.qualityPolicyHash,
          samplingPolicyHash: input.policies.samplingPolicyHash,
          leaseOwner: input.owner,
          leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs),
          heartbeatAt: input.now,
          startedAt: input.now,
        },
      });
      return { ok: true as const, runId: run.id };
    });
  }

  async renewLease(runId: string, owner: string, now: Date, leaseMs: number): Promise<boolean> {
    const r = await this.prisma.goldShadowIngestRun.updateMany({
      where: { id: runId, leaseOwner: owner, status: "RUNNING", leaseExpiresAt: { gt: now } },
      data: { leaseExpiresAt: new Date(now.getTime() + leaseMs), heartbeatAt: now },
    });
    return r.count === 1;
  }

  async stopRun(runId: string, owner: string, now: Date, status: "STOPPED" | "FAILED" | "BUDGET_EXHAUSTED", code?: string) {
    await this.prisma.goldShadowIngestRun.updateMany({
      where: { id: runId, leaseOwner: owner, status: "RUNNING" },
      data: { status, finishedAt: now, leaseExpiresAt: now, ...(code ? { lastErrorCode: code } : {}) },
    });
  }

  /** Counts a poll or provider failure without storing anything. */
  async countPoll(runId: string, providerFailure: boolean) {
    await this.prisma.goldShadowIngestRun.update({
      where: { id: runId },
      data: { polls: { increment: 1 }, ...(providerFailure ? { providerFailures: { increment: 1 } } : {}) },
    });
  }

  /** Records a rejection outside persist (for example a provider timeout): always counted, sampled while under the cap. */
  async recordRejection(runId: string, reason: string, at: Date, detail: Record<string, unknown> = {}) {
    await this.prisma.$transaction((tx) => this.rejectInTx(tx, runId, reason, at.toISOString(), detail));
  }

  async persist(runId: string, owner: string, q: ShadowQuoteInput, policies: ShadowPolicies, now: Date): Promise<PersistOutcome> {
    const t = parseProviderTime(q.providerTimeRaw);
    if (!t) return { status: "INVALID", reason: "PROVIDER_TIME_UNPARSEABLE" };
    if (!(q.receivedAt instanceof Date) || !Number.isFinite(q.receivedAt.getTime())) return { status: "INVALID", reason: "RECEIVED_AT_INVALID" };
    // Same rule and precision as the database CHECK (microseconds): an event more than 1 s after receipt is in the future.
    if (t.micros > q.receivedAt.getTime() * 1000 + 1_000_000) return { status: "INVALID", reason: "FUTURE_EVENT_TIME" };
    if (!DECIMAL.test(q.bid) || !DECIMAL.test(q.ask)) return { status: "INVALID", reason: "PRICE_NOT_REPRESENTABLE" };
    const bid = new Prisma.Decimal(q.bid);
    const ask = new Prisma.Decimal(q.ask);
    if (!bid.gt(0) || !ask.gt(bid)) return { status: "INVALID", reason: "ONE_SIDED_OR_CROSSED" };
    if (!(policies.bucketMs >= 1000) || !Number.isInteger(policies.bucketMs) || !(policies.maxQuotesPerDay >= 1)) return { status: "INVALID", reason: "INVALID_POLICY" };
    const mid = bid.plus(ask).div(2);
    if (mid.decimalPlaces() > 8) return { status: "INVALID", reason: "MID_NOT_REPRESENTABLE" };
    const identity = eventIdentity(q.instrument, q.providerTimeRaw);
    const payloadHash = sha256(canonicalJson(q.rawRow));
    const bucketStart = new Date(Math.floor(t.ms / policies.bucketMs) * policies.bucketMs).toISOString();
    const dayStartMs = Math.floor(t.ms / 86_400_000) * 86_400_000;
    const dayStart = new Date(dayStartMs).toISOString();
    const dayEnd = new Date(dayStartMs + 86_400_000).toISOString();
    const nowIso = now.toISOString();
    const receivedIso = q.receivedAt.toISOString();

    return this.prisma.$transaction(async (tx) => {
      // One writer per instrument at a time: makes the daily budget exact even if two runs existed.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`gold-shadow:${q.instrument}`}))`;
      const lease = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "GoldShadowIngestRun" WHERE "id" = ${runId} AND "leaseOwner" = ${owner}
          AND "status" = 'RUNNING' AND "leaseExpiresAt" > ${nowIso}::timestamptz FOR UPDATE`;
      if (lease.length === 0) return { status: "LEASE_LOST" as const };

      // Classify against what is stored before spending budget: a repeated poll never spends or ends the budget.
      const same = await tx.goldShadowQuote.findFirst({
        where: { provider: SHADOW_PROVIDER, environment: SHADOW_ENVIRONMENT, instrument: q.instrument, eventIdentity: identity },
        select: { payloadHash: true },
      });
      if (same && same.payloadHash !== payloadHash) {
        await this.rejectInTx(tx, runId, "CONFLICTING_PAYLOAD", receivedIso, { eventIdentity: identity });
        return { status: "CONFLICT" as const };
      }
      if (same) return this.suppressInTx(tx, runId, q.instrument, policies.samplingPolicyHash, bucketStart, receivedIso, "DUPLICATE");
      const [taken] = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM "GoldShadowQuote" WHERE "provider" = ${SHADOW_PROVIDER} AND "environment" = ${SHADOW_ENVIRONMENT}
          AND "instrument" = ${q.instrument} AND "samplingPolicyHash" = ${policies.samplingPolicyHash}
          AND "bucketStart" = ${bucketStart}::timestamptz`;
      if (Number(taken!.n) > 0) return this.suppressInTx(tx, runId, q.instrument, policies.samplingPolicyHash, bucketStart, receivedIso, "SUPPRESSED_SAME_BUCKET");

      const [count] = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM "GoldShadowQuote" WHERE "instrument" = ${q.instrument}
          AND "eventTime" >= ${dayStart}::timestamptz AND "eventTime" < ${dayEnd}::timestamptz`;
      if (Number(count!.n) >= policies.maxQuotesPerDay) {
        await tx.goldShadowIngestRun.update({ where: { id: runId }, data: { status: "BUDGET_EXHAUSTED", finishedAt: now, lastErrorCode: "DAILY_QUOTE_BUDGET" } });
        return { status: "BUDGET_EXHAUSTED" as const };
      }
      const inserted = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "GoldShadowQuote" ("id","runId","provider","environment","instrument","providerTimeRaw","eventTime","receivedAt",
          "eventIdentity","payloadHash","bid","ask","mid","spread","providerTradeable","sessionState","qualityVerdict","qualityReasons",
          "qualityPolicyHash","samplingPolicyHash","bucketStart")
        VALUES (gen_random_uuid()::text, ${runId}, ${SHADOW_PROVIDER}, ${SHADOW_ENVIRONMENT}, ${q.instrument}, ${q.providerTimeRaw},
          ${t.iso}::timestamptz, ${receivedIso}::timestamptz, ${identity}, ${payloadHash}, ${bid.toFixed()}::numeric, ${ask.toFixed()}::numeric,
          ${mid.toFixed()}::numeric, ${ask.minus(bid).toFixed()}::numeric, ${q.providerTradeable}, ${q.sessionState}, ${q.qualityVerdict},
          ${q.qualityReasons}::text[], ${policies.qualityPolicyHash}, ${policies.samplingPolicyHash}, ${bucketStart}::timestamptz)
        ON CONFLICT DO NOTHING RETURNING "id"`;
      // Only reachable if another writer bypassed the instrument lock: classify, never overwrite.
      if (inserted.length !== 1) return this.suppressInTx(tx, runId, q.instrument, policies.samplingPolicyHash, bucketStart, receivedIso, "SUPPRESSED_SAME_BUCKET");
      await tx.$executeRaw`
        INSERT INTO "GoldShadowSamplingBucket" ("id","provider","environment","instrument","samplingPolicyHash","bucketStart","quoteId","firstReceivedAt","lastReceivedAt")
        VALUES (gen_random_uuid()::text, ${SHADOW_PROVIDER}, ${SHADOW_ENVIRONMENT}, ${q.instrument}, ${policies.samplingPolicyHash},
          ${bucketStart}::timestamptz, ${inserted[0]!.id}, ${receivedIso}::timestamptz, ${receivedIso}::timestamptz)`;
      await tx.goldShadowIngestRun.update({ where: { id: runId }, data: { accepted: { increment: 1 } } });
      return { status: "STORED" as const, quoteId: inserted[0]!.id };
    }, PERSIST_TRANSACTION_LIMITS);
  }

  private async suppressInTx(
    tx: Prisma.TransactionClient,
    runId: string,
    instrument: string,
    samplingPolicyHash: string,
    bucketStart: string,
    receivedIso: string,
    status: "DUPLICATE" | "SUPPRESSED_SAME_BUCKET",
  ): Promise<PersistOutcome> {
    const touched = await tx.$executeRaw`
      UPDATE "GoldShadowSamplingBucket" SET "suppressedCount" = "suppressedCount" + 1,
        "lastReceivedAt" = GREATEST("lastReceivedAt", ${receivedIso}::timestamptz)
      WHERE "provider" = ${SHADOW_PROVIDER} AND "environment" = ${SHADOW_ENVIRONMENT} AND "instrument" = ${instrument}
        AND "samplingPolicyHash" = ${samplingPolicyHash} AND "bucketStart" = ${bucketStart}::timestamptz`;
    // A duplicate stored under another sampling policy has no bucket row here: record that instead of counting silently.
    if (touched === 0) {
      await this.rejectInTx(tx, runId, "DUPLICATE_OTHER_POLICY", receivedIso, {});
      return { status: "DUPLICATE" };
    }
    await tx.goldShadowIngestRun.update({ where: { id: runId }, data: { suppressed: { increment: 1 } } });
    return { status };
  }

  private async rejectInTx(tx: Prisma.TransactionClient, runId: string, reason: string, atIso: string, detail: Record<string, unknown>) {
    const sample = JSON.stringify([{ at: atIso, reason: reason.slice(0, 64), ...detail }]);
    await tx.$executeRaw`
      UPDATE "GoldShadowIngestRun" SET "rejected" = "rejected" + 1,
        "rejectionSamples" = CASE WHEN jsonb_array_length("rejectionSamples") < ${MAX_REJECTION_SAMPLES}
          THEN "rejectionSamples" || ${sample}::jsonb ELSE "rejectionSamples" END
      WHERE "id" = ${runId}`;
  }
}
