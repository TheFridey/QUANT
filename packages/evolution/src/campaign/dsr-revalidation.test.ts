import { DSR_PROTOCOL_VERSION } from "@odin/backtest/research";
import { describe, expect, it } from "vitest";
import { registerCampaignModel } from "./bridge.js";

/** OPERATION INTEGRITY F04: results validated under an earlier DSR protocol are never registered without a rerun. */
function fakeUnit(versions: Record<string, unknown>) {
  const holdout = { phase: "HOLDOUT", holdoutStatus: "EVALUATED", verdict: "CANDIDATE", reasons: [], detailCanonical: JSON.stringify({ model: {} }), dataset: {}, provenance: { versions }, resultHash: "a".repeat(64), summary: {}, priorTrials: 0, trialCount: 1 };
  const unit = { id: "u1", hypothesisKind: "ML2", runId: "r1", seq: 1, run: { campaignId: "c1", runNumber: 1, codeVersion: "x", campaign: { synthetic: true, specHash: "s" } }, results: [holdout, { ...holdout, phase: "WALK_FORWARD" }] };
  return { researchCampaignUnit: { findUnique: async () => unit } } as never;
}
const input = { unitId: "u1", registeredBy: "operator:test", instrumentKeys: ["SYNTHETIC:SYNA"], maxStalenessDays: 30, targetEffectiveSignals: 30 };

describe("DSR protocol revalidation gate (F04)", () => {
  it.each([[{}], [{ dsrProtocol: "dsr-1" }], [{ dsrProtocol: "dsr-0.9" }]])("refuses a holdout result validated under %j", async (versions) => {
    await expect(registerCampaignModel(fakeUnit(versions), input)).rejects.toMatchObject({ code: "REVALIDATION_REQUIRED" });
  });
  it("lets a current-protocol result through to the next eligibility check", async () => {
    await expect(registerCampaignModel(fakeUnit({ dsrProtocol: DSR_PROTOCOL_VERSION }), input)).rejects.not.toMatchObject({ code: "REVALIDATION_REQUIRED" });
  });
});
