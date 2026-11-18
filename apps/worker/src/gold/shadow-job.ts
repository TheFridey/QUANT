import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Injectable, OnModuleInit } from "@nestjs/common";
import { DEFAULT_GOLD_SHADOW_CONFIG, GoldShadowFeed, OandaPracticeMarketData, inventoryOandaCredentials, type GoldShadowConfig, type ShadowPollResult } from "@odin/market-data";
import { PrismaClient } from "@odin/shared/db";
import { Queue } from "bullmq";
import { randomUUID } from "node:crypto";
import { workerLog } from "../logger.js";
import { GoldShadowStore, canonicalJson, sha256, type PersistOutcome, type ShadowPolicies } from "./shadow-store.js";

/**
 * HELIOS: gold shadow ingestion. **Disabled by default and never executable.** Nothing is scheduled, and the
 * processor returns at once, unless AURUM_GOLD_SHADOW_ENABLED is exactly "true" (an operator activation decision).
 *
 * One poll per tick through the existing read-only practice pricing client (`GoldShadowFeed`: generation-fenced
 * breaker, single request in flight, timeout, practice-host allowlist, duplicate and out-of-order rejection). The
 * accepted quote is persisted through `GoldShadowStore` (lease, one quote per bucket, restart-safe daily budget,
 * bounded rejection evidence). It writes only the GoldShadow* tables: never orders, intents, positions, ledgers,
 * EngineControl, risk configuration or execution permissions.
 */
export const GOLD_SHADOW_QUEUE = "aurum.gold-shadow";
export const GOLD_SHADOW_INSTRUMENT = "XAU_USD";

export function goldShadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AURUM_GOLD_SHADOW_ENABLED === "true";
}

function boundedInt(text: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(text);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/**
 * Sampling policy. Default bucket 15 s (5,760 quotes a day at most): the HELIOS measurement put 5 s buckets at
 * about 28.9 MB/day (about 10.5 GB/year at the ceiling). 5..60 s may be set by env; anything else uses the default.
 */
export function goldShadowPolicies(env: NodeJS.ProcessEnv = process.env, config: GoldShadowConfig = DEFAULT_GOLD_SHADOW_CONFIG): ShadowPolicies {
  const bucketMs = boundedInt(env.AURUM_GOLD_SHADOW_BUCKET_MS, 15_000, 5_000, 60_000);
  const maxQuotesPerDay = Math.floor(86_400_000 / bucketMs);
  return {
    bucketMs,
    maxQuotesPerDay,
    samplingPolicyHash: sha256(canonicalJson({ v: 1, bucketMs, maxQuotesPerDay, oneCanonicalQuotePerBucket: true })),
    qualityPolicyHash: sha256(canonicalJson({ v: 1, maxSpreadBps: config.maxSpreadBps, maxQuoteAgeMs: config.maxQuoteAgeMs, clockSkewToleranceMs: config.clockSkewToleranceMs, session: "METALS_ENERGY_CFD" })),
  };
}

export type TickResult =
  | { status: "NO_LEASE"; reason: "LEASE_HELD" | "LEASE_LOST" }
  | { status: "BUDGET_PAUSED"; until: string }
  | { status: "HALTED"; reason: string }
  | { status: "POLLED"; poll: ShadowPollResult["status"]; persisted?: PersistOutcome["status"] };

type Feed = Pick<GoldShadowFeed, "poll">;
type Store = Pick<GoldShadowStore, "startRun" | "renewLease" | "persist" | "countPoll" | "recordRejection" | "stopRun">;

/** One bounded tick. Pure orchestration: the feed and store are injected so every branch is testable. */
export class GoldShadowTicker {
  private runId: string | null = null;
  private budgetPausedUntil = 0;
  /** Set once the feed reports DISABLED or INVALID_CONFIG: the ticker stops for good (no run churn per tick). */
  private halted: string | null = null;

  constructor(
    private readonly feed: Feed,
    private readonly store: Store,
    private readonly opts: { owner: string; leaseMs: number; policies: ShadowPolicies; configHash: string; now: () => Date },
  ) {}

  async tick(): Promise<TickResult> {
    const now = this.opts.now();
    if (this.halted) return { status: "HALTED", reason: this.halted };
    if (now.getTime() < this.budgetPausedUntil) return { status: "BUDGET_PAUSED", until: new Date(this.budgetPausedUntil).toISOString() };
    if (this.runId && !(await this.store.renewLease(this.runId, this.opts.owner, now, this.opts.leaseMs))) this.runId = null;
    if (!this.runId) {
      const started = await this.store.startRun({ instrument: GOLD_SHADOW_INSTRUMENT, owner: this.opts.owner, leaseMs: this.opts.leaseMs, configHash: this.opts.configHash, policies: this.opts.policies, now });
      if (!started.ok) return { status: "NO_LEASE", reason: started.reason };
      this.runId = started.runId;
    }
    const runId = this.runId;
    const r = await this.feed.poll();
    switch (r.status) {
      case "ACCEPTED": {
        const q = r.quote;
        if (!q.providerTimeRaw) {
          await this.store.recordRejection(runId, "NO_VERBATIM_PROVIDER_TIME", now);
          return { status: "POLLED", poll: r.status };
        }
        await this.store.countPoll(runId, false);
        const out = await this.store.persist(
          runId,
          this.opts.owner,
          {
            instrument: GOLD_SHADOW_INSTRUMENT,
            providerTimeRaw: q.providerTimeRaw,
            receivedAt: new Date(q.receivedAt),
            // The feed exposes the parsed row fields, not the raw HTTP body: the payload hash covers exactly these.
            rawRow: { time: q.providerTimeRaw, bid: q.bid, ask: q.ask, tradeable: q.providerTradeable },
            bid: q.bid,
            ask: q.ask,
            providerTradeable: q.providerTradeable,
            sessionState: q.session.status,
            qualityVerdict: q.quality.admissible ? "ACCEPTED" : "FLAGGED",
            qualityReasons: [...q.quality.reasons],
          },
          this.opts.policies,
          now,
        );
        if (out.status === "BUDGET_EXHAUSTED") {
          // The store ended the run; pause until the next UTC day rather than polling into a full budget.
          this.runId = null;
          this.budgetPausedUntil = Math.floor(now.getTime() / 86_400_000) * 86_400_000 + 86_400_000;
        }
        if (out.status === "LEASE_LOST") this.runId = null;
        if (out.status === "INVALID") await this.store.recordRejection(runId, `INVALID:${out.reason}`, now);
        return { status: "POLLED", poll: r.status, persisted: out.status };
      }
      case "PROVIDER_FAILURE":
        await this.store.countPoll(runId, true);
        await this.store.recordRejection(runId, `PROVIDER_FAILURE:${r.code}`, now, { circuit: r.circuit });
        return { status: "POLLED", poll: r.status };
      case "REJECTED":
        await this.store.countPoll(runId, false);
        await this.store.recordRejection(runId, `FEED_REJECTED:${r.reason}`, now);
        return { status: "POLLED", poll: r.status };
      case "OUT_OF_ORDER":
        await this.store.countPoll(runId, false);
        await this.store.recordRejection(runId, "OUT_OF_ORDER", now, { eventTime: r.eventTime, lastEventTime: r.lastEventTime });
        return { status: "POLLED", poll: r.status };
      case "DUPLICATE":
      case "THROTTLED":
      case "CIRCUIT_OPEN":
        await this.store.countPoll(runId, false);
        return { status: "POLLED", poll: r.status };
      case "DISABLED":
      case "INVALID_CONFIG":
        await this.store.stopRun(runId, this.opts.owner, now, "FAILED", r.status);
        this.runId = null;
        this.halted = r.status;
        return { status: "POLLED", poll: r.status };
    }
  }
}

@Injectable()
export class GoldShadowScheduler implements OnModuleInit {
  constructor(@InjectQueue(GOLD_SHADOW_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    for (const job of await this.queue.getRepeatableJobs()) await this.queue.removeRepeatableByKey(job.key);
    if (!goldShadowEnabled()) {
      workerLog.info("aurum gold shadow disabled (AURUM_GOLD_SHADOW_ENABLED is not true); nothing scheduled");
      return;
    }
    const everyMs = Math.max(DEFAULT_GOLD_SHADOW_CONFIG.minPollIntervalMs, goldShadowPolicies().bucketMs / 3);
    await this.queue.add("gold-shadow-tick", {}, { repeat: { every: everyMs }, attempts: 1, removeOnComplete: 20, removeOnFail: 20 });
    workerLog.info({ everyMs, ...goldShadowPolicies() }, "aurum gold shadow scheduled (observation only, non-executable)");
  }
}

@Processor(GOLD_SHADOW_QUEUE, { concurrency: 1 })
export class GoldShadowProcessor extends WorkerHost {
  private ticker: GoldShadowTicker | null = null;

  constructor(private readonly prisma: PrismaClient) {
    super();
  }

  async process(): Promise<void> {
    if (!goldShadowEnabled()) return;
    if (!this.ticker) {
      const config: GoldShadowConfig = { ...DEFAULT_GOLD_SHADOW_CONFIG, enabled: true };
      const client = new OandaPracticeMarketData(inventoryOandaCredentials(process.env));
      const feed = new GoldShadowFeed(config, { pricing: (instruments, signal) => client.pricing(instruments, signal), now: () => new Date() });
      this.ticker = new GoldShadowTicker(feed, new GoldShadowStore(this.prisma), {
        owner: `worker-${randomUUID()}`,
        leaseMs: 60_000,
        policies: goldShadowPolicies(process.env, config),
        configHash: sha256(canonicalJson({ v: 1, maxSpreadBps: config.maxSpreadBps, maxQuoteAgeMs: config.maxQuoteAgeMs, minPollIntervalMs: config.minPollIntervalMs })),
        now: () => new Date(),
      });
    }
    const result = await this.ticker.tick();
    if (result.status !== "POLLED" || result.persisted === "STORED") return;
    workerLog.info(result, "aurum gold shadow tick");
  }
}
