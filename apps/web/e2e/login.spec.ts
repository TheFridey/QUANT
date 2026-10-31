import { expect, test } from "@playwright/test";
import { API_BASE, login } from "./helpers";

test("login gate states that trading is paper only", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "ODIN // QUANT" })).toBeVisible();
  await expect(page.getByText(/No wallet, no private keys, no live order routing/i)).toBeVisible();
  await page.getByLabel("Password").fill("short");
  await expect(page.getByRole("button", { name: /Enter command centre/i })).toBeDisabled();
});

test("sign out revokes the session server-side so the old token gets 401 (audit M5)", async ({ page, request }) => {
  await login(page);
  const oldToken = await page.evaluate(() => sessionStorage.getItem("odin_token"));
  expect(oldToken).toBeTruthy();
  const before = await request.get(`${API_BASE}/api/terminal/snapshot`, { headers: { authorization: `Bearer ${oldToken}` } });
  expect(before.status()).toBe(200);

  await page.getByRole("button", { name: /Sign out/i }).click();
  await expect(page).toHaveURL(/\/login/);
  expect(await page.evaluate(() => sessionStorage.getItem("odin_token"))).toBeNull();

  const after = await request.get(`${API_BASE}/api/terminal/snapshot`, { headers: { authorization: `Bearer ${oldToken}` } });
  expect(after.status()).toBe(401);
});
