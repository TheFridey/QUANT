import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/** Audit UI: zero serious or critical axe violations on every terminal section, desktop and mobile. */
const SECTIONS = [
  "overview", "agents", "radar", "markets", "trading", "portfolio", "positions", "history", "strategy",
  "backtesting", "risk", "capacity", "research", "operations", "forge", "genome", "integrity", "confidence",
  "memory", "models", "autonomy", "logs", "settings",
];

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`no serious or critical axe violations (${viewport.name})`, async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await login(page);
    const failures: string[] = [];
    for (const section of SECTIONS) {
      await page.goto(section === "overview" ? "/terminal" : `/terminal/${section}`);
      await page.waitForLoadState("networkidle").catch(() => undefined);
      const results = await new AxeBuilder({ page }).analyze();
      for (const violation of results.violations) {
        if (violation.impact === "serious" || violation.impact === "critical") {
          failures.push(`${section}: ${violation.id} (${violation.nodes.length}) ${violation.nodes[0]?.target.join(" ")}`);
        }
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });
}
