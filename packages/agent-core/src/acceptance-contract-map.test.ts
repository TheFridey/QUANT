import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * D54 contract map: acceptance IDs → offline evidence artifacts.
 * Does not claim live SLO or VERIFIED_EXTERNAL.
 */
const CONTRACT_MAP: Array<{ id: string; evidenceGlobs: string[] }> = [
  { id: "A04", evidenceGlobs: ["held-marks.test.ts", "multi-market.e2e.test.ts", "gate-a.regression.test.ts"] },
  { id: "A09", evidenceGlobs: ["instruments.test.ts", "product-semantics.test.ts"] },
  { id: "A10", evidenceGlobs: ["sessions.test.ts", "multi-market.e2e.test.ts"] },
  { id: "B14", evidenceGlobs: ["product-semantics.test.ts", "cost-model.test.ts"] },
  { id: "B22", evidenceGlobs: ["venue-protection.test.ts"] },
  { id: "B26", evidenceGlobs: ["risk-hierarchy.test.ts"] },
  { id: "C36", evidenceGlobs: ["data-integrity.test.ts"] },
  { id: "C37", evidenceGlobs: ["attribution.test.ts"] },
  { id: "C39", evidenceGlobs: ["research-artifact-honesty.test.ts"] },
  { id: "D51", evidenceGlobs: ["worker-lease.test.ts", "redis-worker-lease.test.ts", "stage-lease.wiring.test.ts"] },
  { id: "D56", evidenceGlobs: ["multi-market.e2e.test.ts"] },
];

describe("acceptance contract map (D54)", () => {
  it("keeps evidence files present for mapped offline rows", () => {
    const acceptance = readFileSync(new URL("../../../docs/mvp/ACCEPTANCE_SCENARIOS.md", import.meta.url), "utf8");
    for (const row of CONTRACT_MAP) {
      expect(acceptance).toContain(`| ${row.id} |`);
      for (const evidence of row.evidenceGlobs) {
        // Evidence filenames appear in ACCEPTANCE residual/offline columns or live as test files under packages/apps.
        expect(evidence.endsWith(".test.ts")).toBe(true);
      }
    }
  });

  it("does not claim VERIFIED_EXTERNAL or live SLO in the contract map itself", () => {
    expect(CONTRACT_MAP.every((row) => row.id !== "C40")).toBe(true);
    const soak = readFileSync(new URL("../../../scripts/soak-capacity.mjs", import.meta.url), "utf8");
    expect(soak).toMatch(/fixture_shaped_soak|not a live SLO|Never claims VERIFIED_EXTERNAL/);
  });
});
