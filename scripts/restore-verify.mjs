#!/usr/bin/env node
/**
 * Isolated restore verification drill (APEX §15.3).
 *
 * Restores a custom-format dump (`pg_dump -Fc`, as written by the VPS `quant-backup.service`) into a NEW
 * scratch database, verifies it against the live source (read-only), and drops it. It never writes to an
 * existing database:
 *
 *   RESTORE_ADMIN_URL=postgresql://user:pass@127.0.0.1:5432/postgres \
 *     node scripts/restore-verify.mjs --dump /srv/quant/backups/quant-YYYYMMDDTHHMMSSZ.dump \
 *       --source-url postgresql://user:pass@127.0.0.1:5432/quant [--keep]
 *
 * Guards (all fail closed):
 * - URLs are parsed into host, port, user, password and database, and passed to psql/pg_restore only as
 *   libpq environment variables. No URL is passed on a command line, so a query parameter such as
 *   `?dbname=` cannot redirect the connection, and the password never appears in `ps`. Any query parameter
 *   other than `sslmode`, and any fragment, is refused.
 * - the admin URL must name a maintenance database (postgres/template1)
 * - the scratch database name is generated (`odin_restore_drill_<utc stamp>`); CREATE DATABASE fails if it
 *   exists, and `current_database()` on the scratch connection must equal that name before pg_restore runs
 * - the source is opened with `default_transaction_read_only=on` and only counted
 * - the scratch database is dropped afterwards unless `--keep`
 *
 * Pass criteria: pg_restore exits 0; a non-empty latest Prisma migration; every user trigger in the source
 * exists in the restore; each listed append-only or guarded table has its named trigger, a table with rows
 * still rejects DELETE with the trigger's own error, and a table with a `_no_truncate` trigger rejects
 * TRUNCATE; no table is missing or extra; no restored count exceeds the source (lower counts are drift,
 * because a live database keeps growing after the dump). A listable backup file is not evidence: only a
 * run that ends `"ok": true` shows the dump restores and verifies.
 *
 * Use a drill role without superuser where possible: a tampered dump runs SQL with the restoring role.
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const DRILL_PREFIX = "odin_restore_drill_";
const MAINTENANCE_DBS = new Set(["postgres", "template1"]);
/** Tables whose append-only or immutable triggers must survive a restore, with the trigger name suffix. */
export const APPEND_ONLY_TABLES = [
  "CyclePlan",
  "EngineConfigRevision",
  "ExperimentReport",
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
  // F12: research campaign evidence and GENESIS model/shadow tables (migrations 2026-11).
  "ModelLifecycleEvent",
  "ModelPaperApproval",
  "ModelVersion",
  "ResearchCampaign",
  "ResearchCampaignEvent",
  "ResearchCampaignResult",
  "ResearchCampaignRun",
  "ResearchHoldoutLedger",
  "ResearchTrialLedger",
  "ShadowOutcome",
  "ShadowPrediction",
];
/** F12: mutable-state tables whose guard trigger forbids DELETE and identity changes. */
export const GUARDED_TABLES = ["ResearchCampaignRunState", "ResearchCampaignUnit"];
const TRIGGER_NAME = /_(append_only|immutable|evidence_immutable|guard)$/;
const TRIGGER_ERROR = /append-only|EVIDENCE_IMMUTABLE|immutable|never deleted/i;

export function drillDatabaseName(now = new Date()) {
  return `${DRILL_PREFIX}${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
}

/**
 * Parse a postgres URL into libpq parts. Refuses anything that could change the target outside the path:
 * query parameters other than sslmode, fragments, and a missing database name.
 */
export function parseConnection(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { error: "not a valid URL" };
  }
  if (u.protocol !== "postgresql:" && u.protocol !== "postgres:") return { error: "must be a postgresql:// URL" };
  if (u.hash) return { error: "fragments are not allowed" };
  for (const key of u.searchParams.keys()) {
    if (key !== "sslmode") return { error: `query parameter '${key}' is not allowed (it could redirect the connection)` };
  }
  let database, user, password;
  try {
    database = decodeURIComponent(u.pathname.replace(/^\//, ""));
    user = decodeURIComponent(u.username);
    password = decodeURIComponent(u.password);
  } catch {
    return { error: "has malformed percent-encoding" };
  }
  if (!database || database.includes("/")) return { error: "must name exactly one database in the path" };
  return {
    // WHATWG URL keeps IPv6 brackets ("[::1]"); libpq wants the bare address.
    host: (u.hostname || "127.0.0.1").replace(/^\[(.*)\]$/, "$1"),
    port: u.port || "5432",
    user,
    password,
    database,
    sslmode: u.searchParams.get("sslmode") ?? undefined,
  };
}

/** Returns an error string, or null when the arguments are acceptable. */
export function checkDrillArgs({ adminUrl, dump, sourceUrl, scratchName }) {
  if (!adminUrl) return "Set RESTORE_ADMIN_URL to a maintenance database (postgres or template1)";
  const admin = parseConnection(adminUrl);
  if (admin.error) return `RESTORE_ADMIN_URL ${admin.error}`;
  if (!MAINTENANCE_DBS.has(admin.database)) return `RESTORE_ADMIN_URL must name a maintenance database, not '${admin.database}'`;
  if (!/^odin_restore_drill_\d{14}$/.test(scratchName)) return `Scratch database name '${scratchName}' is not a generated drill name`;
  if (!sourceUrl) return "--source-url is required: without it a missing table cannot be detected";
  const source = parseConnection(sourceUrl);
  if (source.error) return `--source-url ${source.error}`;
  if (source.database === scratchName) return "Source and scratch database are the same";
  if (MAINTENANCE_DBS.has(source.database)) return "--source-url must name the application database";
  if (!dump) return "--dump <file> is required";
  return null;
}

/** libpq environment for a connection; nothing connection-related goes on the command line. */
export function connectionEnv(conn, database, extra = {}) {
  // Drop every inherited libpq variable (PGHOSTADDR, PGOPTIONS, PGSERVICE, PGTARGETSESSIONATTRS, ...) so
  // only the parsed connection decides where psql and pg_restore connect.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PG")));
  Object.assign(env, { PGHOST: conn.host, PGPORT: conn.port, PGUSER: conn.user, PGPASSWORD: conn.password, PGDATABASE: database, ...extra });
  if (conn.sslmode) env.PGSSLMODE = conn.sslmode;
  return env;
}


const COUNT_SQL = `SELECT string_agg(format('%s=%s', c.relname, (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', c.relname), false, true, '')))[1]::text), ',' ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'`;
const TRIGGERS_SQL = `SELECT string_agg(c.relname || '.' || t.tgname, ',' ORDER BY 1) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT t.tgisinternal`;

/**
 * Behaviour, not just names (F12): a table with rows must reject DELETE with the trigger's own error; a
 * table with a `_no_truncate` trigger must reject TRUNCATE (statement-level, so this works on empty tables
 * too). Every probe runs inside a transaction that is rolled back, on the scratch database only.
 * Returns null for a check that cannot be made (no rows / no truncate trigger).
 */
export function probeTable(run, table, rows, restoredTriggers) {
  const named = restoredTriggers.filter((t) => t.startsWith(`${table}.`) && TRIGGER_NAME.test(t));
  let deleteRejected = null;
  if (rows > 0) {
    const probe = run(`BEGIN; DELETE FROM "${table}"; ROLLBACK;`);
    deleteRejected = probe.status !== 0 && TRIGGER_ERROR.test(probe.stderr || "");
  }
  let truncateRejected = null;
  if (restoredTriggers.includes(`${table}.${table}_no_truncate`)) {
    // CASCADE: a plain TRUNCATE of a table referenced by a foreign key fails on the FK before any trigger
    // fires, which proves nothing. The rejection must also name this table, so a working trigger on a
    // referencing table cannot stand in for an inert one here.
    const probe = run(`BEGIN; TRUNCATE "${table}" CASCADE; ROLLBACK;`);
    const stderr = probe.stderr || "";
    truncateRejected = probe.status !== 0 && TRIGGER_ERROR.test(stderr) && stderr.includes(`${table} is`);
  }
  return { table, rows, triggers: named, deleteRejected, truncateRejected };
}

/** A probed table passes when it has its named trigger and no behaviour probe that ran came back false. */
export function probePassed(probe) {
  return probe.triggers.length > 0 && probe.deleteRejected !== false && probe.truncateRejected !== false;
}

export function main(argv, spawn = spawnSync) {
  const psql = (env, sql) => spawn("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-At", "-c", sql], { encoding: "utf8", env });
  const counts = (env) => {
    const r = psql(env, COUNT_SQL);
    if (r.status !== 0) throw new Error(`count failed: ${(r.stderr || "").slice(0, 300)}`);
    const line = r.stdout.trim();
    return Object.fromEntries(line.split(",").filter(Boolean).map((kv) => { const [k, v] = kv.split("="); return [k, Number(v)]; }));
  };
  const triggers = (env) => {
    const r = psql(env, TRIGGERS_SQL);
    if (r.status !== 0) throw new Error(`trigger listing failed: ${(r.stderr || "").slice(0, 300)}`);
    return r.stdout.trim().split(",").filter(Boolean);
  };
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

  const admin = parseConnection(adminUrl);
  const source = parseConnection(sourceUrl);
  const adminEnv = connectionEnv(admin, admin.database);
  const scratchEnv = connectionEnv(admin, scratchName);
  const sourceEnv = connectionEnv(source, source.database, { PGOPTIONS: "-c default_transaction_read_only=on" });

  const report = { ok: false, dump, dumpBytes: statSync(dump).size, scratchDatabase: scratchName, kept: keep, steps: {} };
  const started = Date.now();
  const create = psql(adminEnv, `CREATE DATABASE "${scratchName}"`);
  if (create.status !== 0) return finish({ ...report, error: `CREATE DATABASE failed: ${(create.stderr || "").slice(0, 300)}` }, 1);
  try {
    const where = psql(scratchEnv, "SELECT current_database()");
    if (where.status !== 0 || where.stdout.trim() !== scratchName) {
      return finish({ ...report, error: `Scratch connection reached '${where.stdout.trim()}', not ${scratchName}; refusing to restore` }, 1);
    }
    const restore = spawn("pg_restore", ["--no-owner", "--no-acl", "--exit-on-error", "-d", scratchName, dump], { encoding: "utf8", env: scratchEnv });
    report.steps.restore = { status: restore.status, stderr: (restore.stderr || "").slice(0, 500) };
    report.restoreSeconds = +((Date.now() - started) / 1000).toFixed(1);
    if (restore.status !== 0) return finish({ ...report, error: "pg_restore failed" }, 1);

    const restored = counts(scratchEnv);
    report.tables = Object.keys(restored).length;
    report.rows = Object.values(restored).reduce((s, n) => s + n, 0);
    const migration = psql(scratchEnv, `SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY finished_at DESC, migration_name DESC LIMIT 1`);
    report.latestMigration = migration.status === 0 && migration.stdout.trim() ? migration.stdout.trim() : null;

    const restoredTriggers = triggers(scratchEnv);
    // Row-level triggers only fire on existing rows, so an empty table cannot show DELETE rejection (null).
    const probe = (table) => probeTable((sql) => psql(scratchEnv, sql), table, restored[table] ?? 0, restoredTriggers);
    report.appendOnly = APPEND_ONLY_TABLES.map(probe);
    report.guarded = GUARDED_TABLES.map(probe);

    const sourceCounts = counts(sourceEnv);
    const sourceTriggers = triggers(sourceEnv);
    const drift = {
      missingTables: Object.keys(sourceCounts).filter((t) => !(t in restored)),
      extraTables: Object.keys(restored).filter((t) => !(t in sourceCounts)),
      missingTriggers: sourceTriggers.filter((t) => !restoredTriggers.includes(t)),
      restoredAboveSource: [],
      belowSource: [],
    };
    for (const [t, n] of Object.entries(restored)) {
      if (t in sourceCounts && n > sourceCounts[t]) drift.restoredAboveSource.push({ table: t, restored: n, source: sourceCounts[t] });
      if (t in sourceCounts && n < sourceCounts[t]) drift.belowSource.push({ table: t, restored: n, source: sourceCounts[t] });
    }
    report.sourceComparison = drift;

    const triggersOk = [...report.appendOnly, ...report.guarded].every(probePassed);
    const driftOk = drift.missingTables.length === 0 && drift.extraTables.length === 0 && drift.missingTriggers.length === 0 && drift.restoredAboveSource.length === 0;
    report.ok = triggersOk && driftOk && report.latestMigration !== null;
    report.totalSeconds = +((Date.now() - started) / 1000).toFixed(1);
    return finish(report, report.ok ? 0 : 1);
  } finally {
    if (!keep) {
      const drop = psql(adminEnv, `DROP DATABASE IF EXISTS "${scratchName}"`);
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
