import { hostname } from "node:os";
import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Injectable, OnModuleInit } from "@nestjs/common";
import { runResearchLoopTick } from "@odin/evolution";
import { PrismaClient } from "@odin/shared/db";
import { Queue } from "bullmq";
import { workerLog } from "./logger.js";

/**
 * ASCEND-08 bounded research loop. A repeatable job calls `runResearchLoopTick`, which returns at once
 * unless ResearchLoopControl.enabled is true (default false; a missing row is off) and the autonomy level
 * is 2 or 3. So deploying this changes nothing until an operator turns the loop on.
 * The loop never touches the trading path: it writes only research tables, ModelUsageLog,
 * ExperimentReport and LifecycleAudit rows.
 */
export const RESEARCH_LOOP_QUEUE = "odin.research-loop";

export function researchLoopEveryMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.RESEARCH_LOOP_TICK_MS ?? 300_000);
  return Number.isFinite(parsed) && parsed >= 60_000 ? Math.floor(parsed) : 300_000;
}

@Injectable()
export class ResearchLoopScheduler implements OnModuleInit {
  constructor(@InjectQueue(RESEARCH_LOOP_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    const everyMs = researchLoopEveryMs();
    for (const job of await this.queue.getRepeatableJobs()) await this.queue.removeRepeatableByKey(job.key);
    await this.queue.add(
      "research-loop-tick",
      {},
      // No BullMQ retries: the next scheduled tick is the retry, and the loop keeps its own attempt counts.
      { repeat: { every: everyMs }, attempts: 1, removeOnComplete: 50, removeOnFail: 50 },
    );
    workerLog.info({ everyMs }, "research loop tick scheduled (runs only when the kill switch is on)");
  }
}

@Processor(RESEARCH_LOOP_QUEUE, { concurrency: 1 })
export class ResearchLoopProcessor extends WorkerHost {
  private readonly owner = `${hostname()}:${process.pid}`;

  constructor(private readonly prisma: PrismaClient) {
    super();
  }

  async process(): Promise<void> {
    const result = await runResearchLoopTick(this.prisma, { owner: this.owner, router: { env: process.env } });
    if (result.status !== "RAN") return;
    workerLog.info(
      {
        created: result.created.length,
        claimed: result.claimed.length,
        reclaimed: result.reclaimed.length,
        advanced: result.advanced.map((row) => `${row.id}:${row.from}->${row.to}`),
        held: result.held.length,
        attemptsFailed: result.attemptsFailed.length,
        leaseLost: result.leaseLost.length,
        modelCalls: result.modelCalls,
        stoppedEarly: result.stoppedEarly,
      },
      "research loop tick",
    );
  }
}
