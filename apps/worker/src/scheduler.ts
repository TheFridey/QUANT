import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, OnModuleInit } from "@nestjs/common";
import { QUEUES } from "@odin/shared";
import { Queue } from "bullmq";
import { workerLog } from "./logger.js";

@Injectable()
export class Scheduler implements OnModuleInit {
  constructor(@InjectQueue(QUEUES.ingest) private readonly ingest: Queue) {}

  async onModuleInit(): Promise<void> {
    const pollMs = Number(process.env.MARKET_POLL_MS ?? 20_000);
    const repeatable = await this.ingest.getRepeatableJobs();
    for (const job of repeatable) await this.ingest.removeRepeatableByKey(job.key);
    await this.ingest.add(
      "ingest",
      { trigger: "schedule" },
      {
        repeat: { every: pollMs },
        removeOnComplete: 200,
        removeOnFail: 100,
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
      },
    );
    await this.ingest.add("ingest", { trigger: "startup" }, { removeOnComplete: 20, removeOnFail: 20, attempts: 3 });
    workerLog.info({ pollMs }, "market ingest scheduled");
  }
}
