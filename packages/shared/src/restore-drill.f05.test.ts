import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error -- plain ESM script without type declarations
import { APPEND_ONLY_TABLES, GUARDED_TABLES, UPDATE_ONLY_IMMUTABLE_TABLES, checkDrillArgs, drillDatabaseName, main, parseConnection, probePassed, probeTable } from "../../../scripts/restore-verify.mjs";

/**
 * OPERATION INTEGRITY F05 + F12. Every process call is mocked: no psql/pg_restore runs and no SQL reaches
 * any database. These prove ordering (refusal before any destructive command) and parsing, not a real restore.
 */

const legacyScript = fileURLToPath(new URL("../../../scripts/backup-restore-nonprod.mjs", import.meta.url));
const verifyScript = fileURLToPath(new URL("../../../scripts/restore-verify.mjs", import.meta.url));
const existingFile = verifyScript; // any file that exists stands in for a dump

type Call = { cmd: string; args: string[]; env: Record<string, string | undefined> };

function recorder(responses: (call: Call) => { status: number; stdout?: string; stderr?: string } = () => ({ status: 0, stdout: "" })) {
  const calls: Call[] = [];
  const spawn = vi.fn((cmd: string, args: string[], options: { env: Record<string, string | undefined> }) => {
    const call = { cmd, args, env: options.env };
    calls.push(call);
    const r = responses(call);
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  });
  return { calls, spawn };
}

const sqlOf = (call: Call) => call.args[call.args.indexOf("-c") + 1] ?? "";

let savedExit: typeof process.exitCode;
let savedAdmin: string | undefined;
beforeEach(() => {
  savedExit = process.exitCode;
  savedAdmin = process.env.RESTORE_ADMIN_URL;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  process.exitCode = savedExit;
  if (savedAdmin === undefined) delete process.env.RESTORE_ADMIN_URL;
  else process.env.RESTORE_ADMIN_URL = savedAdmin;
  vi.restoreAllMocks();
});

describe("legacy backup-restore-nonprod helper is retired (F05)", () => {
  it("refuses every invocation, including a URL whose query redirects the target, without spawning anything", () => {
    // Code only: the header comment describes the old behaviour.
    const code = readFileSync(legacyScript, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/import|require\(|child_process|spawn|DROP SCHEMA/);
    const run = spawnSync(process.execPath, [legacyScript, "restore", existingFile], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL_TEST: "postgresql://u:secretpw@127.0.0.1:5432/odin_test?dbname=quant&host=prod.example" },
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/retired/);
    expect(run.stderr + run.stdout).not.toContain("secretpw");
  });
});

describe("restore-verify refuses unsafe targets before any process is spawned (F05)", () => {
  const scratchName = drillDatabaseName(new Date("2026-11-12T10:00:00.000Z"));
  const ok = { adminUrl: "postgresql://u:p@127.0.0.1:5432/postgres", sourceUrl: "postgresql://u:p@127.0.0.1:5432/quant", dump: "/x.dump", scratchName };

  it.each([
    ["dbname override", "postgresql://u:p@127.0.0.1:5432/postgres?dbname=quant", /dbname/],
    ["host override", "postgresql://u:p@127.0.0.1:5432/postgres?host=prod.example", /host/],
    ["hostaddr override", "postgresql://u:p@127.0.0.1:5432/postgres?hostaddr=10.0.0.1", /hostaddr/],
    ["port override", "postgresql://u:p@127.0.0.1:5432/postgres?port=6543", /port/],
    ["service file", "postgresql://u:p@127.0.0.1:5432/postgres?service=prod", /service/],
    ["encoded key", "postgresql://u:p@127.0.0.1:5432/postgres?db%6Eame=quant", /dbname/],
    ["upper-case key", "postgresql://u:p@127.0.0.1:5432/postgres?DBNAME=quant", /DBNAME/],
    ["fragment", "postgresql://u:p@127.0.0.1:5432/postgres#quant", /fragment/],
    ["two path segments", "postgresql://u:p@127.0.0.1:5432/postgres/quant", /exactly one database/],
    ["encoded slash in path", "postgresql://u:p@127.0.0.1:5432/postgres%2Fquant", /exactly one database/],
    ["no database", "postgresql://u:p@127.0.0.1:5432/", /exactly one database/],
    ["malformed URL", "postgresql://u:p@[bad/postgres", /not a valid URL/],
    ["bad encoding", "postgresql://u:%zz@127.0.0.1:5432/postgres", /percent-encoding/],
    ["keyword/value string", "host=127.0.0.1 dbname=postgres", /not a valid URL|postgresql/],
  ])("refuses an admin URL with %s", (_label, adminUrl, pattern) => {
    expect(checkDrillArgs({ ...ok, adminUrl })).toMatch(pattern);
  });

  it("decodes the database name before checking it is a maintenance database", () => {
    expect(parseConnection("postgresql://u:p@127.0.0.1:5432/%70ostgres").database).toBe("postgres");
    expect(checkDrillArgs({ ...ok, adminUrl: "postgresql://u:p@127.0.0.1:5432/%71uant" })).toMatch(/maintenance database/);
  });

  it("spawns nothing when arguments are refused, and never puts a password on argv", () => {
    process.env.RESTORE_ADMIN_URL = "postgresql://u:secretpw@127.0.0.1:5432/postgres?dbname=quant";
    const { calls, spawn } = recorder();
    expect(main(["node", "restore-verify.mjs", "--dump", existingFile, "--source-url", "postgresql://u:p@127.0.0.1:5432/quant"], spawn)).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it("refuses to restore when the scratch connection reports a different database, and only drops the scratch name", () => {
    process.env.RESTORE_ADMIN_URL = "postgresql://u:secretpw@127.0.0.1:5432/postgres";
    const { calls, spawn } = recorder((call) => (sqlOf(call) === "SELECT current_database()" ? { status: 0, stdout: "quant\n" } : { status: 0, stdout: "" }));
    expect(main(["node", "restore-verify.mjs", "--dump", existingFile, "--source-url", "postgresql://u:p@127.0.0.1:5432/quant"], spawn)).toBe(1);
    expect(calls.some((c) => c.cmd === "pg_restore")).toBe(false);
    const statements = calls.map(sqlOf);
    expect(statements[0]).toMatch(/^CREATE DATABASE "odin_restore_drill_\d{14}"$/);
    expect(statements.at(-1)).toMatch(/^DROP DATABASE IF EXISTS "odin_restore_drill_\d{14}"$/);
    expect(statements.some((s) => /DROP SCHEMA|DROP DATABASE IF EXISTS "quant"/.test(s))).toBe(false);
    for (const call of calls) {
      expect(call.args.join(" ")).not.toContain("secretpw");
      expect(call.args.join(" ")).not.toMatch(/postgres(ql)?:\/\//);
      expect(call.env.PGPASSWORD).toBe("secretpw");
    }
  });
});

describe("restore verification covers campaign tables and checks trigger behaviour (F12)", () => {
  it("lists the research campaign and GENESIS append-only tables and the guarded mutable-state tables", () => {
    for (const table of ["ResearchCampaign", "ResearchCampaignEvent", "ResearchCampaignResult", "ResearchCampaignRun", "ResearchHoldoutLedger", "ResearchTrialLedger", "ShadowPrediction", "ShadowOutcome", "ModelVersion"]) {
      expect(APPEND_ONLY_TABLES).toContain(table);
    }
    expect(GUARDED_TABLES).toEqual(["ResearchCampaignRunState", "ResearchCampaignUnit"]);
  });

  const triggers = ["ResearchCampaignEvent.ResearchCampaignEvent_append_only", "ResearchCampaignEvent.ResearchCampaignEvent_no_truncate"];

  it("fails a table whose trigger exists by name but does not reject TRUNCATE (behaviour, not presence)", () => {
    const run = () => ({ status: 0, stderr: "" }); // TRUNCATE succeeded: the trigger is present but inert
    const probe = probeTable(run, "ResearchCampaignEvent", 0, triggers);
    expect(probe.triggers).toHaveLength(1);
    expect(probe.truncateRejected).toBe(false);
    expect(probePassed(probe)).toBe(false);
  });

  it("passes when DELETE and TRUNCATE are both rejected with the trigger's own error", () => {
    const run = () => ({ status: 1, stderr: 'ERROR:  ResearchCampaignEvent is append-only (EVIDENCE)' });
    const probe = probeTable(run, "ResearchCampaignEvent", 3, triggers);
    expect(probe).toMatchObject({ deleteRejected: true, truncateRejected: true });
    expect(probePassed(probe)).toBe(true);
  });

  it("probes TRUNCATE with CASCADE and only credits a rejection that names this table", () => {
    const seen: string[] = [];
    const fkError = (sql: string) => {
      seen.push(sql);
      return { status: 1, stderr: 'ERROR:  cannot truncate a table referenced in a foreign key constraint' };
    };
    expect(probeTable(fkError, "ResearchCampaignEvent", 0, triggers).truncateRejected).toBe(false);
    expect(seen[0]).toBe('BEGIN; TRUNCATE "ResearchCampaignEvent" CASCADE; ROLLBACK;');
    const otherTable = () => ({ status: 1, stderr: "ERROR:  ResearchCampaignResult is append-only (EVIDENCE)" });
    expect(probeTable(otherTable, "ResearchCampaignEvent", 0, triggers).truncateRejected).toBe(false);
  });

  it("does not count an unrelated SQL error as trigger rejection", () => {
    const run = () => ({ status: 1, stderr: 'ERROR:  permission denied for table "ResearchCampaignEvent"' });
    expect(probePassed(probeTable(run, "ResearchCampaignEvent", 3, triggers))).toBe(false);
  });

  it("accepts the guard trigger's 'never deleted' error for mutable-state tables", () => {
    const guard = ["ResearchCampaignUnit.ResearchCampaignUnit_guard", "ResearchCampaignUnit.ResearchCampaignUnit_no_truncate"];
    const run = (sql: string) => ({ status: 1, stderr: sql.includes("TRUNCATE") ? "ERROR:  ResearchCampaignUnit is append-only (EVIDENCE)" : "ERROR:  ResearchCampaignUnit rows are never deleted (EVIDENCE)" });
    expect(probePassed(probeTable(run, "ResearchCampaignUnit", 2, guard))).toBe(true);
  });

  it("fails a listed table that has no named trigger at all", () => {
    expect(probePassed(probeTable(() => ({ status: 1, stderr: "" }), "ResearchTrialLedger", 0, []))).toBe(false);
  });
});

describe("Phase II F12: UPDATE-only immutable tables are probed with an UPDATE, not a DELETE", () => {
  const triggers = ["CyclePlan.CyclePlan_immutable"];
  it("CyclePlan with rows: an allowed DELETE is not mistaken for a broken trigger", () => {
    const seen: string[] = [];
    const run = (sql: string) => {
      seen.push(sql);
      return /UPDATE "CyclePlan"/.test(sql) ? { status: 3, stderr: "ERROR:  CyclePlan is append-only evidence" } : { status: 0, stderr: "" };
    };
    const probe = probeTable(run, "CyclePlan", 10, triggers);
    expect(seen.some((q) => q.includes("DELETE"))).toBe(false);
    expect(probe).toMatchObject({ deleteRejected: null, updateRejected: true });
    expect(probePassed(probe)).toBe(true);
  });
  it("an inert CyclePlan trigger (UPDATE succeeds) still fails the drill", () => {
    const probe = probeTable(() => ({ status: 0, stderr: "" }), "CyclePlan", 10, triggers);
    expect(probe.updateRejected).toBe(false);
    expect(probePassed(probe)).toBe(false);
  });
  it("only CyclePlan is UPDATE-only among the listed tables", () => {
    expect([...UPDATE_ONLY_IMMUTABLE_TABLES]).toEqual(["CyclePlan"]);
    expect(APPEND_ONLY_TABLES).toContain("CyclePlan");
  });
});
