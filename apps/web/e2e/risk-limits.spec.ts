import { expect, test } from "@playwright/test";
import { apiFromPage, ensureEngineStatus, login, snapshot } from "./helpers";

type History = { revisions: Array<{ actor: string | null; changes: Array<{ key: string; from: unknown; to: unknown }> }> };

test.describe.configure({ mode: "serial" });

test("operator edits PAPER risk limits from Settings through the audited config path", async ({ page }) => {
  await login(page);
  const before = await snapshot(page);
  const original = String(before.engine.config.maxDailyLossPct);
  const originalStatus = before.engine.status;
  const next = original === "4" ? "5" : "4";

  try {
    await ensureEngineStatus(page, "RUNNING");
    await page.goto("/terminal/settings");
    const panel = page.getByRole("form", { name: "Risk limits" });
    await expect(panel).toBeVisible({ timeout: 30_000 });

    // While RUNNING the page refuses to submit and offers the normal pause.
    await panel.getByLabel("Max daily loss %").fill(next);
    await expect(panel.getByRole("button", { name: "Review changes" })).toBeDisabled();
    await panel.getByRole("button", { name: "Pause engine" }).click();
    await expect.poll(async () => (await snapshot(page)).engine.status, { timeout: 15_000 }).toBe("PAUSED");

    // Out-of-range input is caught before anything is sent.
    await panel.getByLabel("Max total drawdown %").fill("150");
    await expect(panel.getByText("Must be between 0.1 and 100")).toBeVisible();
    await expect(panel.getByRole("button", { name: "Review changes" })).toBeDisabled();
    await panel.getByLabel("Max total drawdown %").fill(String(before.engine.config.maxTotalDrawdownPct));

    await panel.getByRole("button", { name: "Review changes" }).click();
    const confirmBox = page.getByRole("alertdialog", { name: "Confirm risk limit changes" });
    await expect(confirmBox).toContainText(`Max daily loss %: ${original} → ${next}`);
    await confirmBox.getByRole("button", { name: "Confirm and save" }).click();
    await expect(panel.getByText(/Risk limits saved/)).toBeVisible({ timeout: 15_000 });

    const after = await snapshot(page);
    expect(String(after.engine.config.maxDailyLossPct)).toBe(next);
    expect(after.engine.config.maxTotalDrawdownPct).toBe(before.engine.config.maxTotalDrawdownPct);
    // Saving never resumes the engine.
    expect(after.engine.status).toBe("PAUSED");

    const history = await apiFromPage<History>(page, "/engine/config/history?limit=5");
    const latest = history.revisions[0];
    expect(latest?.changes).toEqual([{ key: "maxDailyLossPct", from: original, to: next }]);
    expect(latest?.actor).toBeTruthy();
    await expect(panel.getByText(`maxDailyLossPct ${original} → ${next}`)).toBeVisible();
  } finally {
    // Restore the throwaway e2e account for later specs.
    await ensureEngineStatus(page, "PAUSED");
    await apiFromPage(page, "/engine/config", { method: "PATCH", body: { maxDailyLossPct: original } });
    if (originalStatus === "RUNNING") await ensureEngineStatus(page, "RUNNING");
  }
});
