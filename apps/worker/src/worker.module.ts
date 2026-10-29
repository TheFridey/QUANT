import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { ensureDefaultStrategyInstances } from "@odin/agent-core";
import { QUEUES } from "@odin/shared";
import { ensureFoundation, loadEnvConfig } from "@odin/shared/bootstrap";
import { createPrismaClient, PrismaClient } from "@odin/shared/db";
import {
  AegisProcessor,
  ArchivistProcessor,
  AtlasProcessor,
  ExecutorProcessor,
  IngestProcessor,
  PulseProcessor,
  SentinelProcessor,
} from "./processors.js";
import {
  deterministicFeed,
  deterministicStepMs,
  installDeterministicNetworkGuard,
  resolveMarketFeedMode,
} from "./deterministic-feed.js";
import { RedisBus } from "./redis-bus.js";
import { Scheduler } from "./scheduler.js";
import { StageLeaseService } from "./stage-lease.js";
import { liveFeed, StageRunner } from "./stage-runner.js";

const queues = Object.values(QUEUES).map((name) => ({ name }));

@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: () => {
        const url = process.env.REDIS_URL;
        if (!url) throw new Error("REDIS_URL is required");
        return { connection: { url, maxRetriesPerRequest: null } };
      },
    }),
    BullModule.registerQueue(...queues),
  ],
  providers: [
    RedisBus,
    StageLeaseService,
    {
      provide: PrismaClient,
      useFactory: () => createPrismaClient(),
    },
    {
      provide: StageRunner,
      inject: [PrismaClient, RedisBus],
      useFactory: (prisma: PrismaClient, bus: RedisBus) => {
        const mode = process.env.DATA_MODE === "replay" || process.env.DATA_MODE === "demo" ? process.env.DATA_MODE : "live";
        const feedMode = resolveMarketFeedMode(process.env);
        if (feedMode === "deterministic") {
          const stepMs = deterministicStepMs(process.env);
          installDeterministicNetworkGuard({ stepMs });
          return new StageRunner(prisma, deterministicFeed({ stepMs }), bus, mode);
        }
        return new StageRunner(prisma, liveFeed, bus, mode);
      },
    },
    IngestProcessor,
    SentinelProcessor,
    PulseProcessor,
    AegisProcessor,
    AtlasProcessor,
    ExecutorProcessor,
    ArchivistProcessor,
    Scheduler,
    {
      provide: "WORKER_BOOT",
      useFactory: async () => {
        const env = await loadEnvConfig();
        const prisma = createPrismaClient();
        await ensureFoundation(prisma, { email: env.adminEmail, password: env.adminPassword });
        await ensureDefaultStrategyInstances(prisma, "primary");
        await prisma.$disconnect();
        return true;
      },
    },
  ],
})
export class WorkerModule {}
