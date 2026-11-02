#!/usr/bin/env node
/**
 * Isolated restore verification drill (APEX §15.3).
 *
 * Restores a custom-format dump (`pg_dump -Fc`, as written by the VPS `quant-backup.service`) into a NEW
 * scratch database, verifies it, and drops it. It never writes to an existing database:
 *
 *   RESTORE_ADMIN_URL=postgresql://user:pass@127.0.0.1:5432/postgres \
 *     node scripts/restore-verify.mjs --dump /srv/quant/backups/quant-YYYYMMDDTHHMMSSZ.dump \
 *       [--source-url postgresql://…/quant] [--keep]
 *
 * Guards (all fail closed):
 * - the scratch database name is generated (`odin_restore_drill_<utc stamp>`); CREATE DATABASE fails if it exists
 * - the admin URL must point at a maintenance database (postgres/template1), never an application database
 * - `--source-url` is used read-only (row counts only, inside a READ ONLY transaction)
 * - the scratch database is dropped afterwards unless `--keep`
 *
 * Verification: pg_restore exits 0; every table's row count; the latest applied Prisma migration; the
 * append-only triggers are present and still reject a DELETE (checked inside a rolled-back transaction);
 * optional comparison with the source (counts can legitimately grow after the dump on a live database, so
 * a restored count above the source's is a failure and below it is reported as drift).
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const DRILL_PREFIX = "odin_restore_drill_";
const MAINTENANCE_DBS = new Set(["postgres", "template1"]);
/** Tables whose append-only triggers must survive a restore. */
export const APPEND_ONLY_TABLES = [
  "CyclePlan",
  "EngineConfigRevision",
  "ForwardPaperResult",
  "HistoricalBar",
  "HistoricalRawBatch",
  "LifecycleAudit",
  "PromotionApproval",
  "ResearchHoldoutAccess",
  "ResearchRun",
  "ResearchTrial",
  "StrategyArtifact",
  "StrategyPromotion",
];

export function drillDatabaseName(now = new Date()) {
  return `${DRILL_PREFIX}${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
}

/** Returns an error string, or null when the arguments are acceptable. */
export function checkDrillArgs({ adminUrl, dump, sourceUrl, scratchName }) {
  if (!adminUrl) return "Set RESTORE_ADMIN_URL to a maintenance database (postgres or template1)";
  let admin;
  try {
    admin = new URL(adminUrl);
  } catch {
    return "RESTORE_ADMIN_URL is not a valid URL";
  }
  const adminDb = admin.pathname.replace(/^\//, "");
  if (!MAINTENANCE_DBS.has(adminDb)) return `RESTORE_ADMIN_URL must name a maintenance database, not '${adminDb}'`;
  if (!/^odin_restore_drill_\d{14}$/.test(scratchName)) return `Scratch database name '${scratchName}' is not a generated drill name`;
  if (sourceUrl) {
    try {
      const sourceDb = new URL(sourceUrl).pathname.replace(/^\//, "");
      if (sourceDb === scratchName) return "Source and scratch database are the same";
    } catch {
      return "--source-url is not a valid URL";
    }
  }
  if (!dump) return "--dump <file> is required";
  return null;
}

function psql(url, sql, extra = []) {
  return spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-At", ...extra, "-c", sql], { encoding: "utf8" });
}

function withDb(url, db) {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

const COUNT_SQL = `SELECT string_agg(format('%s=%s', c.relname, (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', c.relname), false, true, '')))[1]::text), ',' ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'`;

function counts(url, readOnly) {
  const sql = readOnly ? `BEGIN READ ONLY; ${COUNT_SQL}; COMMIT;` : COUNT_SQL;
  const r = psql(url, sql);
  if (r.status !== 0) throw new Error(`count failed: ${(r.stderr || "").slice(0, 300)}`);
  const line = r.stdout.split("\n").find((l) => l.includes("="));
  return Object.fromEntries((line ?? "").split(",").filter(Boolean).map((kv) => { const [k, v] = kv.split("="); return [k, Number(v)]; }));
}

function main(argv) {
  const args = argv.slice(2);
  const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const adminUrl = process.env.RESTORE_ADMIN_URL ?? "";
  const dump = value("--dump");
  const sourceUrl = value("--source-url");
  const keep = args.includes("--keep");
  const scratchName = drillDatabaseName();
  const error = checkDrillArgs({ adminUrl, dump, sourceUrl, scratchName });
  if (error) return finish({ ok: false, error }, 2);
  if (!existsSync(dump)) return finish({ ok: false, error: `Missing dump ${dump}` }, 2);

  const report = { ok: false, dump, dumpBytes: statSync(dump).size, scratchDatabase: scratchName, kept: keep, steps: {} };
  const started = Date.now();
  const create = psql(adminUrl, `CREATE DATABASE "${scratchName}"`);
  if (create.status !== 0) return finish({ ...report, error: `CREATE DATABASE failed: ${(create.stderr || "").slice(0, 300)}` }, 1);
  const scratchUrl = withDb(adminUrl, scratchName);
  try {
    const restore = spawnSync("pg_restore", ["--no-owner", "--no-acl", "--exit-on-error", "-d", scratchUrl, dump], { encoding: "utf8" });
    report.steps.restore = { status: restore.status, stderr: (restore.stderr || "").slice(0, 500) };
    report.restoreSeconds = +((Date.now() - started) / 1000).toFixed(1);
    if (restore.status !== 0) return finish({ ...report, error: "pg_restore failed" }, 1);

    const restored = counts(scratchUrl, false);
    report.tables = Object.keys(restored).length;
    report.rows = Object.values(restored).reduce((s, n) => s + n, 0);
    const migration = psql(scratchUrl, `SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY finished_at DESC, migration_name DESC LIMIT 1`);
    report.latestMigration = migration.status === 0 ? migration.stdout.trim() : null;

    report.appendOnly = APPEND_ONLY_TABLES.map((table) => {
      const trig = psql(scratchUrl, `SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relname = '${table}' AND NOT t.tgisinternal`);
      // Row-level triggers only fire on existing rows, so an empty table cannot show rejection (null).
      const rows = restored[table] ?? 0;
      const probe = rows > 0 ? psql(scratchUrl, `BEGIN; DELETE FROM "${table}"; ROLLBACK;`) : null;
      return { table, rows, triggers: Number(trig.stdout.trim() || 0), deleteRejected: probe ? probe.status !== 0 : null };
    });

    let drift = null;
    if (sourceUrl) {
      const source = counts(sourceUrl, true);
      drift = { missingTables: [], extraTables: [], restoredAboveSource: [], belowSource: [] };
      for (const t of Object.keys(source)) if (!(t in restored)) drift.missingTables.push(t);
      for (const t of Object.keys(restored)) if (!(t in source)) drift.extraTables.push(t);
      for (const [t, n] of Object.entries(restored)) {
        if (t in source && n > source[t]) drift.restoredAboveSource.push({ table: t, restored: n, source: source[t] });
        if (t in source && n < source[t]) drift.belowSource.push({ table: t, restored: n, source: source[t] });
      }
      report.sourceComparison = drift;
    }
    const triggersOk = report.appendOnly.every((a) => a.triggers > 0 && a.deleteRejected !== false);
    const driftOk = !drift || (drift.missingTables.length === 0 && drift.extraTables.length === 0 && drift.restoredAboveSource.length === 0);
    report.ok = triggersOk && driftOk && report.latestMigration !== null;
    report.totalSeconds = +((Date.now() - started) / 1000).toFixed(1);
    return finish(report, report.ok ? 0 : 1);
  } finally {
    if (!keep) {
      const drop = psql(adminUrl, `DROP DATABASE IF EXISTS "${scratchName}"`);
      if (drop.status !== 0) console.error(`WARNING: could not drop ${scratchName}: ${(drop.stderr || "").slice(0, 200)}`);
    }
  }
}

function finish(report, code) {
  console.log(JSON.stringify({ ...report, note: "Isolated restore drill: a NEW scratch database; no existing database was written" }, null, 2));
  process.exitCode = code;
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv);
