/**
 * Multi-worker scheduling leases (D51).
 * In-memory + serializable lease records for cycle/stage ownership.
 * Postgres/BullMQ workers can persist the same shape; this module proves
 * exclusivity, expiry, and fencing without inventing live SLO claims.
 */

export type WorkerLease = {
  resourceKey: string;
  workerId: string;
  token: string;
  acquiredAtMs: number;
  expiresAtMs: number;
  generation: number;
};

export type LeaseAcquireResult =
  | { ok: true; lease: WorkerLease }
  | { ok: false; reason: "HELD_BY_OTHER" | "EXPIRED_RACE"; holder: WorkerLease | null };

export class WorkerLeaseManager {
  private readonly leases = new Map<string, WorkerLease>();
  private generation = 0;

  constructor(private readonly nowFn: () => number = () => Date.now()) {}

  snapshot(): WorkerLease[] {
    this.expireStale();
    return [...this.leases.values()].map((lease) => ({ ...lease }));
  }

  /**
   * Acquire exclusive lease. Same worker may renew; other workers are rejected
   * until expiry.
   */
  acquire(input: {
    resourceKey: string;
    workerId: string;
    ttlMs: number;
    token?: string;
  }): LeaseAcquireResult {
    this.expireStale();
    const now = this.nowFn();
    const existing = this.leases.get(input.resourceKey);
    if (existing && existing.workerId !== input.workerId && existing.expiresAtMs > now) {
      return { ok: false, reason: "HELD_BY_OTHER", holder: { ...existing } };
    }
    this.generation += 1;
    const lease: WorkerLease = {
      resourceKey: input.resourceKey,
      workerId: input.workerId,
      token: input.token ?? `${input.workerId}:${this.generation}`,
      acquiredAtMs: existing?.workerId === input.workerId ? existing.acquiredAtMs : now,
      expiresAtMs: now + Math.max(1, input.ttlMs),
      generation: this.generation,
    };
    this.leases.set(input.resourceKey, lease);
    return { ok: true, lease: { ...lease } };
  }

  /** Renew only with matching fencing token. */
  renew(input: { resourceKey: string; workerId: string; token: string; ttlMs: number }): LeaseAcquireResult {
    this.expireStale();
    const existing = this.leases.get(input.resourceKey);
    if (!existing || existing.workerId !== input.workerId || existing.token !== input.token) {
      return { ok: false, reason: "EXPIRED_RACE", holder: existing ? { ...existing } : null };
    }
    const now = this.nowFn();
    const lease: WorkerLease = {
      ...existing,
      expiresAtMs: now + Math.max(1, input.ttlMs),
    };
    this.leases.set(input.resourceKey, lease);
    return { ok: true, lease: { ...lease } };
  }

  release(input: { resourceKey: string; workerId: string; token: string }): boolean {
    const existing = this.leases.get(input.resourceKey);
    if (!existing || existing.workerId !== input.workerId || existing.token !== input.token) {
      return false;
    }
    this.leases.delete(input.resourceKey);
    return true;
  }

  holder(resourceKey: string): WorkerLease | null {
    this.expireStale();
    const lease = this.leases.get(resourceKey);
    return lease ? { ...lease } : null;
  }

  private expireStale(): void {
    const now = this.nowFn();
    for (const [key, lease] of this.leases) {
      if (lease.expiresAtMs <= now) this.leases.delete(key);
    }
  }
}

/**
 * Simulate N workers racing for the same cycle lease — exactly one winner.
 */
export function raceAcquireCycleLease(input: {
  workers: string[];
  resourceKey: string;
  ttlMs: number;
  manager?: WorkerLeaseManager;
}): { winners: string[]; losers: string[]; manager: WorkerLeaseManager } {
  const manager = input.manager ?? new WorkerLeaseManager();
  const winners: string[] = [];
  const losers: string[] = [];
  for (const workerId of input.workers) {
    const result = manager.acquire({
      resourceKey: input.resourceKey,
      workerId,
      ttlMs: input.ttlMs,
    });
    if (result.ok) winners.push(workerId);
    else losers.push(workerId);
  }
  return { winners, losers, manager };
}
