import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { QUEUES, stageJobId } from "@odin/shared";
import type { DistributedLease } from "@odin/risk-engine";
import { Job, Queue } from "bullmq";
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

async function withStageLease(
  leases: StageLeaseService,
  stage: string,
  cycleId: string,
  run: () => Promise<void>,
): Promise<void> {
  const lease = await leases.tryAcquireStage(stage, cycleId);
  if (!lease) return;
  try {
    await run();
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
      const result = await this.stages.ingest({ cycleId: job.data.cycleId, trigger: job.data.trigger ?? "schedule" });
      if (!result.skipped) await enqueue(this.next, "sentinel", result.cycleId);
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
    });
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
    });
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
    });
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
    });
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
    });
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
    });
  }

  @OnWorkerEvent("failed")
  async onFailed(job: Job<CycleJob> | undefined, error: Error): Promise<void> {
    await failIfExhausted(this.stages, job, error);
  }
}

async function failIfExhausted(stages: StageRunner, job: Job<CycleJob> | undefined, error: Error): Promise<void> {
  if (!job?.data.cycleId) return;
  const attempts = job.opts.attempts ?? 1;
  if (job.attemptsMade < attempts) return;
  await stages.fail(job.data.cycleId, error.message);
}
