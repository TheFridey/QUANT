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

/** Each queued id is removed only after Redis confirms its write; a failure leaves the rest queued. */
async function flushPendingWrites(client: IORedis): Promise<void> {
  for (const [id, expMs] of PENDING_WRITES) {
    const now = Date.now();
    if (expMs > now) await client.set(`${REDIS_PREFIX}${id}`, "1", "PX", Math.max(1_000, expMs - now));
    PENDING_WRITES.delete(id);
  }
}

/**
 * F02: thrown when Redis is configured but whether a token is revoked cannot be established
 * (connect failure, read failure, or active backoff). Callers must refuse the session; unknown
 * revocation status never means "not revoked".
 */
export class RevocationStatusUnavailableError extends Error {
  constructor(reason: string) {
    super(`Revocation status unavailable: ${reason}`);
    this.name = "RevocationStatusUnavailableError";
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
 * In-memory always. With REDIS_URL set, Redis is the shared store for every API process, so a
 * revocation must be readable from Redis before an unknown token is accepted: when Redis cannot be
 * read the check fails closed (F02). Without REDIS_URL the process is single-instance and memory is
 * the store.
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

/**
 * True when revoked (locally known, or recorded in Redis); false only when not revoked is established:
 * Redis confirmed it, or no Redis is configured. Throws RevocationStatusUnavailableError when Redis is
 * configured but could not be read, including during backoff (F02: fail closed, bounded reconnects).
 */
export async function isTokenRevoked(id: string): Promise<boolean> {
  pruneMemory();
  const localExp = MEMORY.get(id);
  if (localExp && localExp > Date.now()) return true;
  const client = redisClient();
  if (!client) return false;
  if (!redisAvailable()) throw new RevocationStatusUnavailableError("Redis backing off after a failure");
  try {
    await ensureReady(client);
    // Queued revocations reach Redis before any read is answered, so replicas converge on recovery.
    await flushPendingWrites(client);
    const value = await client.get(`${REDIS_PREFIX}${id}`);
    markRedisUp();
    return value === "1";
  } catch {
    markRedisDown();
    throw new RevocationStatusUnavailableError("Redis unreachable or read failed");
  }
}

/** Test helper — clears in-memory state and the Redis backoff. */
export function resetTokenRevocationForTests(): void {
  MEMORY.clear();
  PENDING_WRITES.clear();
  redisFailures = 0;
  redisDownUntil = 0;
}

/** Test helper — end the backoff window now (simulates time passing). */
export function clearRedisBackoffForTests(): void {
  redisDownUntil = 0;
}

/** Test helper — disconnect this module's Redis client so tests do not leak sockets. */
export async function closeTokenRevocationForTests(): Promise<void> {
  const client = redis;
  redis = undefined;
  if (client) client.disconnect();
}

/** Test helper — current Redis backoff state. */
export function tokenRevocationBackoffForTests(): { failures: number; downUntil: number; pendingWrites: number } {
  return { failures: redisFailures, downUntil: redisDownUntil, pendingWrites: PENDING_WRITES.size };
}
