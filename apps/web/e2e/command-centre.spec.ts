import { expect, test } from "@playwright/test";

test("command centre loads live snapshot equity and agent drawer", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Password").fill("odin-paper-dev");
  await page.getByRole("button", { name: /Enter command centre/i }).click();
  await expect(page.getByText("Portfolio equity")).toBeVisible({ timeout: 20_000 });

  const equityText = await page.locator("header .mono").first().innerText();
  const snapshot = await page.evaluate(async () => {
    const token = sessionStorage.getItem("odin_token");
    const base = "http://127.0.0.1:4318";
    const response = await fetch(`${base}/api/terminal/snapshot`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return response.json();
  });

  if (snapshot.portfolio.equityUsd != null) {
    const amount = Number(snapshot.portfolio.equityUsd);
    // UI item 6: dollars carry thousands separators.
    const expected = `$${Math.abs(amount).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const signed = amount < 0 ? `-${expected}` : expected;
    expect(equityText.replace(/\s+/g, " ")).toContain(signed);
  } else {
    expect(equityText).toMatch(/Incomplete/i);
  }

  await page.getByRole("button", { name: /SENTINEL/i }).first().click();
  await expect(page.getByRole("heading", { name: "SENTINEL" })).toBeVisible();
  await expect(page.getByText(/latest cycle inputs, outputs/i)).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("link", { name: "Market Scanner" }).click();
  await expect(page.getByRole("heading", { name: "Market radar" })).toBeVisible();
  // Empty radar intentionally shows both "0 ranked" and "Watchlist empty".
  await expect(page.getByText(/^\d+ ranked$/)).toBeVisible();

  await page.getByRole("link", { name: "Backtesting" }).click();
  await expect(
    page.getByText(/No backtest runs|No backtest session attached|Create a strategy version/i).first(),
  ).toBeVisible();
});

