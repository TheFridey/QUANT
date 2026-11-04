import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Injectable, OnModuleInit } from "@nestjs/common";
import { runShadowTick, shadowEnabled, shadowEveryMs, warehouseBarSource } from "@odin/evolution/genesis";
import { PrismaClient } from "@odin/shared/db";
import { Queue } from "bullmq";
import { workerLog } from "./logger.js";

/**
 * GENESIS Phase 6 shadow predictions. Disabled by default: nothing is scheduled, and the processor returns at
 * once, unless GENESIS_SHADOW_ENABLED is exactly "true". Each cycle is bounded (GENESIS_SHADOW_MAX_MODELS,
 * _MAX_PREDICTIONS, _MAX_RESOLUTIONS, _MAX_MS, all clamped to hard ceilings). The job writes only
 * ShadowPrediction, ShadowOutcome and ModelLifecycleEvent rows; it never creates orders or trade intents and
 * never touches EngineControl, risk configuration, strategy instances or execution permissions.
 */
export const GENESIS_SHADOW_QUEUE = "odin.genesis-shadow";

@Injectable()
export class GenesisShadowScheduler implements OnModuleInit {
  constructor(@InjectQueue(GENESIS_SHADOW_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    for (const job of await this.queue.getRepeatableJobs()) await this.queue.removeRepeatableByKey(job.key);
    if (!shadowEnabled()) {
      workerLog.info("genesis shadow disabled (GENESIS_SHADOW_ENABLED is not true); nothing scheduled");
      return;
    }
    const everyMs = shadowEveryMs();
    await this.queue.add("genesis-shadow-cycle", {}, { repeat: { every: everyMs }, attempts: 1, removeOnComplete: 50, removeOnFail: 50 });
    workerLog.info({ everyMs }, "genesis shadow cycle scheduled");
  }
}

@Processor(GENESIS_SHADOW_QUEUE, { concurrency: 1 })
export class GenesisShadowProcessor extends WorkerHost {
  constructor(private readonly prisma: PrismaClient) {
    super();
  }

  async process(): Promise<void> {
    const result = await runShadowTick(this.prisma, { bars: warehouseBarSource(this.prisma), env: process.env });
    if (result.status !== "RAN") return;
    workerLog.info(
      {
        models: result.models.length,
        predicted: result.predicted,
        abstained: result.abstained,
        duplicates: result.duplicates,
        skipped: result.skipped.length,
        resolved: result.resolved,
        unavailable: result.unavailable,
        pending: result.pending.length,
        suspended: result.suspended.map((s) => s.modelVersionId),
        failed: result.failed.map((f) => f.modelVersionId),
        stoppedEarly: result.stoppedEarly,
        elapsedMs: result.elapsedMs,
      },
      "genesis shadow cycle",
    );
  }
}
