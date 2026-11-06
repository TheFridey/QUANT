import { expect, test } from "@playwright/test";
import { apiFromPage, login } from "./helpers";

type Opportunities = {
  markets: Array<{ id: string; readiness: { state: string } }>;
  leaderboard: { selected: number };
};

test("market scanner shows honest gold/FX readiness and an abstaining leaderboard", async ({ page }) => {
  await login(page);

  // The API never calls a registry-only market READY: gold has no provider.
  const data = await apiFromPage<Opportunities>(page, "/research/opportunities");
  const gold = data.markets.find((m) => m.id === "commodity:XAUUSD");
  expect(gold?.readiness.state).toBe("NO_PROVIDER");
  const eurusd = data.markets.find((m) => m.id === "fx:EURUSD");
  expect(eurusd?.readiness.state).not.toBe("PAPER_EXECUTABLE");
  // The e2e database has no GENESIS shadow evidence, so the scanner abstains everywhere.
  expect(data.leaderboard.selected).toBe(0);

  await page.goto("/terminal/radar");
  const goldRow = page.getByRole("listitem", { name: "XAUUSD readiness" });
  await expect(goldRow).toBeVisible({ timeout: 30_000 });
  await expect(goldRow).toContainText("NO_PROVIDER");
  await expect(goldRow).toContainText("Cannot trade:");
  await expect(goldRow).toContainText("No market-data provider routes commodity:XAUUSD");

  const fxRow = page.getByRole("listitem", { name: "EURUSD readiness" });
  await expect(fxRow).toBeVisible();
  await expect(fxRow).toContainText("Cannot trade:");
  await expect(fxRow).not.toContainText("PAPER_EXECUTABLE");

  await expect(page.getByText("No opportunity clears costs")).toBeVisible();
  await expect(page.getByRole("list", { name: "Abstention reasons" })).toContainText("NOT_EVALUATED: NO_PROVIDER");

  // Per-market diagnostics list every readiness check.
  await goldRow.getByRole("button", { name: "Diagnostics for XAUUSD" }).click();
  await expect(page.getByText("Diagnostics · XAUUSD")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Readiness checks")).toBeVisible();
});
