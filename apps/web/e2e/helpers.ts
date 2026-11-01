import { expect, type Page } from "@playwright/test";

export const E2E_PASSWORD = "odin-paper-dev";
export const API_BASE = "http://127.0.0.1:4318";

export async function login(page: Page, password = E2E_PASSWORD): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: /Enter command centre/i }).click();
  await expect(page.getByText("Portfolio equity")).toBeVisible({ timeout: 30_000 });
}

export async function apiFromPage<T>(
  page: Page,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  return page.evaluate(
    async ({ apiBase, path: p, init: requestInit }) => {
      const token = sessionStorage.getItem("odin_token");
      const response = await fetch(`${apiBase}/api${p}`, {
        method: requestInit?.method ?? "GET",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: requestInit?.body === undefined ? undefined : JSON.stringify(requestInit.body),
      });
      const text = await response.text();
      const data = text ? JSON.parse(text) : null;
      if (!response.ok) {
        throw new Error(typeof data?.message === "string" ? data.message : `HTTP ${response.status}`);
      }
      return data as T;
    },
    { apiBase: API_BASE, path, init },
  );
}

export type Snapshot = {
  engine: {
    status: string;
    allowedActions: string[];
    config: Record<string, string | number | boolean | null>;
    updatedAt?: string;
  };
  market: {
    dataState: string | null;
    pairs: Array<{ pairAddress: string; baseSymbol: string; freshness: string; priceUsd: string | null; liquidityUsd: string | null }>;
  };
  portfolio: {
    cashUsd: string;
    equityUsd: string | null;
    positions: Array<{
      pairAddress: string;
      baseSymbol: string;
      baseQty: string;
      protectionStatus?: string | null;
      protected?: boolean;
    }>;
  };
  orders: Array<{ id: string; side: string; status: string; baseSymbol: string; rejectReason: string | null; fills: unknown[] }>;
  opsControls?: { pauseNewEntries?: boolean; unresolvedProtection?: number; entriesSuspended?: boolean };
  strategyInstances?: Array<{ id: string; name: string; budgetUsd: string; status: string }>;
  whyNoTrades?: { families?: string[]; note?: string; decisiveBlocks?: Array<{ reasonCodes?: string[] }> };
  whyBlocked?: Array<{ reasonCodes: string[]; decision: string }>;
  alerts?: Array<{ id: string; code: string; acked: boolean; message: string }>;
  execution?: { unresolvedProtection?: number; tradingEnvironment?: string };
};

export async function snapshot(page: Page): Promise<Snapshot> {
  return apiFromPage<Snapshot>(page, "/terminal/snapshot");
}

export async function ensureEngineStatus(page: Page, wanted: "RUNNING" | "PAUSED" | "STOPPED"): Promise<void> {
  const current = await snapshot(page);
  const status = current.engine.status;
  if (status === wanted) return;
  if (wanted === "RUNNING") {
    if (status === "PAUSED") await apiFromPage(page, "/engine/resume", { method: "POST", body: {} });
    else if (status === "STOPPED") await apiFromPage(page, "/engine/start", { method: "POST", body: {} });
    else throw new Error(`Cannot reach RUNNING from ${status}`);
  } else if (wanted === "PAUSED") {
    if (status === "RUNNING") await apiFromPage(page, "/engine/pause", { method: "POST", body: {} });
    else if (status === "STOPPED") {
      await apiFromPage(page, "/engine/start", { method: "POST", body: {} });
      await apiFromPage(page, "/engine/pause", { method: "POST", body: {} });
    } else throw new Error(`Cannot reach PAUSED from ${status}`);
  } else if (wanted === "STOPPED") {
    // Prefer emergency halt without flatten for isolation; stop action may not exist when RUNNING.
    if (status === "RUNNING" || status === "PAUSED") {
      await apiFromPage(page, "/engine/emergency-stop", { method: "POST", body: { flatten: false } });
    }
  }
  await expect
    .poll(async () => (await snapshot(page)).engine.status, { timeout: 15_000 })
    .toBe(wanted === "STOPPED" ? "EMERGENCY_STOP" : wanted);
}

/** Risk knobs that allow small local paper buys against LIVE Solana marks. */
export async function tunePaperRiskForManualBuys(page: Page): Promise<void> {
  await ensureEngineStatus(page, "PAUSED");
  await apiFromPage(page, "/engine/config", {
    method: "PATCH",
    body: {
      minOrderNotionalUsd: "5",
      maxRiskPerTradePct: "2",
      maxPositionPctEquity: "10",
      // The deterministic feed oscillates by several percent, so with the default 3% stop, 2% breakeven
      // and -1.5% momentum exit the running engine can close the test's manual position before the test
      // observes it (seen on main after B made fills one cycle later). Widen the engine's own exits for
      // the duration of this throwaway e2e account so the manual open/close flow is what is tested.
      stopLossPct: "50",
      takeProfitPct: "200",
      exitM5ChangePct: "-50",
      breakevenActivatePct: null,
      // Same race on the entry side: with security PASS on the deterministic feed, the engine's own
      // momentum/mean-revert instances can open the test pair between cleanup and the "before"
      // snapshot, and the manual BUY is then (correctly) refused as already held. An unreachable
      // 100% M5 threshold keeps automatic entries out; operator tickets do not use it. The anomaly
      // ceiling must stay >= the entry threshold, so it moves to the same (unreachable) bound.
      entryM5ChangePct: "100",
      maxEntryM5ChangePct: "100",
      // Entries are sized so a stop-out (here the widened 50% stop) plus worst costs fits the daily loss
      // headroom left after open positions' stop-out risk (ASCEND-00 F2). With a 50% stop, one leftover
      // automatic position commits roughly the whole default 3% allowance and the $50 manual buy sizes to
      // zero, so this throwaway e2e account gets a matching allowance. Production limits are unchanged.
      maxDailyLossPct: "50",
    },
  });
}

export function pickLivePair(snap: Snapshot): Snapshot["market"]["pairs"][number] {
  const ranked = [...snap.market.pairs]
    .filter((pair) => pair.freshness === "LIVE" && pair.priceUsd && Number(pair.liquidityUsd ?? 0) > 1_000)
    .sort((a, b) => Number(b.liquidityUsd ?? 0) - Number(a.liquidityUsd ?? 0));
  const chosen = ranked[0] ?? snap.market.pairs.find((pair) => pair.freshness === "LIVE");
  if (!chosen) throw new Error("No LIVE market pair available for paper ticket");
  return chosen;
}

export async function waitForOrderTerminal(
  page: Page,
  cycleId: string,
  clientIntentId: string,
): Promise<{ pending: boolean; status: string; orders: Array<{ status: string; rejectReason: string | null; fills: unknown[] }> }> {
  let last: { pending: boolean; status: string; orders: Array<{ status: string; rejectReason: string | null; fills: unknown[] }> } | null =
    null;
  await expect
    .poll(
      async () => {
        last = await apiFromPage(page, `/orders/receipt?cycleId=${encodeURIComponent(cycleId)}&clientIntentId=${encodeURIComponent(clientIntentId)}`);
        return last.pending ? "pending" : last.status;
      },
      { timeout: 45_000 },
    )
    .not.toBe("pending");
  if (!last) throw new Error("No receipt");
  return last;
}
