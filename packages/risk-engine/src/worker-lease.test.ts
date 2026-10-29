import { describe, expect, it } from "vitest";
import { WorkerLeaseManager, raceAcquireCycleLease } from "./worker-lease.js";

describe("multi-worker scheduling leases (D51)", () => {
  it("grants exclusive cycle lease to exactly one of two racing workers", () => {
    const raced = raceAcquireCycleLease({
      workers: ["w1", "w2", "w3"],
      resourceKey: "cycle:ingest:primary",
      ttlMs: 30_000,
    });
    expect(raced.winners).toHaveLength(1);
    expect(raced.losers).toHaveLength(2);
    expect(raced.manager.holder("cycle:ingest:primary")?.workerId).toBe(raced.winners[0]);
  });

  it("allows same worker to renew and rejects foreign renew/release", () => {
    const now = 1_000;
    const manager = new WorkerLeaseManager(() => now);
    const acquired = manager.acquire({ resourceKey: "stage:plan", workerId: "w1", ttlMs: 5_000 });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    const renewed = manager.renew({
      resourceKey: "stage:plan",
      workerId: "w1",
      token: acquired.lease.token,
      ttlMs: 5_000,
    });
    expect(renewed.ok).toBe(true);

    const foreign = manager.renew({
      resourceKey: "stage:plan",
      workerId: "w2",
      token: acquired.lease.token,
      ttlMs: 5_000,
    });
    expect(foreign.ok).toBe(false);

    expect(
      manager.release({ resourceKey: "stage:plan", workerId: "w2", token: acquired.lease.token }),
    ).toBe(false);
    expect(
      manager.release({ resourceKey: "stage:plan", workerId: "w1", token: acquired.lease.token }),
    ).toBe(true);
    expect(manager.holder("stage:plan")).toBeNull();
  });

  it("expires leases so a second worker can acquire after ttl", () => {
    let now = 0;
    const manager = new WorkerLeaseManager(() => now);
    const first = manager.acquire({ resourceKey: "cycle:x", workerId: "w1", ttlMs: 100 });
    expect(first.ok).toBe(true);
    now = 150;
    const second = manager.acquire({ resourceKey: "cycle:x", workerId: "w2", ttlMs: 100 });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.lease.workerId).toBe("w2");
  });
});
