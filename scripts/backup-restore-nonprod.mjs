#!/usr/bin/env node
/**
 * Non-prod backup/restore drill helper (§33).
 * Operates only on DATABASE_URL_TEST / explicit NONPROD_BACKUP_URL.
 * Refuses production-looking URLs.
 *
 * Usage:
 *   DATABASE_URL_TEST=postgresql://… node scripts/backup-restore-nonprod.mjs backup /tmp/odin-nonprod.sql
 *   DATABASE_URL_TEST=postgresql://… node scripts/backup-restore-nonprod.mjs restore /tmp/odin-nonprod.sql
 *
 * Restore drops and recreates the public schema on the *test* database only
 * (never MARKET_DATA_PAPER primary production).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const url = process.env.NONPROD_BACKUP_URL || process.env.DATABASE_URL_TEST || "";
const [cmd, file] = process.argv.slice(2);

function refuse(reason) {
  console.error(JSON.stringify({ ok: false, error: reason }, null, 2));
  process.exit(2);
}

if (!url) refuse("Set DATABASE_URL_TEST or NONPROD_BACKUP_URL");
if (/production|prod-primary|live-money/i.test(url)) refuse("Refusing production-looking connection string");
if (!cmd || !file) refuse("Usage: backup|restore <file>");
if (!["backup", "restore"].includes(cmd)) refuse("cmd must be backup or restore");

// Extra guard: restore only against databases whose name contains test/fixture/nonprod.
try {
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (cmd === "restore" && !/(test|fixture|nonprod|soak)/i.test(dbName)) {
    refuse(`Refuse restore to database name '${dbName}' — must match test|fixture|nonprod|soak`);
  }
} catch {
  refuse("Invalid connection URL");
}

if (cmd === "restore" && !existsSync(file)) refuse(`Missing backup file ${file}`);

let result;
if (cmd === "backup") {
  result = spawnSync("pg_dump", ["--no-owner", "--no-acl", "--dbname", url, "-f", file], {
    encoding: "utf8",
  });
} else {
  const drop = spawnSync(
    "psql",
    [url, "-v", "ON_ERROR_STOP=1", "-c", "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO CURRENT_USER; GRANT ALL ON SCHEMA public TO public;"],
    { encoding: "utf8" },
  );
  if (drop.status !== 0) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          cmd: "restore",
          file,
          status: drop.status,
          stderr: (drop.stderr || "").slice(0, 500),
          note: "Failed while resetting public schema on nonprod DB",
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }
  result = spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-f", file], { encoding: "utf8" });
}

console.log(
  JSON.stringify(
    {
      ok: result.status === 0,
      cmd,
      file,
      status: result.status,
      stderr: (result.stderr || "").slice(0, 500),
      note: "Non-prod drill only — not a production restore proof",
    },
    null,
    2,
  ),
);
process.exit(result.status === 0 ? 0 : 1);
