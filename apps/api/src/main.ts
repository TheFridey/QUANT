import "./load-env.js";
import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { NestFactory } from "@nestjs/core";
import helmet from "helmet";
import { ensureFoundation, loadEnvConfig } from "@odin/shared/bootstrap";
import { createPrismaClient } from "@odin/shared/db";
import type { NextFunction, Response } from "express";
import { AppModule } from "./app.module.js";
import { ApiExceptionFilter } from "./filter.js";
import { apiLog } from "./logger.js";
import type { RequestWithUser } from "./http.js";
import { allowedWebOrigins } from "./socket-origins.js";

async function main(): Promise<void> {
  const env = await loadEnvConfig();
  const prisma = createPrismaClient();
  await ensureFoundation(prisma, { email: env.adminEmail, password: env.adminPassword });
  await prisma.$disconnect();

  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  app.setGlobalPrefix("api");
  app.use(helmet());
  app.enableCors({
    origin: allowedWebOrigins(env.webOrigin),
    allowedHeaders: ["authorization", "content-type"],
    methods: ["GET", "POST", "PATCH"],
  });
  app.use((request: RequestWithUser, response: Response, next: NextFunction) => {
    const requestId = randomUUID();
    request.id = requestId;
    response.setHeader("x-request-id", requestId);
    const started = Date.now();
    response.on("finish", () => {
      apiLog.info({ requestId, method: request.method, path: request.path, status: response.statusCode, durationMs: Date.now() - started }, "request");
    });
    next();
  });
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.listen(env.apiPort, "0.0.0.0");
  apiLog.info({ port: env.apiPort }, "odin api listening");
}

main().catch((error: unknown) => {
  apiLog.error({ err: error }, "odin api failed to start");
  process.exit(1);
});
