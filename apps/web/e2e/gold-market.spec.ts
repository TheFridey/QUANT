import { expect, test } from "@playwright/test";
import { apiFromPage, login } from "./helpers";

type Status = { account: { state: string }; execution: { state: string }; research: { state: string }; shadowFeed: { state: string; persisted: boolean }; executable: boolean };

test("gold market view states facts only: no live price, no account, execution blocked, no order ticket", async ({ page }) => {
  await login(page);
  const status = await apiFromPage<Status>(page, "/aurum/market/status");
  expect(status).toMatchObject({ account: { state: "NOT_CREATED" }, execution: { state: "BLOCKED" }, shadowFeed: { state: "INACTIVE", persisted: false }, executable: false });

  await page.goto("/terminal/gold");
  const section = page.getByTestId("gold-market-section");
  await expect(section).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("gold-status-aurum-account")).toContainText("NOT_CREATED");
  await expect(page.getByTestId("gold-status-execution")).toContainText("BLOCKED");
  await expect(page.getByTestId("gold-status-quotes")).toContainText("NON-EXECUTABLE");
  await expect(section).toContainText("No live reference quote");
  // Either genuine warehouse candles or an honest empty state: never invented candles.
  await expect(page.getByTestId("gold-candle-chart").or(section.getByText("No gold datasets in the warehouse"))).toBeVisible({ timeout: 30_000 });
  // No executable control exists on this view.
  await expect(section.getByRole("button", { name: /buy|sell|place order|open long|open short/i })).toHaveCount(0);
});
