/**
 * Distributed (Redis-shaped) cycle/stage leases for multi-worker fencing (D51).
 * Uses a minimal KV client so packages stay free of ioredis; worker wires Redis.
 * Never invents live SLO claims — exclusivity only.
 */

export type KvLeaseClient = {
  /** SET key value PX ttlMs NX — true when acquired. */
  setNxPx(key: string, value: string, ttlMs: number): Promise<boolean>;
  get(key: string): Promise<string | null>;
  /** Delete only when value matches (fencing token). */
  compareAndDelete(key: string, expected: string): Promise<boolean>;
};

export type DistributedLease = {
  resourceKey: string;
  workerId: string;
  token: string;
  acquiredAtMs: number;
  expiresAtMs: number;
};

export type DistributedLeaseResult =
  | { ok: true; lease: DistributedLease }
  | { ok: false; reason: "HELD_BY_OTHER"; holderToken: string | null };

export function cycleStageLeaseKey(stage: string, cycleId: string): string {
  return `odin:lease:stage:${stage}:${cycleId}`;
}

export function ingestSlotLeaseKey(slot = "primary"): string {
  return `odin:lease:ingest:${slot}`;
}

export class DistributedWorkerLeaseManager {
  constructor(
    private readonly kv: KvLeaseClient,
    private readonly nowFn: () => number = () => Date.now(),
  ) {}

  async acquire(input: {
    resourceKey: string;
    workerId: string;
    ttlMs: number;
    token?: string;
  }): Promise<DistributedLeaseResult> {
    const now = this.nowFn();
    const token = input.token ?? `${input.workerId}:${now}:${Math.random().toString(36).slice(2, 10)}`;
    const acquired = await this.kv.setNxPx(input.resourceKey, token, Math.max(1, input.ttlMs));
    if (!acquired) {
      const holderToken = await this.kv.get(input.resourceKey);
      return { ok: false, reason: "HELD_BY_OTHER", holderToken };
    }
    return {
      ok: true,
      lease: {
        resourceKey: input.resourceKey,
        workerId: input.workerId,
        token,
        acquiredAtMs: now,
        expiresAtMs: now + Math.max(1, input.ttlMs),
      },
    };
  }

  async release(input: { resourceKey: string; token: string }): Promise<boolean> {
    return this.kv.compareAndDelete(input.resourceKey, input.token);
  }
}

/** In-memory KV for offline unit tests of the distributed lease algorithm. */
export class MemoryKvLeaseClient implements KvLeaseClient {
  private readonly store = new Map<string, { value: string; expiresAtMs: number }>();

  constructor(private readonly nowFn: () => number = () => Date.now()) {}

  async setNxPx(key: string, value: string, ttlMs: number): Promise<boolean> {
    this.expire(key);
    if (this.store.has(key)) return false;
    this.store.set(key, { value, expiresAtMs: this.nowFn() + Math.max(1, ttlMs) });
    return true;
  }

  async get(key: string): Promise<string | null> {
    this.expire(key);
    return this.store.get(key)?.value ?? null;
  }

  async compareAndDelete(key: string, expected: string): Promise<boolean> {
    this.expire(key);
    const row = this.store.get(key);
    if (!row || row.value !== expected) return false;
    this.store.delete(key);
    return true;
  }

  private expire(key: string): void {
    const row = this.store.get(key);
    if (row && row.expiresAtMs <= this.nowFn()) this.store.delete(key);
  }
}

/**
 * Race N workers for one stage lease — exactly one winner (distributed algorithm).
 */
export async function raceDistributedCycleLease(input: {
  workers: string[];
  resourceKey: string;
  ttlMs: number;
  kv?: KvLeaseClient;
}): Promise<{ winners: string[]; losers: string[] }> {
  const manager = new DistributedWorkerLeaseManager(input.kv ?? new MemoryKvLeaseClient());
  const winners: string[] = [];
  const losers: string[] = [];
  const results = await Promise.all(
    input.workers.map((workerId) =>
      manager.acquire({ resourceKey: input.resourceKey, workerId, ttlMs: input.ttlMs }),
    ),
  );
  for (let i = 0; i < input.workers.length; i += 1) {
    if (results[i]?.ok) winners.push(input.workers[i]!);
    else losers.push(input.workers[i]!);
  }
  return { winners, losers };
}
