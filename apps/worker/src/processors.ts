import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { QUEUES, recordMetric, stageJobId, timed } from "@odin/shared";
import type { DistributedLease } from "@odin/risk-engine";
import { Job, Queue, UnrecoverableError } from "bullmq";
import { StageLeaseService } from "./stage-lease.js";
import { StageRunner } from "./stage-runner.js";

type CycleJob = { cycleId?: string; trigger?: string };

async function enqueue(queue: Queue, name: string, cycleId: string): Promise<void> {
  await queue.add(
    name,
    { cycleId },
    {
      jobId: stageJobId(name, cycleId),
      attempts: 3,
      backoff: { type: "exponential", delay: 500 },
      removeOnComplete: 200,
      removeOnFail: 100,
    },
  );
}

/**
 * Audit M8: a held stage lease is not success. Throw so BullMQ retries the job with backoff instead
 * of completing it silently (which could drop the next stage if the holder then fails).
 */
export class StageLeaseBusyError extends Error {
  constructor(stage: string, cycleId: string) {
    super(`STAGE_LEASE_BUSY: ${stage} for ${cycleId} is held by another worker; retrying`);
    this.name = "StageLeaseBusyError";
  }
}

/** A healthy stage takes seconds; ingest and the plan load only wait on calls with their own timeouts. */
export const STAGE_TIMEOUT_MS = 60_000;

/**
 * A stage that never settles would hold its concurrency-1 queue forever while BullMQ keeps renewing the
 * lock (9 Nov 2026: one hung sentinel job stalled the pipeline for 18 hours). Not retried: the cycle fails
 * now and the next scheduled cycle starts clean.
 */
export class StageTimeoutError extends UnrecoverableError {
  constructor(stage: string, timeoutMs: number) {
    super(`STAGE_TIMEOUT: ${stage} did not finish within ${timeoutMs} ms`);
  }
}

/**
 * Promises cannot be cancelled, so a timeout abandons the work rather than stopping it. Late work is safe
 * because cycle updates apply only while the cycle is RUNNING, later stages no-op on a FAILED cycle, the
 * high-water mark can only rise, and a day roll is compare-and-set.
 */
export async function withStageTimeout<T>(stage: string, timeoutMs: number, run: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const work = run();
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      recordMetric("odin_stage_timeout", 1, { stage }, "count");
      reject(new StageTimeoutError(stage, timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    // A late failure of abandoned work must not become an unhandled rejection.
    work.catch(() => recordMetric("odin_stage_late_error", 1, { stage }, "count"));
  }
}

/**
 * The executor settles orders, so it is never abandoned: a retry alongside a still-running settlement could
 * process it twice. An overrun only raises a metric, and the pipeline health signal reports the stall.
 */
export async function withStageOverrunAlert<T>(stage: string, timeoutMs: number, run: () => Promise<T>): Promise<T> {
  const timer = setTimeout(() => recordMetric("odin_stage_overrun", 1, { stage }, "count"), timeoutMs);
  try {
    return await run();
  } finally {
    clearTimeout(timer);
  }
}

export async function withStageLease(
  leases: Pick<StageLeaseService, "tryAcquireStage" | "release">,
  stage: string,
  cycleId: string,
  run: () => Promise<void>,
  queuedAt?: number,
  guard: <T>(stage: string, timeoutMs: number, run: () => Promise<T>) => Promise<T> = withStageTimeout,
): Promise<void> {
  // Audit F5: queue lag = time from enqueue to the worker picking the job up.
  if (queuedAt) recordMetric("odin_queue_lag_ms", Date.now() - queuedAt, { stage });
  const lease = await leases.tryAcquireStage(stage, cycleId);
  if (!lease) {
    recordMetric("odin_stage_lease_busy", 1, { stage }, "count");
    throw new StageLeaseBusyError(stage, cycleId);
  }
  try {
    await guard(stage, STAGE_TIMEOUT_MS, () => timed("odin_stage_duration_ms", { stage }, run));
  } finally {
    await leases.release(lease);
  }
}

@Processor(QUEUES.ingest, { concurrency: 1 })
export class IngestProcessor extends WorkerHost {
  constructor(
    private readonly stages: StageRunner,
    private readonly leases: StageLeaseService,
    @InjectQueue(QUEUES.sentinel) private readonly next: Queue,
  ) {
    super();
  }

  async process(job: Job<CycleJob>): Promise<void> {
    let lease: DistributedLease | null = null;
    try {
      lease = await this.leases.tryAcquireIngest();
      if (!lease) return;
      const result = await withStageTimeout("ingest", STAGE_TIMEOUT_MS, () =>
        this.stages.ingest({ cycleId: job.data.cycleId, trigger: job.data.trigger ?? "schedule" }),
      );
      if (!result.skipped) await enqueue(this.next, "sentinel", result.cycleId);
    } catch (error) {
      if (error instanceof StageTimeoutError) await this.stages.failCreatedCycle(error.message);
      throw error;
    } finally {
      await this.leases.release(lease);
    }
  }

  @OnWorkerEvent("failed")
  async onFailed(job: Job<CycleJob> | undefined, error: Error): Promise<void> {
    await failIfExhausted(this.stages, job, error);
  }
}

@Processor(QUEUES.sentinel, { concurrency: 1 })
export class SentinelProcessor extends WorkerHost {
  constructor(
    private readonly stages: StageRunner,
    private readonly leases: StageLeaseService,
    @InjectQueue(QUEUES.pulse) private readonly next: Queue,
  ) {
    super();
  }

  async process(job: Job<CycleJob>): Promise<void> {
    if (!job.data.cycleId) return;
    await withStageLease(this.leases, "sentinel", job.data.cycleId, async () => {
      await this.stages.sentinel(job.data.cycleId!);
      await enqueue(this.next, "pulse", job.data.cycleId!);
    }, job.timestamp);
  }

  @OnWorkerEvent("failed")
  async onFailed(job: Job<CycleJob> | undefined, error: Error): Promise<void> {
    await failIfExhausted(this.stages, job, error);
  }
}

@Processor(QUEUES.pulse, { concurrency: 1 })
export class PulseProcessor extends WorkerHost {
  constructor(
    private readonly stages: StageRunner,
    private readonly leases: StageLeaseService,
    @InjectQueue(QUEUES.aegis) private readonly next: Queue,
  ) {
    super();
  }

  async process(job: Job<CycleJob>): Promise<void> {
    if (!job.data.cycleId) return;
    await withStageLease(this.leases, "pulse", job.data.cycleId, async () => {
      await this.stages.pulse(job.data.cycleId!);
      await enqueue(this.next, "aegis", job.data.cycleId!);
    }, job.timestamp);
  }

  @OnWorkerEvent("failed")
  async onFailed(job: Job<CycleJob> | undefined, error: Error): Promise<void> {
    await failIfExhausted(this.stages, job, error);
  }
}

@Processor(QUEUES.aegis, { concurrency: 1 })
export class AegisProcessor extends WorkerHost {
  constructor(
    private readonly stages: StageRunner,
    private readonly leases: StageLeaseService,
    @InjectQueue(QUEUES.atlas) private readonly next: Queue,
  ) {
    super();
  }

  async process(job: Job<CycleJob>): Promise<void> {
    if (!job.data.cycleId) return;
    await withStageLease(this.leases, "aegis", job.data.cycleId, async () => {
      await this.stages.aegis(job.data.cycleId!);
      await enqueue(this.next, "atlas", job.data.cycleId!);
    }, job.timestamp);
  }

  @OnWorkerEvent("failed")
  async onFailed(job: Job<CycleJob> | undefined, error: Error): Promise<void> {
    await failIfExhausted(this.stages, job, error);
  }
}

@Processor(QUEUES.atlas, { concurrency: 1 })
export class AtlasProcessor extends WorkerHost {
  constructor(
    private readonly stages: StageRunner,
    private readonly leases: StageLeaseService,
    @InjectQueue(QUEUES.executor) private readonly next: Queue,
  ) {
    super();
  }

  async process(job: Job<CycleJob>): Promise<void> {
    if (!job.data.cycleId) return;
    await withStageLease(this.leases, "atlas", job.data.cycleId, async () => {
      await this.stages.atlas(job.data.cycleId!);
      await enqueue(this.next, "executor", job.data.cycleId!);
    }, job.timestamp);
  }

  @OnWorkerEvent("failed")
  async onFailed(job: Job<CycleJob> | undefined, error: Error): Promise<void> {
    await failIfExhausted(this.stages, job, error);
  }
}

@Processor(QUEUES.executor, { concurrency: 1 })
export class ExecutorProcessor extends WorkerHost {
  constructor(
    private readonly stages: StageRunner,
    private readonly leases: StageLeaseService,
    @InjectQueue(QUEUES.archivist) private readonly next: Queue,
  ) {
    super();
  }

  async process(job: Job<CycleJob>): Promise<void> {
    if (!job.data.cycleId) return;
    await withStageLease(this.leases, "executor", job.data.cycleId, async () => {
      await this.stages.executor(job.data.cycleId!);
      await enqueue(this.next, "archivist", job.data.cycleId!);
    }, job.timestamp, withStageOverrunAlert);
  }

  @OnWorkerEvent("failed")
  async onFailed(job: Job<CycleJob> | undefined, error: Error): Promise<void> {
    await failIfExhausted(this.stages, job, error);
  }
}

@Processor(QUEUES.archivist, { concurrency: 1 })
export class ArchivistProcessor extends WorkerHost {
  constructor(
    private readonly stages: StageRunner,
    private readonly leases: StageLeaseService,
  ) {
    super();
  }

  async process(job: Job<CycleJob>): Promise<void> {
    if (!job.data.cycleId) return;
    await withStageLease(this.leases, "archivist", job.data.cycleId, async () => {
      await this.stages.archivist(job.data.cycleId!);
    }, job.timestamp);
  }

  @OnWorkerEvent("failed")
  async onFailed(job: Job<CycleJob> | undefined, error: Error): Promise<void> {
    await failIfExhausted(this.stages, job, error);
  }
}

export async function failIfExhausted(
  stages: Pick<StageRunner, "fail">,
  job: Job<CycleJob> | undefined,
  error: Error,
): Promise<void> {
  if (!job?.data.cycleId) return;
  // The lease holder owns this stage and enqueues the next one; never fail the cycle under it.
  if (error.name === "StageLeaseBusyError") return;
  const attempts = job.opts.attempts ?? 1;
  if (!(error instanceof StageTimeoutError) && job.attemptsMade < attempts) return;
  await stages.fail(job.data.cycleId, error.message);
}
