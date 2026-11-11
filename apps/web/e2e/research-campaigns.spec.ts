import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { apiFromPage, login } from "./helpers";

/**
 * OPERATION EVIDENCE browser journey on a SYNTHETIC campaign: the campaign CLI declares and runs a small
 * campaign on a constructed series, then an operator reads its evidence in the terminal, authorises one
 * holdout read, and sees the evaluated holdout. Nothing here is market evidence.
 */
const CLI = resolve(__dirname, "../../worker/dist/src/research/campaign-cli.js");

function cli(args: string[], cwd: string): Record<string, unknown> {
  const out = execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: process.env, timeout: 300_000 });
  return JSON.parse(out) as Record<string, unknown>;
}

type RunDetail = { units: Array<{ id: string; hypothesisId: string; stage: { stage: string | null; status: string }; walkForward: { walkForwardPassed: boolean } | null; holdout: { holdoutStatus: string } | null }> };

test("operator follows a research campaign from declaration to an evaluated holdout", async ({ page }) => {
  test.setTimeout(600_000);
  const tag = `${Date.now().toString(36)}`.toUpperCase();
  const dir = mkdtempSync(join(tmpdir(), "odin-e2e-campaign-"));
  cli(["synthetic-fixture", "fx-breakout", "fixture.csv"], dir);
  const name = `SYNTHETIC e2e journey ${tag}`;
  writeFileSync(
    join(dir, "campaign.json"),
    JSON.stringify({
      specVersion: "campaign-spec-1",
      name,
      synthetic: true,
      datasets: [{ key: "synthetic-fx", source: { kind: "FILE", path: "fixture.csv", sha256: createHash("sha256").update(readFileSync(join(dir, "fixture.csv"))).digest("hex") }, market: "FX", instrument: `SYN${tag}/USD`, interval: "1h", asOf: "2026-01-01T00:00:00Z" }],
      hypotheses: ["hz_atr_breakout", "hz_vol_expansion", "hz_mtf_trend", "hz_vol_mean_reversion", "hz_regime_breakout", "hz_session_breakout"].map((id) => ({ kind: "STRATEGY", id })),
      validation: { seed: 1 },
      ml: { seed: 1 },
      limits: { maxTrials: 5000, maxRuntimeMsPerUnit: 120_000, maxMemoryMbPerUnit: 1024, maxConcurrency: 1, maxAttemptsPerUnit: 2 },
      holdoutPolicy: "WITHHELD_UNLESS_AUTHORIZED",
    }),
  );
  // Dry run first: it writes nothing and reports the trial bound.
  expect(cli(["plan", "campaign.json"], dir)).toMatchObject({ dryRun: true, written: "nothing" });
  const created = cli(["create", "campaign.json", "--by", "e2e"], dir);
  const started = cli(["start", String(created.campaignId), "--by", "e2e"], dir);
  const runId = String(started.runId);
  const worked = cli(["work", runId], dir);
  expect(worked.state).toBe("COMPLETED");

  await login(page);
  const before = await apiFromPage<RunDetail>(page, `/research/campaigns/runs/${runId}`);
  expect(before.units).toHaveLength(6);
  // Default operation read no holdout.
  expect(before.units.every((u) => u.holdout === null)).toBe(true);
  const pending = before.units.find((u) => u.stage.stage === "PENDING_HOLDOUT");
  const rejected = before.units.find((u) => u.walkForward && !u.walkForward.walkForwardPassed);
  expect(pending, "the planted pattern should leave at least one hypothesis pending its holdout").toBeTruthy();
  expect(rejected, "at least one family should be rejected on this fixture").toBeTruthy();

  await page.goto("/terminal/radar");
  // The scanner separates market data from execution, and treats a market with no campaign as unknown.
  const gold = page.getByRole("listitem", { name: "XAUUSD readiness" });
  await expect(gold).toBeVisible({ timeout: 30_000 });
  await expect(gold).toContainText("Live market data");
  await expect(gold).toContainText("Execution path");
  await expect(gold).toContainText("no campaign has run (unknown)");

  // What ran, on which data, under which assumptions.
  await expect(page.getByLabel("Programme trial count")).toContainText("Trials run across the whole programme");
  const campaign = page.getByRole("listitem", { name: `Campaign ${name}` });
  await expect(campaign).toBeVisible();
  await expect(campaign).toContainText("Synthetic fixture");
  await expect(campaign).toContainText("Not evidence about any market");
  await campaign.getByRole("button", { name: `Evidence for ${name}` }).click();
  await expect(page.getByText(`Evidence · ${name}`)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("list", { name: "Datasets" })).toContainText(`SYN${tag}/USD`);
  await expect(page.getByRole("list", { name: "Datasets" })).toContainText("FX_24_5 calendar");
  await expect(page.getByText("Withheld unless an operator authorises one read")).toBeVisible();
  await expect(page.getByText(/Costs: /)).toBeVisible();

  // Why a hypothesis was rejected.
  const rejectedRow = page.getByRole("listitem", { name: `Hypothesis ${rejected!.hypothesisId} on synthetic-fx` });
  await expect(rejectedRow).toContainText("Historical result");
  await expect(rejectedRow).toContainText("Rejected because:");

  // Pending holdout: missing evidence, next steps, and no claim of being executable.
  const row = page.getByRole("listitem", { name: `Hypothesis ${pending!.hypothesisId} on synthetic-fx` });
  await expect(row).toContainText("Pending holdout");
  await row.getByRole("button", { name: `Details for ${pending!.hypothesisId} on synthetic-fx` }).click();
  await expect(row.getByRole("list", { name: "Evidence ladder" })).toContainText("6. Paper-execution readiness");
  await expect(row.getByLabel("Paper-execution readiness: not reached")).toBeVisible();
  await expect(row).toContainText("Not an executable strategy at any step");
  await expect(row.getByRole("list", { name: "Missing evidence" })).toContainText("the once-only holdout evaluation");
  await expect(row).toContainText("Withheld. Period");
  await expect(row).toContainText("Not under observation. Prospective results are unknown, not zero.");

  // The operator authorises one read; the read itself is a separate, recorded step.
  await row.getByRole("button", { name: `Authorise one holdout read for ${pending!.hypothesisId}` }).click();
  await expect(page.getByRole("status")).toContainText("Holdout read authorised", { timeout: 15_000 });
  const authorised = await apiFromPage<RunDetail>(page, `/research/campaigns/runs/${runId}`);
  expect(authorised.units.find((u) => u.id === pending!.id)!.stage.status).toBe("AUTHORISED_NOT_EVALUATED");
  const evaluated = cli(["evaluate-holdout", pending!.id], dir);
  expect(evaluated.status).toBe("RECORDED");
  // A second attempt reads nothing.
  expect(cli(["evaluate-holdout", pending!.id], dir).status).toBe("ALREADY_CLOSED");

  await page.reload();
  const campaignAgain = page.getByRole("listitem", { name: `Campaign ${name}` });
  await campaignAgain.getByRole("button", { name: `Evidence for ${name}` }).click();
  const after = page.getByRole("listitem", { name: `Hypothesis ${pending!.hypothesisId} on synthetic-fx` });
  await expect(after).toContainText("Holdout evaluated", { timeout: 15_000 });
  await after.getByRole("button", { name: `Details for ${pending!.hypothesisId} on synthetic-fx` }).click();
  await expect(after.getByRole("list", { name: "Holdout record" })).toContainText("consume intent");
  await expect(after.getByRole("list", { name: "Holdout record" })).toContainText("operator:");
  // Whatever the holdout said, it is still research: rule-based results have no prospective route yet.
  await expect(after).toContainText("Not an executable strategy at any step");
  const final = await apiFromPage<RunDetail>(page, `/research/campaigns/runs/${runId}`);
  expect(final.units.find((u) => u.id === pending!.id)!.holdout!.holdoutStatus).toBe("EVALUATED");
  expect(final.units.filter((u) => u.holdout !== null)).toHaveLength(1);
});
