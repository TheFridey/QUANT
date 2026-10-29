import { describe, expect, it } from "vitest";
import {
  DistributedWorkerLeaseManager,
  MemoryKvLeaseClient,
  cycleStageLeaseKey,
  ingestSlotLeaseKey,
  raceDistributedCycleLease,
} from "./redis-worker-lease.js";

describe("distributed Redis-shaped stage leases (D51)", () => {
  it("grants exactly one winner across racing workers for a cycle stage key", async () => {
    const key = cycleStageLeaseKey("executor", "cyc_test_1");
    const raced = await raceDistributedCycleLease({
      workers: ["w1", "w2", "w3"],
      resourceKey: key,
      ttlMs: 5_000,
    });
    expect(raced.winners).toHaveLength(1);
    expect(raced.losers).toHaveLength(2);
  });

  it("releases only with matching fencing token then allows reacquire", async () => {
    const now = 1_000;
    const kv = new MemoryKvLeaseClient(() => now);
    const manager = new DistributedWorkerLeaseManager(kv, () => now);
    const key = ingestSlotLeaseKey("primary");
    const first = await manager.acquire({ resourceKey: key, workerId: "w1", ttlMs: 5_000 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(await manager.release({ resourceKey: key, token: "wrong" })).toBe(false);
    expect(await manager.release({ resourceKey: key, token: first.lease.token })).toBe(true);
    const second = await manager.acquire({ resourceKey: key, workerId: "w2", ttlMs: 5_000 });
    expect(second.ok).toBe(true);
  });

  it("expires so another worker can acquire after ttl", async () => {
    let now = 0;
    const kv = new MemoryKvLeaseClient(() => now);
    const manager = new DistributedWorkerLeaseManager(kv, () => now);
    const key = cycleStageLeaseKey("pulse", "cyc_x");
    const first = await manager.acquire({ resourceKey: key, workerId: "w1", ttlMs: 100 });
    expect(first.ok).toBe(true);
    now = 150;
    const second = await manager.acquire({ resourceKey: key, workerId: "w2", ttlMs: 100 });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.lease.workerId).toBe("w2");
  });
});
