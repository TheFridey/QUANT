import "./load-env.js";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { setMetricSink } from "@odin/shared";
import { workerLog } from "./logger.js";
import { WorkerModule } from "./worker.module.js";

// Audit F5: structured metric lines go through the worker's pino logger.
setMetricSink((line) => workerLog.info(line, "metric"));

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });
  app.enableShutdownHooks();
  workerLog.info("odin worker ready");
}

main().catch((error: unknown) => {
  workerLog.error({ err: error }, "odin worker failed to start");
  process.exit(1);
});
