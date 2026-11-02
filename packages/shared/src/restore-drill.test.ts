import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM script without type declarations
import { checkDrillArgs, connectionEnv, drillDatabaseName, parseConnection } from "../../../scripts/restore-verify.mjs";

describe("restore verification drill guards (APEX §15.3)", () => {
  const scratchName = drillDatabaseName(new Date("2026-11-02T10:11:12.000Z"));
  const ok = {
    adminUrl: "postgresql://u:p@127.0.0.1:5432/postgres",
    sourceUrl: "postgresql://u:p@127.0.0.1:5432/quant",
    dump: "/srv/quant/backups/x.dump",
    scratchName,
  };

  it("generates a timestamped scratch name", () => {
    expect(scratchName).toBe("odin_restore_drill_20261102101112");
    expect(checkDrillArgs(ok)).toBeNull();
  });

  it("refuses an admin URL that names an application database", () => {
    for (const db of ["quant", "odin", "odin_test"]) {
      expect(checkDrillArgs({ ...ok, adminUrl: `postgresql://u:p@127.0.0.1:5432/${db}` })).toMatch(/maintenance database/);
    }
    expect(checkDrillArgs({ ...ok, adminUrl: "" })).toMatch(/RESTORE_ADMIN_URL/);
  });

  it("refuses query parameters that libpq would let override the database (reviewer B+C H-1)", () => {
    expect(checkDrillArgs({ ...ok, adminUrl: "postgresql://u:p@127.0.0.1:5432/postgres?dbname=quant" })).toMatch(/dbname/);
    expect(checkDrillArgs({ ...ok, adminUrl: "postgresql://u:p@127.0.0.1:5432/postgres?service=prod" })).toMatch(/service/);
    expect(checkDrillArgs({ ...ok, adminUrl: "postgresql://u:p@127.0.0.1:5432/postgres?options=-c%20x" })).toMatch(/options/);
    expect(checkDrillArgs({ ...ok, sourceUrl: "postgresql://u:p@127.0.0.1:5432/quant?dbname=other" })).toMatch(/dbname/);
    expect(checkDrillArgs({ ...ok, adminUrl: "postgresql://u:p@127.0.0.1:5432/postgres#x" })).toMatch(/fragment/);
    // sslmode is the one allowed parameter.
    expect(checkDrillArgs({ ...ok, adminUrl: "postgresql://u:p@127.0.0.1:5432/postgres?sslmode=require" })).toBeNull();
  });

  it("passes the target only through libpq environment variables, never a URL on argv", () => {
    const conn = parseConnection("postgresql://drill:s%40cret@db.internal:6543/postgres?sslmode=require");
    expect(conn).toMatchObject({ host: "db.internal", port: "6543", user: "drill", password: "s@cret", database: "postgres", sslmode: "require" });
    const env = connectionEnv(conn, scratchName);
    expect(env.PGDATABASE).toBe(scratchName);
    expect(env.PGPASSWORD).toBe("s@cret");
    expect(env.PGSSLMODE).toBe("require");
    expect(env.PGSERVICE).toBeUndefined();
  });

  it("ignores inherited libpq variables, decodes IPv6 hosts and reports bad encoding (re-review LOWs)", () => {
    const saved = { PGHOSTADDR: process.env.PGHOSTADDR, PGOPTIONS: process.env.PGOPTIONS };
    process.env.PGHOSTADDR = "10.0.0.9";
    process.env.PGOPTIONS = "-c search_path=evil";
    try {
      const env = connectionEnv(parseConnection("postgresql://u:p@127.0.0.1:5432/postgres"), "postgres");
      expect(env.PGHOSTADDR).toBeUndefined();
      expect(env.PGOPTIONS).toBeUndefined();
      const readOnly = connectionEnv(parseConnection("postgresql://u:p@127.0.0.1:5432/quant"), "quant", { PGOPTIONS: "-c default_transaction_read_only=on" });
      expect(readOnly.PGOPTIONS).toBe("-c default_transaction_read_only=on");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    expect(parseConnection("postgresql://u:p@[::1]:5432/postgres").host).toBe("::1");
    expect(checkDrillArgs({ ...ok, adminUrl: "postgresql://u:%zz@127.0.0.1:5432/postgres" })).toMatch(/percent-encoding/);
  });

  it("requires a source to compare against, and refuses bad names", () => {
    expect(checkDrillArgs({ ...ok, sourceUrl: undefined })).toMatch(/--source-url is required/);
    expect(checkDrillArgs({ ...ok, sourceUrl: "postgresql://u:p@127.0.0.1:5432/postgres" })).toMatch(/application database/);
    expect(checkDrillArgs({ ...ok, scratchName: "quant" })).toMatch(/not a generated drill name/);
    expect(checkDrillArgs({ ...ok, sourceUrl: `postgresql://u:p@127.0.0.1:5432/${scratchName}` })).toMatch(/same/);
    expect(checkDrillArgs({ ...ok, dump: undefined })).toMatch(/--dump/);
    expect(checkDrillArgs({ ...ok, adminUrl: "mysql://u:p@h/postgres" })).toMatch(/postgresql/);
  });
});
