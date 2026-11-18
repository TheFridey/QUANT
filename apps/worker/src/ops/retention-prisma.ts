import { PrismaClient } from "@odin/shared/db";
import { RETENTION_ADVISORY_LOCK_KEY } from "./retention-policy.js";
import type { RetentionDb, RetentionLock } from "./retention-executor.js";

/** Raw-SQL adapter over Prisma. Every statement runs in autocommit, so each batch delete is atomic on its own. */
export function prismaRetentionDb(prisma: PrismaClient): RetentionDb {
  return {
    query: <T>(sql: string, ...params: unknown[]) => prisma.$queryRawUnsafe<T[]>(sql, ...params),
  };
}

function withSingleConnection(url: string): string {
  const u = new URL(url);
  u.searchParams.set("connection_limit", "1");
  return u.toString();
}

/**
 * Session advisory lock on a dedicated single-connection client, so the lock lives on one known backend.
 * `heldBy` is answered through `observer` (another connection): if the holder's session died, the lock is
 * gone and the executor stops before its next delete.
 */
export function prismaRetentionLock(databaseUrl: string, observer: PrismaClient): RetentionLock {
  const holder = new PrismaClient({ datasources: { db: { url: withSingleConnection(databaseUrl) } } });
  let acquired = false;
  return {
    async acquire() {
      const [r] = await holder.$queryRawUnsafe<{ locked: boolean; pid: number }[]>(
        "SELECT pg_try_advisory_lock($1::bigint) AS locked, pg_backend_pid() AS pid",
        RETENTION_ADVISORY_LOCK_KEY,
      );
      if (!r?.locked) {
        await holder.$disconnect();
        return null;
      }
      acquired = true;
      return { pid: Number(r.pid) };
    },
    async heldBy(pid: number) {
      const [r] = await observer.$queryRawUnsafe<{ held: boolean }[]>(
        `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid = $1::int AND classid = 0 AND objid = $2::bigint::oid AND objsubid = 1) AS held`,
        pid,
        RETENTION_ADVISORY_LOCK_KEY,
      );
      return Boolean(r?.held);
    },
    async release() {
      try {
        if (acquired) await holder.$queryRawUnsafe("SELECT pg_advisory_unlock($1::bigint)", RETENTION_ADVISORY_LOCK_KEY);
      } finally {
        acquired = false;
        await holder.$disconnect();
      }
    },
  };
}
