import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM script without type declarations
import { checkDrillArgs, drillDatabaseName } from "../../../scripts/restore-verify.mjs";

describe("restore verification drill guards (APEX §15.3)", () => {
  const scratchName = drillDatabaseName(new Date("2026-11-02T10:11:12.000Z"));
  const ok = { adminUrl: "postgresql://u:p@127.0.0.1:5432/postgres", dump: "/srv/quant/backups/x.dump", scratchName };

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

  it("refuses a scratch name that is not generated, and a source equal to the scratch database", () => {
    expect(checkDrillArgs({ ...ok, scratchName: "quant" })).toMatch(/not a generated drill name/);
    expect(checkDrillArgs({ ...ok, sourceUrl: `postgresql://u:p@127.0.0.1:5432/${scratchName}` })).toMatch(/same/);
    expect(checkDrillArgs({ ...ok, dump: undefined })).toMatch(/--dump/);
  });
});
