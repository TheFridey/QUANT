import { expect, test } from "@playwright/test";

/**
 * Browser smoke against a running web app (Gate 1 / §35).
 * Requires: web on WEB_ORIGIN (default http://127.0.0.1:4317).
 * Not a full paper lifecycle E2E — login gate + desk copy only when API is unavailable.
 */
test("operator desk surfaces paper-only login constraints", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: /ODIN|QUANT/i })).toBeVisible();
  await expect(page.getByText(/paper|No live order routing|live/i).first()).toBeVisible();
});
