import { Injectable, OnModuleDestroy } from "@nestjs/common";
import IORedis from "ioredis";

const PING_TIMEOUT_MS = 1_000;

/**
 * Audit M9: one long-lived Redis client for health checks instead of a new connection per request.
 * Offline queueing is off, so a down Redis fails the ping fast rather than queueing commands.
 */
@Injectable()
export class RedisHealth implements OnModuleDestroy {
  private client: IORedis | null = null;

  constructor(private readonly url: string | undefined = process.env.REDIS_URL) {}

  private connection(): IORedis | null {
    if (!this.url) return null;
    if (!this.client) {
      this.client = new IORedis(this.url, {
        lazyConnect: false,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        connectTimeout: PING_TIMEOUT_MS,
      });
      this.client.on("error", () => undefined);
    }
    return this.client;
  }

  async ping(): Promise<boolean> {
    const client = this.connection();
    if (!client) return false;
    try {
      const reply = await Promise.race([
        client.ping(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("REDIS_PING_TIMEOUT")), PING_TIMEOUT_MS)),
      ]);
      return reply === "PONG";
    } catch {
      return false;
    }
  }

  onModuleDestroy(): void {
    this.client?.disconnect();
    this.client = null;
  }
}
