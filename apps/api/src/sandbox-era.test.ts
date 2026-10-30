import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withSandboxEraBanner } from "./lab.service.js";

describe("PRE_SANDBOX_FIX labelling", () => {
  it("puts a visible banner at the top of a pre-fix report body", () => {
    const html = withSandboxEraBanner("<html><body class='r'><h1>Report</h1></body></html>", "PRE_SANDBOX_FIX");
    expect(html).toMatch(/<body class='r'><div role="alert"[^>]*>PRE_SANDBOX_FIX/);
    expect(html).toContain("Not valid evidence for promotion");
  });

  it("leaves post-fix reports unchanged", () => {
    const html = "<html><body><h1>Report</h1></body></html>";
    expect(withSandboxEraBanner(html, "STREAMING_FD3")).toBe(html);
  });

  it("labels every existing row PRE_SANDBOX_FIX and new rows STREAMING_FD3", () => {
    const sql = readFileSync(
      new URL("../../../packages/shared/prisma/migrations/20261031090000_pre_sandbox_fix_label/migration.sql", import.meta.url),
      "utf8",
    );
    for (const table of ["ExperimentReport", "BacktestRun", "StrategyArtifact"]) {
      expect(sql).toContain(`ALTER TABLE "${table}" ADD COLUMN "sandboxEra" TEXT NOT NULL DEFAULT 'PRE_SANDBOX_FIX';`);
      expect(sql).toContain(`ALTER TABLE "${table}" ALTER COLUMN "sandboxEra" SET DEFAULT 'STREAMING_FD3';`);
    }
    // No UPDATE: the evidence tables have immutability triggers, and existing rows get the label from the default.
    expect(sql).not.toMatch(/\bUPDATE\b/i);
  });
});
