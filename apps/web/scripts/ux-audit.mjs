#!/usr/bin/env node
// Audit E evidence: screenshots of every terminal section at 1440x900 and 390x844, plus axe
// serious/critical violations, against a running stack (web :4317, API :4318).
//
// Usage: node scripts/ux-audit.mjs <outDir> [--channel msedge]
// Writes <outDir>/<viewport>/<section>.png and <outDir>/axe.json. Exit code 0 always; read axe.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { AxeBuilder } from "@axe-core/playwright";
import { chromium } from "@playwright/test";

const SECTIONS = [
  "overview", "agents", "radar", "markets", "trading", "portfolio", "positions", "history", "strategy",
  "backtesting", "risk", "capacity", "research", "operations", "forge", "genome", "integrity", "confidence",
  "memory", "models", "autonomy", "logs", "settings",
];
const VIEWPORTS = [
  { name: "desktop-1440x900", width: 1440, height: 900 },
  { name: "mobile-390x844", width: 390, height: 844 },
];
const BASE = process.env.ODIN_WEB_URL ?? "http://127.0.0.1:4317";
const PASSWORD = process.env.ADMIN_PASSWORD ?? "odin-paper-dev";

const outDir = process.argv[2];
if (!outDir) throw new Error("usage: node scripts/ux-audit.mjs <outDir> [--channel msedge]");
const channelIndex = process.argv.indexOf("--channel");
const channel = channelIndex > 0 ? process.argv[channelIndex + 1] : undefined;

const sections = process.env.ODIN_UX_SECTIONS ? process.env.ODIN_UX_SECTIONS.split(",") : SECTIONS;
const href = (id) => (id === "overview" ? "/terminal" : `/terminal/${id}`);

const browser = await chromium.launch(channel ? { channel } : {});
const report = {};
try {
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
    const page = await context.newPage();
    await page.goto(`${BASE}/login`);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: /Enter command centre/i }).click();
    await page.waitForURL(/\/terminal/, { timeout: 60_000 });
    mkdirSync(join(outDir, viewport.name), { recursive: true });
    for (const section of sections) {
      await page.goto(`${BASE}${href(section)}`);
      await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
      await page.waitForTimeout(1_500);
      await page.screenshot({ path: join(outDir, viewport.name, `${section}.png`), fullPage: false });
      const axe = await new AxeBuilder({ page }).analyze();
      const serious = axe.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
      report[`${viewport.name}/${section}`] = serious.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        nodes: violation.nodes.length,
        help: violation.help,
        target: violation.nodes.slice(0, 3).map((node) => node.target.join(" ")),
      }));
    }
    await context.close();
  }
} finally {
  await browser.close();
}
writeFileSync(join(outDir, "axe.json"), `${JSON.stringify(report, null, 2)}\n`);
const total = Object.values(report).reduce((sum, rows) => sum + rows.length, 0);
process.stdout.write(`screens: ${Object.keys(report).length}, serious/critical rule hits: ${total}\n`);
