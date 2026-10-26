import "./load-env.js";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { workerLog } from "./logger.js";
import { WorkerModule } from "./worker.module.js";

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });
  app.enableShutdownHooks();
  workerLog.info("odin worker ready");
}

main().catch((error: unknown) => {
  workerLog.error({ err: error }, "odin worker failed to start");
  process.exit(1);
});
