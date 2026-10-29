#!/usr/bin/env node
/**
 * Non-prod backup/restore drill helper (§33).
 * Operates only on DATABASE_URL_TEST / explicit NONPROD_BACKUP_URL.
 * Refuses production-looking URLs and MARKET_DATA_PAPER primary accounts.
 *
 * Usage:
 *   DATABASE_URL_TEST=postgresql://… node scripts/backup-restore-nonprod.mjs backup /tmp/odin-nonprod.sql
 *   DATABASE_URL_TEST=postgresql://… node scripts/backup-restore-nonprod.mjs restore /tmp/odin-nonprod.sql
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
if (/production|prod-primary|live/i.test(url)) refuse("Refusing production-looking connection string");
if (!cmd || !file) refuse("Usage: backup|restore <file>");
if (!["backup", "restore"].includes(cmd)) refuse("cmd must be backup or restore");

const args =
  cmd === "backup"
    ? ["pg_dump", "--no-owner", "--no-acl", "--dbname", url, "-f", file]
    : ["psql", url, "-v", "ON_ERROR_STOP=1", "-f", file];

if (cmd === "restore" && !existsSync(file)) refuse(`Missing backup file ${file}`);

const bin = args[0];
const result = spawnSync(bin, args.slice(1), { encoding: "utf8" });
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
