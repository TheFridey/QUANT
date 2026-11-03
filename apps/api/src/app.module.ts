import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { QUEUES } from "@odin/shared";
import { createPrismaClient, PrismaClient } from "@odin/shared/db";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { JwtAuthGuard } from "./http.js";
import { EvolutionController } from "./evolution.controller.js";
import { EvolutionService } from "./evolution.service.js";
import { LabController } from "./lab.controller.js";
import { LabService } from "./lab.service.js";
import { OperatorCapacityService } from "./operator-capacity.service.js";
import { OperatorController } from "./operator.controller.js";
import { TerminalController } from "./terminal.controller.js";
import { RedisHealth } from "./redis-health.js";
import { ResearchLoopController } from "./research-loop.controller.js";
import { TerminalFanout, TerminalGateway } from "./terminal.gateway.js";
import { TerminalService } from "./terminal.service.js";

@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: "12h" },
    }),
    BullModule.forRoot({
      connection: { url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379", maxRetriesPerRequest: null },
    }),
    BullModule.registerQueue({ name: QUEUES.ingest }),
  ],
  controllers: [AuthController, TerminalController, OperatorController, LabController, EvolutionController, ResearchLoopController],
  providers: [
    { provide: PrismaClient, useFactory: () => createPrismaClient() },
    AuthService,
    TerminalService,
    { provide: RedisHealth, useFactory: () => new RedisHealth(process.env.REDIS_URL) },
    OperatorCapacityService,
    LabService,
    EvolutionService,
    TerminalGateway,
    TerminalFanout,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
