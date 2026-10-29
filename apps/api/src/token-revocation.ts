import { createHash } from "node:crypto";
import IORedis from "ioredis";

const MEMORY = new Map<string, number>();
const REDIS_PREFIX = "odin:jwt:revoked:";

let redis: IORedis | null | undefined;

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
export async function revokeToken(id: string, expMs: number): Promise<void> {
  const ttlMs = Math.max(1_000, expMs - Date.now());
  MEMORY.set(id, Date.now() + ttlMs);
  pruneMemory();
  const client = redisClient();
  if (!client) return;
  try {
    if (client.status !== "ready") await client.connect();
    await client.set(`${REDIS_PREFIX}${id}`, "1", "PX", ttlMs);
  } catch {
    return;
  }
}

export async function isTokenRevoked(id: string): Promise<boolean> {
  pruneMemory();
  const localExp = MEMORY.get(id);
  if (localExp && localExp > Date.now()) return true;
  const client = redisClient();
  if (!client) return false;
  try {
    if (client.status !== "ready") await client.connect();
    const value = await client.get(`${REDIS_PREFIX}${id}`);
    return value === "1";
  } catch {
    return false;
  }
}

/** Test helper — clears in-memory state only. */
export function resetTokenRevocationForTests(): void {
  MEMORY.clear();
}
