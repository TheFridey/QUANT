import { Injectable, OnModuleDestroy } from "@nestjs/common";
import type { AgentBus } from "./stage-runner.js";
import IORedis from "ioredis";

@Injectable()
export class RedisBus implements AgentBus, OnModuleDestroy {
  private readonly redis: IORedis;

  constructor() {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL is required");
    this.redis = new IORedis(url);
    this.redis.on("error", () => undefined);
  }

  async publish(channel: string, payload: unknown): Promise<void> {
    await this.redis.publish(channel, JSON.stringify(payload));
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}
