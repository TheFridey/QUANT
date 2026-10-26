import { expect, test } from "@playwright/test";

test("login gate states that trading is paper only", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "ODIN // QUANT" })).toBeVisible();
  await expect(page.getByText(/No wallet, no private keys, no live order routing/i)).toBeVisible();
  await page.getByLabel("Password").fill("short");
  await expect(page.getByRole("button", { name: /Enter command centre/i })).toBeDisabled();
});
