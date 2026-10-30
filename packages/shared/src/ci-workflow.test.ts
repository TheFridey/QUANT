import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Audit L8: keep the CI workflow hardened (read-only token, one run per ref, actions pinned by SHA). */
const workflow = readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");

describe("CI workflow hardening", () => {
  it("grants the token read-only repository contents", () => {
    expect(workflow).toMatch(/^permissions:\n {2}contents: read$/m);
  });

  it("cancels superseded runs for the same ref", () => {
    expect(workflow).toMatch(/^concurrency:\n {2}group: ci-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: true$/m);
  });

  it("runs on pull requests and on pushes to main only", () => {
    expect(workflow).toMatch(/^on:\n {2}pull_request:\n {2}push:\n {4}branches: \[main\]$/m);
  });

  it("keeps the browser stack paper-only on the deterministic feed", () => {
    expect(workflow).toContain("EXECUTION_MODE: PAPER");
    expect(workflow).toContain('LIVE_MONEY_ENABLED: "false"');
    expect(workflow).toContain("ODIN_MARKET_FEED: deterministic");
    expect(workflow).not.toMatch(/LIVE_MONEY_CONFIRM|LIVE_MONEY_ENABLED:\s*"?true/);
  });

  it("pins every action to a full commit SHA with its exact version noted", () => {
    for (const line of workflow.split("\n").filter((row) => row.includes("uses:"))) {
      expect(line, line).toMatch(/@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
    }
  });

  it("pins every action to a full commit SHA", () => {
    const uses = [...workflow.matchAll(/uses:\s*(\S+)/g)].map((match) => match[1]!);
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) expect(ref, ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });
});
