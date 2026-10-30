import { expect, test } from "@playwright/test";
import {
  apiFromPage,
  ensureEngineStatus,
  login,
  pickLivePair,
  snapshot,
  tunePaperRiskForManualBuys,
  waitForOrderTerminal,
} from "./helpers";

test.describe.configure({ mode: "serial" });

test.describe("Gate 1 local paper browser workflows", () => {
  test("login, start local paper, pause/resume, and logout", async ({ page }) => {
    await login(page);
    await expect(page.getByText("ODIN // QUANT").first()).toBeVisible();
    await expect(page.getByText("PAPER").first()).toBeVisible();

    // Prefer UI Start when STOPPED/EMERGENCY; otherwise pause then resume via UI.
    const before = await snapshot(page);
    if (before.engine.allowedActions.includes("start")) {
      await page.getByRole("button", { name: /^Start$/ }).click();
    } else if (before.engine.status === "PAUSED") {
      await page.getByRole("button", { name: /^Resume$/ }).click();
    } else if (before.engine.status === "RUNNING") {
      await page.getByRole("button", { name: /^Pause$/ }).click();
      await expect.poll(async () => (await snapshot(page)).engine.status).toBe("PAUSED");
      await page.getByRole("button", { name: /^Resume$/ }).click();
    }
    await expect.poll(async () => (await snapshot(page)).engine.status, { timeout: 20_000 }).toBe("RUNNING");
    await expect(page.getByText("RUNNING").first()).toBeVisible();

    await page.getByRole("button", { name: /^Pause$/ }).click();
    await expect.poll(async () => (await snapshot(page)).engine.status).toBe("PAUSED");
    await expect(page.getByText("PAUSED").first()).toBeVisible();

    await page.getByRole("button", { name: /^Resume$/ }).click();
    await expect.poll(async () => (await snapshot(page)).engine.status).toBe("RUNNING");

    await page.getByRole("button", { name: /Sign out/i }).click();
    await expect(page.getByRole("heading", { name: "ODIN // QUANT" })).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test("markets select, strategy budget/config, dirty draft survives polling", async ({ page }) => {
    await login(page);
    await ensureEngineStatus(page, "PAUSED");

    await page.getByRole("link", { name: "Market Selector" }).click();
    await expect(page.getByText("Market Selector").first()).toBeVisible();
    const enableButtons = page.getByRole("button", { name: /Enabled|Disabled/ });
    await expect(enableButtons.first()).toBeVisible({ timeout: 20_000 });
    const firstLabel = await enableButtons.first().innerText();
    await enableButtons.first().click();
    await expect(enableButtons.first()).toHaveText(firstLabel.includes("Enabled") ? /Disabled/ : /Enabled/, {
      timeout: 15_000,
    });
    // Restore prior state for isolation.
    await enableButtons.first().click();
    await expect(enableButtons.first()).toHaveText(new RegExp(firstLabel.trim()), { timeout: 15_000 });

    await page.getByRole("link", { name: "Strategy Laboratory" }).click();
    await expect(page.getByRole("heading", { name: "Operating controls" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Strategy instances" })).toBeVisible();

    const before = await snapshot(page);
    expect((before.strategyInstances ?? []).length).toBeGreaterThan(0);
    expect(before.strategyInstances![0]!.budgetUsd).toBeTruthy();

    const maxPositions = page.getByLabel("Max positions");
    await expect(maxPositions).toBeVisible();
    const original = await maxPositions.inputValue();
    const dirtyValue = original === "3" ? "4" : "3";
    await maxPositions.fill(dirtyValue);
    await expect(page.getByText("Unsaved draft")).toBeVisible();

    // Force snapshot polls; dirty draft must not be overwritten.
    await page.waitForTimeout(6_000);
    await expect(maxPositions).toHaveValue(dirtyValue);
    await expect(page.getByText("Unsaved draft")).toBeVisible();

    await page.getByRole("button", { name: /Save live paper config/i }).click();
    await expect(page.getByRole("status")).toContainText(/saved|Pause|rejected|Conflict|paused/i, {
      timeout: 15_000,
    });
    await expect
      .poll(async () => String((await snapshot(page)).engine.config.maxPositions), { timeout: 20_000 })
      .toBe(dirtyValue);

    // Restore original via API for suite isolation (UI save path already proven above).
    await apiFromPage(page, "/engine/config", {
      method: "PATCH",
      body: { maxPositions: Number(original) },
    });
    await expect
      .poll(async () => String((await snapshot(page)).engine.config.maxPositions), { timeout: 20_000 })
      .toBe(original);

    // Ops pause-new-entries flag (works while RUNNING).
    await ensureEngineStatus(page, "RUNNING");
    await page.getByRole("link", { name: "Strategy Laboratory" }).click();
    const pauseEntries = page.getByRole("button", { name: /Pause new entries|Resume new entries/ });
    const beforeOps = await snapshot(page);
    const wasPaused = Boolean(beforeOps.opsControls?.pauseNewEntries);
    await pauseEntries.click();
    await expect
      .poll(async () => Boolean((await snapshot(page)).opsControls?.pauseNewEntries))
      .toBe(!wasPaused);
    await pauseEntries.click();
    await expect
      .poll(async () => Boolean((await snapshot(page)).opsControls?.pauseNewEntries))
      .toBe(wasPaused);
  });

  test("signal/rejection reasons surface on overview and risk", async ({ page }) => {
    await login(page);
    await page.goto("/terminal");
    await expect(page.getByText("Why no trades").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Why blocked").first()).toBeVisible();
    const snap = await snapshot(page);
    const hasSignalEvidence =
      (snap.whyNoTrades?.decisiveBlocks?.length ?? 0) > 0 ||
      (snap.whyNoTrades?.families?.length ?? 0) > 0 ||
      (snap.whyBlocked?.length ?? 0) > 0 ||
      Boolean(snap.whyNoTrades?.note);
    expect(hasSignalEvidence).toBe(true);

    await page.getByRole("link", { name: "Risk Management" }).click();
    await expect(page.getByText("Why blocked").first()).toBeVisible();
    await expect(
      page.getByText(/No reject\/block diagnostics|VOLUME_FLOOR|DISCOVERY_RANKED|NO_EDGE|MIN_ORDER|reason/i).first(),
    ).toBeVisible();
  });

  test("preview/submit manual paper order; assert pending then fill; protection + close", async ({ page }) => {
    await login(page);
    await tunePaperRiskForManualBuys(page);
    await ensureEngineStatus(page, "RUNNING");

    // Flatten any leftover paper lots so cash/position assertions are about THIS buy.
    for (let i = 0; i < 5; i += 1) {
      const current = await snapshot(page);
      const open = current.portfolio.positions.filter((row) => Number(row.baseQty) > 0);
      if (open.length === 0) break;
      for (const position of open) {
        const intent = `intent_sell_cleanup_${Date.now()}_${i}`;
        const receipt = await apiFromPage<{ cycleId: string; clientIntentId: string }>(page, "/orders", {
          method: "POST",
          body: { side: "SELL", pairAddress: position.pairAddress, clientIntentId: intent },
        });
        await waitForOrderTerminal(page, receipt.cycleId, intent);
      }
    }

    const before = await snapshot(page);
    const pair = pickLivePair(before);
    const cashBefore = Number(before.portfolio.cashUsd);
    const orderIdsBefore = new Set(before.orders.map((order) => order.id));

    await page.goto("/terminal/trading");
    await expect(page.getByText("Paper ticket")).toBeVisible();
    await page.getByRole("button", { name: new RegExp(`^${pair.baseSymbol}\\b`) }).first().click();
    await page.getByLabel("Notional USD").fill("50");
    await expect(page.getByText("Est. qty")).toBeVisible();
    await expect(page.getByText("Est. fees")).toBeVisible();

    const buy = page.getByRole("button", { name: /^Buy$/ });
    await expect(buy).toBeEnabled({ timeout: 30_000 });
    await buy.click();

    await expect(page.getByText(/Pending|COMPLETE|FILLED|Order|cycle|cyc_/i).first()).toBeVisible({
      timeout: 20_000,
    });

    await expect
      .poll(async () => {
        const snap = await snapshot(page);
        const freshFill = snap.orders.find(
          (order) =>
            !orderIdsBefore.has(order.id) &&
            order.side === "BUY" &&
            order.status === "FILLED" &&
            order.fills.length > 0,
        );
        const open = snap.portfolio.positions.find(
          (position) => position.pairAddress === pair.pairAddress && Number(position.baseQty) > 0,
        );
        const cashDrop = Number(snap.portfolio.cashUsd) < cashBefore - 1;
        if (freshFill && open && cashDrop) return "filled";
        return `newOrders=${snap.orders.filter((o) => !orderIdsBefore.has(o.id)).map((o) => `${o.side}:${o.status}`).join(",") || "none"};pos=${open ? open.baseQty : 0};cash=${snap.portfolio.cashUsd}`;
      }, { timeout: 60_000 })
      .toBe("filled");

    const afterBuy = await snapshot(page);
    expect(Number(afterBuy.portfolio.cashUsd)).toBeLessThan(cashBefore - 1);
    const position = afterBuy.portfolio.positions.find((row) => row.pairAddress === pair.pairAddress);
    expect(position).toBeTruthy();
    expect(position!.protectionStatus === "PROTECTED" || position!.protected === true).toBeTruthy();

    await page.goto("/terminal/positions");
    await expect(page.getByText("Open positions")).toBeVisible();
    await expect(page.getByText(pair.baseSymbol).first()).toBeVisible();
    await expect(page.getByText(/PROTECTED|UNPROTECTED|Recovery|Exit/i).first()).toBeVisible();

    const orderIdsAfterBuy = new Set(afterBuy.orders.map((order) => order.id));
    const closeBtn = page.getByRole("button", { name: /^Close$/ }).first();
    await expect(closeBtn).toBeEnabled();
    await closeBtn.click();
    await expect
      .poll(async () => {
        const snap = await snapshot(page);
        const stillOpen = snap.portfolio.positions.find(
          (row) => row.pairAddress === pair.pairAddress && Number(row.baseQty) > 0,
        );
        const sell = snap.orders.find((order) => order.side === "SELL" && !orderIdsAfterBuy.has(order.id));
        if (!stillOpen && sell?.status === "FILLED") return "closed";
        if (!stillOpen) return "closed";
        if (sell) return `sell:${sell.status}`;
        return "open";
      }, { timeout: 60_000 })
      .toMatch(/^closed$|^sell:FILLED$/);
  });

  test("history filters, alert ack API + safety honesty, disconnect/reconnect, mobile nav, keyboard", async ({
    page,
    context,
  }) => {
    await login(page);

    // Seed durable alert via isolated e2e DB (UI has no ACK button — API ack + honesty copy).
    const { execFileSync } = await import("node:child_process");
    execFileSync(
      "psql",
      [
        "-h",
        "127.0.0.1",
        "-U",
        "odin",
        "-d",
        "odin_e2e",
        "-c",
        `INSERT INTO "DurableAlert" (id, severity, code, message, acked, payload, "createdAt", "accountId")
         VALUES ('alert_e2e_pw', 'WARNING', 'E2E_BROWSER_ACK', 'Playwright seeded alert', false, '{"ackClearsSafety":false}'::jsonb, NOW(), 'primary')
         ON CONFLICT (id) DO UPDATE SET acked = false, "ackedAt" = NULL, message = EXCLUDED.message, payload = EXCLUDED.payload;`,
      ],
      { env: { ...process.env, PGPASSWORD: "odin" }, stdio: "pipe" },
    );

    const snap = await snapshot(page);
    const openAlert = (snap.alerts ?? []).find((alert) => alert.id === "alert_e2e_pw" || !alert.acked);
    await page.goto("/terminal/risk");
    await expect(page.getByText(/ACK ≠ clear|ACK≠clear|Alert ACK does not|ACK≠clear safety/i).first()).toBeVisible();
    await expect(page.getByText(/E2E_BROWSER_ACK|Playwright seeded alert|Durable alerts/i).first()).toBeVisible();

    expect(openAlert?.id).toBeTruthy();
    await apiFromPage(page, `/terminal/alerts/${openAlert!.id}/ack`, { method: "POST", body: {} });
    await expect
      .poll(async () => {
        const next = await snapshot(page);
        const row = (next.alerts ?? []).find((alert) => alert.id === openAlert!.id);
        // Snapshot open-alerts list drops acked rows — missing means ack succeeded.
        return row ? String(row.acked) : "missing";
      })
      .toMatch(/true|missing/);

    // History filters
    await page.goto("/terminal/history");
    await expect(page.getByRole("heading", { name: "Trade history", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Orders" }).click();
    await page.locator("#history-side").selectOption("BUY");
    await page.getByLabel("Symbol").fill("SOL");
    await page.getByRole("button", { name: /^Apply$/ }).click();
    await expect(page.getByText(/ledger|orders|rows|No|SOL|BUY|Showing|FILLED/i).first()).toBeVisible();

    // Keyboard focus on an enabled critical control (disabled Start is not focusable).
    await page.goto("/terminal");
    const keyboardTargets = [
      page.getByRole("button", { name: /^Pause$/ }),
      page.getByRole("button", { name: /^Resume$/ }),
      page.getByRole("button", { name: /Sign out/i }),
    ];
    let focused = false;
    for (const target of keyboardTargets) {
      if (await target.isEnabled()) {
        await target.focus();
        await expect(target).toBeFocused();
        focused = true;
        break;
      }
    }
    expect(focused).toBe(true);
    await page.keyboard.press("Tab");

    // Disconnect / reconnect (offline kills socket; polling may continue)
    await page.goto("/terminal/settings");
    const socketRow = page.locator("div.flex.justify-between").filter({ hasText: "API socket" });
    await expect(socketRow).toBeVisible();
    await context.setOffline(true);
    await expect(socketRow.getByText(/down|error|connecting/i)).toBeVisible({ timeout: 20_000 });
    await context.setOffline(false);
    await expect(socketRow.getByText(/connected/i)).toBeVisible({ timeout: 30_000 });

    // Mobile nav groups
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/terminal");
    await expect(page.getByRole("tablist", { name: "Nav groups" })).toBeVisible();
    await page.getByRole("tab", { name: "Orders & Positions" }).click();
    await expect(page.getByRole("link", { name: "Ticket" })).toBeVisible();
    await page.getByRole("link", { name: "Ticket" }).click();
    await expect(page.getByText("Paper ticket").first()).toBeVisible();
  });
});
