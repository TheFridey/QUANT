import { Injectable, OnModuleDestroy } from "@nestjs/common";
import {
  DistributedWorkerLeaseManager,
  cycleStageLeaseKey,
  ingestSlotLeaseKey,
  type DistributedLease,
  type KvLeaseClient,
} from "@odin/risk-engine";
import IORedis from "ioredis";
import { workerLog } from "./logger.js";

const RELEASE_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

class IoRedisKvLeaseClient implements KvLeaseClient {
  constructor(private readonly redis: IORedis) {}

  async setNxPx(key: string, value: string, ttlMs: number): Promise<boolean> {
    const result = await this.redis.set(key, value, "PX", Math.max(1, ttlMs), "NX");
    return result === "OK";
  }

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async compareAndDelete(key: string, expected: string): Promise<boolean> {
    const result = await this.redis.eval(RELEASE_LUA, 1, key, expected);
    return Number(result) === 1;
  }
}

/**
 * BullMQ multi-worker stage fencing via Redis SET NX PX (D51).
 * Complements BullMQ jobId uniqueness — fences concurrent process hosts.
 */
@Injectable()
export class StageLeaseService implements OnModuleDestroy {
  private readonly redis: IORedis;
  private readonly manager: DistributedWorkerLeaseManager;
  readonly workerId: string;

  constructor() {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL is required for stage leases");
    this.redis = new IORedis(url, { maxRetriesPerRequest: null });
    this.redis.on("error", () => undefined);
    this.manager = new DistributedWorkerLeaseManager(new IoRedisKvLeaseClient(this.redis));
    this.workerId = process.env.WORKER_ID?.trim() || `worker-${process.pid}`;
  }

  async tryAcquireStage(stage: string, cycleId: string, ttlMs = 60_000): Promise<DistributedLease | null> {
    const result = await this.manager.acquire({
      resourceKey: cycleStageLeaseKey(stage, cycleId),
      workerId: this.workerId,
      ttlMs,
    });
    if (!result.ok) {
      workerLog.info({ stage, cycleId, holder: result.holderToken }, "stage lease held by other worker — skip");
      return null;
    }
    return result.lease;
  }

  async tryAcquireIngest(ttlMs = 60_000): Promise<DistributedLease | null> {
    const result = await this.manager.acquire({
      resourceKey: ingestSlotLeaseKey("primary"),
      workerId: this.workerId,
      ttlMs,
    });
    if (!result.ok) {
      workerLog.info({ holder: result.holderToken }, "ingest lease held by other worker — skip");
      return null;
    }
    return result.lease;
  }

  async release(lease: DistributedLease | null): Promise<void> {
    if (!lease) return;
    await this.manager.release({ resourceKey: lease.resourceKey, token: lease.token });
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}
