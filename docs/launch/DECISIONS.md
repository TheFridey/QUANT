# QUANT Launch — Gate A Decisions (D015+)

Decisions for Gate A correctness work on branch `cursor/quant-gate-a-correctness-95f1`.  
Baseline SHA: `be0923305193cfbf5ccfbf6336663e0b002ca5bf`.

Numbering continues the programme log from MVP D014; these entries freeze Gate A behaviour for findings D01–D07 and D21.

---

## D015 — Postgres is reservation authority; open + HELD counted once

**Decision:** Production admission uses `PostgresReservationAuthority` with account `FOR UPDATE`. `ReservationBudget.exposureUsedUsd` / `slotsUsed` / `riskUsedUsd` are open-book usage; `reconstructBudget` adds only **HELD** remainders. CONSUMED fills are already on the book — never double-count. In-memory `ReservationLedger` is adversarial test reference only.
**Addresses:** D04  
**Date:** 2026-10-29

## D016 — ExecutionContext is pinned; live config cannot redirect writes

**Decision:** Cycle and manual intents persist `PinnedExecutionContext`. Worker stages load the pin; `assertExecutionAccount` / `executionContextMatches` refuse cross-account or environment drift. No silent fallback to `primary` when the env-specific paper account is missing.
**Addresses:** D01  
**Date:** 2026-10-29

## D017 — Null tradingEnvironment is never compatible in trading paths

**Decision:** Exact environment match only. `allowNullEnvironment` defaults false for fill eligibility and presentation. Legacy null-env rows are quarantined, not treated as MARKET_DATA_PAPER-compatible.
**Addresses:** D02, D03  
**Date:** 2026-10-29

## D018 — EligibleObservation rejects old-event/new-receipt and future data

**Decision:** Fill selection requires receipt in `[eligibleAt, now]` (and before expiry). When `eventTime` is present it must also fall in bounds — a new receipt for an old provider event is ineligible. Future receipts are refused. Optional `preferIngestJobId` still runs through the same usability checks.
**Addresses:** D03  
**Date:** 2026-10-29

## D019 — ACTIVE PROTECTION_RECOVERY suspends entries

**Decision:** `PROTECTION_RECOVERY` is in `ENTRY_BLOCKING_SAFETY_CODES`. ACTIVE recovery suspends expansion; exits and protection retry continue. Alert ACK never clears safety codes.
**Addresses:** D05  
**Date:** 2026-10-29

## D020 — Position keys require known accountId; no first-colon split

**Decision:** Use `buildPositionKey` / `instrumentIdFromPositionKey` with the known `account.id`. Keys such as `primary:fixture:etf:SPY` decode only when `accountId === "primary:fixture"`. Exact key match for protection coverage; no suffix heuristics.
**Addresses:** D06, D21  
**Date:** 2026-10-29

## D021 — Desired-only native stops are never protected=true

**Decision:** Venue/broker-native legs with `ackState` DESIRED_ONLY / SUBMITTED / REJECTED / UNKNOWN do not satisfy coverage. Synthetic engine legs remain labelled engine-dependent. Lifecycle mismatch excludes the leg.
**Addresses:** D06  
**Date:** 2026-10-29

## D022 — ProtectionIntent kinds are typed and lifecycle-fenced

**Decision:** Intents use `EXIT_RETRY` | `AMEND_RETRY` | `CANCEL_RETRY` | `RECONCILE_UNKNOWN` with account + lifecycle fence. Amendment failure must not sell; old-lot retry must not close a reopened holding.
**Addresses:** D07  
**Date:** 2026-10-29

## D023 — Terminal snapshot marks are environment-scoped (D21)

**Decision:** `TerminalService.snapshot` filters latest cycle observations and mark fallbacks by `ctx.tradingEnvironment` (exact match). Position marks use same-environment observations only. `presentPair` / mark freshness prefer stored `dataOrigin` via `freshnessFromProvenance` so FIXTURE / REPLAY / DELAYED quotes cannot appear as LIVE for paper accounts.
**Addresses:** D21  
**Date:** 2026-10-29

## D024 — Single-operator auth/session scope (D25)

**Decision:** Documented deployment scope is **single trusted operator** (local/VPN paper). Logout revokes JWT server-side (`jti` + memory, Redis when available). Socket.IO CORS/origin checks use `WEB_ORIGIN` plus local paper defaults — never reflect-any. Connected sockets re-verify JWT expiry/revocation on an interval. Login rate limiting remains per-process memory (proxy-aware shared limiter deferred). Ordinary `POST /api/auth/login` paper credentials are unchanged.
**Addresses:** D25  
**Date:** 2026-10-29

## D025 — Loopback infra bind + password rotation honesty (D26)

**Decision:** `docker-compose.yml` publishes Postgres/Redis on `127.0.0.1` only. Production guidance: private network, no public DB/cache ports. `ADMIN_PASSWORD` env changes do not rewrite an existing seeded user hash — rotation is explicitly out-of-band until an admin password API exists.
**Addresses:** D26  
**Date:** 2026-10-29

## D026 — CI builds without Playwright; soak is helper-only (D27)

**Decision:** CI runs `pnpm build` (packages + api/worker/web) after existing tests; optional `build-packages` job compiles without DB services. Playwright browsers are not installed or required. `scripts/soak-capacity.mjs` is labelled helper≠full engine.
**Addresses:** D27  
**Date:** 2026-10-29

## D027 — Terminal analytics windows are labelled samples (D14)

**Decision:** Snapshot `portfolio.analyticsWindows` names each metric’s dataset (latest N closed trades, all-time fees, earliest N equity snapshots, latest N funnel events). Does not yet unify to one calendar cohort — labels prevent silent mix-ups; `equityHistory(range)` remains the explicit calendar API.
**Addresses:** D14  
**Date:** 2026-10-29
