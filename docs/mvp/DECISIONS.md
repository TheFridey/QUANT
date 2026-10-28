# QUANT MVP — Decisions Log

## D001 — Preserve stack; no greenfield rewrite

**Decision:** Keep pnpm / TypeScript / Nest / Next / Prisma / BullMQ. Fix the trading engine in place.
**Why:** Existing ledger, agents, and lab are valuable; broad rewrite risks regressions.
**Date:** 2026-10-28

## D002 — Activity headroom without loosening hard risk

**Decision:** Raise default starting equity to `$10,000` paper and keep institutional % caps (`maxPositionPctEquity=5`, `maxRiskPerTradePct=0.5`, etc.). Keep `minOrderNotionalUsd` at a level with headroom vs max position. Add schema refine: at default start, `maxPositionPctEquity% * startingBalance` must exceed `minOrderNotionalUsd` after fee/slippage haircut. Never round notional **up** to meet the minimum when that would breach risk caps — reject `BELOW_MIN_NOTIONAL` / `MIN_ORDER_EXCEEDS_RISK_CAP`.
**Why:** `$100` × 5% = `$5` = min order deadlocks after the first fee; “fix by making unable to trade” is forbidden; loosening % risk to chase activity is also forbidden.
**Date:** 2026-10-28

## D003 — Held positions monitored outside discovery

**Decision:** Cycle planning merges ingest/discovery pairs with open holdings (synthetic cycle pairs from latest mark). Exit/flatten/stop evaluation runs for holdings even when the token left the universe. Discovery ranking stays separate.
**Why:** Defect #4 — holdings only marked, never exit-evaluated.
**Date:** 2026-10-28

## D004 — Flatten flag survives incomplete exits

**Decision:** Clear `flattenRequested` only when no open `baseQty > 0` remains after the executor pass; otherwise keep the flag and record `FLATTEN_INCOMPLETE`.
**Why:** Defect #4 cleared flatten while holdings remained / marks missing.
**Date:** 2026-10-28

## D005 — Observation history is a latest window

**Decision:** Load history with `orderBy receivedAt desc, take N`, then reverse to ascending for indicators.
**Why:** Defect #5 kept the earliest 40 forever.
**Date:** 2026-10-28

## D006 — Paper latency is real PENDING, not metadata theatre

**Decision:** Persist `eligibleAt`/`expiresAt` from the planner. If `now < eligibleAt`, create `PENDING` order (no fill). Later cycles fill when eligible and quote still valid; expire honestly when past `expiresAt`.
**Why:** Defect #6 — planner computed future eligibility; store filled immediately with `eligibleAt=now`.
**Date:** 2026-10-28

## D007 — In-cycle exposure releases on sells

**Decision:** When a sell is proposed and applied to the sim book in-cycle, subtract that notional from running aggregate exposure so capacity can reopen for subsequent entries in the same plan.
**Why:** Defect #7.
**Date:** 2026-10-28

## D008 — Indices ≠ executable; FX = currency pairs

**Decision:** Equity index levels remain `RESEARCH_ONLY`/`NO_EXECUTION`. Add ETF/futures **proxies** with `PAPER_SPOT` (or paper proxy capability) for executable index exposure. Forex instruments are currency pairs (`FX_SPOT`), not equity indices.
**Why:** Mission: Forex = currency pairs; do not pretend index levels are tradable.
**Date:** 2026-10-28

## D009 — External adapters stay BLOCKED_EXTERNAL without credentials

**Decision:** Ship adapter interfaces + paper/fixture paths; never claim live/sandbox success from fixtures; never sign up or fund accounts from the agent.
**Date:** 2026-10-28

## D010 — Daily loss denominator

**Decision:** Prefer session-start equity for daily loss % when available; fall back to starting balance only when session equity is unavailable. Document that mixing lifetime unrealised with “today” realised is a known defect to replace with mark-to-market change since session start (Gate B20).
**Date:** 2026-10-28
