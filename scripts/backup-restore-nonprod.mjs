#!/usr/bin/env node
/**
 * RETIRED (OPERATION INTEGRITY F05, 12 Nov 2026). This helper used to validate only the URL path as a test
 * database, then pass the whole connection URI (credentials included) to psql on argv and run
 * `DROP SCHEMA public CASCADE`. libpq URI query parameters (`?dbname=`, `?host=`, `?service=`, ...) could
 * point that DROP at a different database than the one validated.
 *
 * It now refuses every invocation without connecting to anything. Use instead:
 * - Restore verification: `scripts/restore-verify.mjs` restores a custom-format dump into a NEW generated
 *   scratch database (`odin_restore_drill_<stamp>`), checks its identity before pg_restore, verifies it and
 *   drops it. It never writes to an existing database. See docs/RUNBOOKS.md "Restore verification drill".
 * - Resetting a test database: `pnpm db:deploy` against a fresh `odin_test` database (create it new rather
 *   than dropping the schema of an existing one).
 *
 * This file deliberately imports nothing that can spawn a process.
 */
export const RETIRED_MESSAGE =
  "scripts/backup-restore-nonprod.mjs is retired (F05): it could reset a database other than the one it validated. " +
  "Use scripts/restore-verify.mjs (restores into a new scratch database) — see docs/RUNBOOKS.md.";

export function main() {
  console.error(JSON.stringify({ ok: false, error: RETIRED_MESSAGE }, null, 2));
  process.exitCode = 2;
  return 2;
}

main();
