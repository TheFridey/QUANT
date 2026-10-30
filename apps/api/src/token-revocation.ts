import { createHash } from "node:crypto";
import IORedis from "ioredis";

const MEMORY = new Map<string, number>();
const REDIS_PREFIX = "odin:jwt:revoked:";

let redis: IORedis | null | undefined;
/** Audit L2: after a failed Redis call, skip Redis until this time instead of reconnecting per request. */
let redisDownUntil = 0;
let redisFailures = 0;
const REDIS_BACKOFF_BASE_MS = 1_000;
const REDIS_BACKOFF_MAX_MS = 30_000;

function redisAvailable(now = Date.now()): boolean {
  return now >= redisDownUntil;
}

function markRedisDown(now = Date.now()): void {
  redisFailures += 1;
  redisDownUntil = now + Math.min(REDIS_BACKOFF_MAX_MS, REDIS_BACKOFF_BASE_MS * 2 ** (redisFailures - 1));
}

function markRedisUp(): void {
  redisFailures = 0;
  redisDownUntil = 0;
}

/** Revocations that could not reach Redis; flushed on the next successful Redis call so replicas converge. */
const PENDING_WRITES = new Map<string, number>();

/** Connect if needed. A client that is already connecting is awaited, not treated as a failure. */
async function ensureReady(client: IORedis): Promise<void> {
  if (client.status === "ready") return;
  if (client.status === "connecting" || client.status === "connect" || client.status === "reconnecting") {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("REDIS_CONNECT_TIMEOUT")), 1_000);
      client.once("ready", () => {
        clearTimeout(timer);
        resolve();
      });
      client.once("end", () => {
        clearTimeout(timer);
        reject(new Error("REDIS_ENDED"));
      });
    });
    return;
  }
  await client.connect();
}

async function flushPendingWrites(client: IORedis): Promise<void> {
  const now = Date.now();
  for (const [id, expMs] of PENDING_WRITES) {
    if (expMs > now) await client.set(`${REDIS_PREFIX}${id}`, "1", "PX", Math.max(1_000, expMs - now));
    PENDING_WRITES.delete(id);
  }
}

function redisClient(): IORedis | null {
  if (redis !== undefined) return redis;
  const url = process.env.REDIS_URL?.trim();
  if (!url) {
    redis = null;
    return null;
  }
  try {
    const client = new IORedis(url, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
      connectTimeout: 500,
      retryStrategy: () => null,
    });
    client.on("error", () => undefined);
    redis = client;
    return client;
  } catch {
    redis = null;
    return null;
  }
}

function pruneMemory(now = Date.now()): void {
  for (const [key, expMs] of MEMORY) {
    if (expMs <= now) MEMORY.delete(key);
  }
}

/** Stable id for opaque JWTs that lack an explicit `jti` claim. */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 32);
}

/**
 * Server-side JWT revocation (D25).
 * In-memory always; Redis used when REDIS_URL is reachable so multi-process API
 * replicas share logout state. Failures fall back to memory — single-operator scope.
 */
/**
 * Returns true when the revocation is durable for every API process: written to Redis, or there is
 * no Redis configured (single process, memory is the store). Returns false when Redis is configured
 * but the write failed; the id stays queued and the caller must tell the operator (audit L2/M5).
 */
export async function revokeToken(id: string, expMs: number): Promise<boolean> {
  const ttlMs = Math.max(1_000, expMs - Date.now());
  MEMORY.set(id, Date.now() + ttlMs);
  pruneMemory();
  const client = redisClient();
  if (!client) return true;
  // Keep the write until Redis confirms it, so other API replicas learn of the revocation after an outage.
  PENDING_WRITES.set(id, Date.now() + ttlMs);
  // Revocation writes always try Redis, even during read backoff: a dropped write would let a copied token
  // work on another replica or after a restart.
  try {
    await ensureReady(client);
    await flushPendingWrites(client);
    markRedisUp();
    return true;
  } catch {
    markRedisDown();
    return false;
  }
}

export async function isTokenRevoked(id: string): Promise<boolean> {
  pruneMemory();
  const localExp = MEMORY.get(id);
  if (localExp && localExp > Date.now()) return true;
  const client = redisClient();
  // While Redis is backing off, memory is the source of revocation (single-operator scope).
  if (!client || !redisAvailable()) return false;
  try {
    await ensureReady(client);
    await flushPendingWrites(client);
    const value = await client.get(`${REDIS_PREFIX}${id}`);
    markRedisUp();
    return value === "1";
  } catch {
    markRedisDown();
    return false;
  }
}

/** Test helper — clears in-memory state and the Redis backoff. */
export function resetTokenRevocationForTests(): void {
  MEMORY.clear();
  PENDING_WRITES.clear();
  redisFailures = 0;
  redisDownUntil = 0;
}

/** Test helper — current Redis backoff state. */
export function tokenRevocationBackoffForTests(): { failures: number; downUntil: number; pendingWrites: number } {
  return { failures: redisFailures, downUntil: redisDownUntil, pendingWrites: PENDING_WRITES.size };
}
