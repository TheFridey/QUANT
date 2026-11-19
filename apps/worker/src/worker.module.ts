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
import { RESEARCH_CAMPAIGN_QUEUE, ResearchCampaignProcessor, ResearchCampaignScheduler } from "./campaign-job.js";
import { GENESIS_SHADOW_QUEUE, GenesisShadowProcessor, GenesisShadowScheduler } from "./genesis-shadow.js";
import { GOLD_SHADOW_QUEUE, GoldShadowProcessor, GoldShadowScheduler } from "./gold/shadow-job.js";
import { RedisBus } from "./redis-bus.js";
import { RESEARCH_LOOP_QUEUE, ResearchLoopProcessor, ResearchLoopScheduler } from "./research-loop.js";
import { Scheduler } from "./scheduler.js";
import { StageLeaseService } from "./stage-lease.js";
import { liveFeed, StageRunner } from "./stage-runner.js";
import { legacyRetirementFromEnv } from "./legacy-retirement.js";
import { workerLog } from "./logger.js";

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
    BullModule.registerQueue(...queues, { name: RESEARCH_LOOP_QUEUE }, { name: GENESIS_SHADOW_QUEUE }, { name: RESEARCH_CAMPAIGN_QUEUE }, { name: GOLD_SHADOW_QUEUE }),
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
        // CATALYST: state the legacy crypto mode once, and make a mistyped value impossible to miss.
        const legacy = legacyRetirementFromEnv(process.env);
        if (legacy.issue) workerLog.warn({ legacyCryptoMode: legacy.mode, issue: legacy.issue }, "LEGACY_CRYPTO_MODE not recognised: treated as RETIRED");
        else workerLog.info({ legacyCryptoMode: legacy.mode }, legacy.mode === "RETIRED" ? "legacy crypto retired: discovery off, new entries paused" : "legacy crypto active");
        const feedMode = resolveMarketFeedMode(process.env);
        if (feedMode === "deterministic") {
          const stepMs = deterministicStepMs(process.env);
          installDeterministicNetworkGuard({ stepMs });
          return new StageRunner(prisma, deterministicFeed({ stepMs }), bus, mode, () => new Date(), legacy);
        }
        return new StageRunner(prisma, liveFeed, bus, mode, () => new Date(), legacy);
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
    ResearchLoopScheduler,
    ResearchLoopProcessor,
    GenesisShadowScheduler,
    // HELIOS: default off (AURUM_GOLD_SHADOW_ENABLED must be exactly "true"); observation only, never executable.
    GoldShadowScheduler,
    GoldShadowProcessor,
    GenesisShadowProcessor,
    ResearchCampaignScheduler,
    ResearchCampaignProcessor,
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
