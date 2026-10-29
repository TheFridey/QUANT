# QUANT deep audit after Release 1

Date: 29 October 2026. Baseline: main at `be0923305193cfbf5ccfbf6336663e0b002ca5bf` (PR #3).

## Decision

QUANT is an increasingly useful research and paper-trading foundation. Release 1 makes real improvements, but dependable unattended multi-market trading is not established. Remaining gaps include account/context consistency, price eligibility, aggregate risk, protection recovery, actual provider execution and strategy-instance ownership. The interface also contains controls that do not govern the worker as their labels imply.

Fixing these issues should support MORE healthy concurrent trades: correct capacity accounting, effective market selection, multiple executable strategies, reliable price refresh and clear diagnostics. The answer is not more universal signal confirmations or a minimum daily trade quota.

Recommended launch sequence: correctness patch → market/strategy integration → operational UI → full-engine capacity and paper beta → separately authorised live-readiness work. Keep real money disabled during this programme.

## What was reviewed and what was not

- Retrieved 272 production source, selected regression-test, configuration and documentation files from a 360-file tree. Inspected trading, data, risk, recovery, research, API, UI and deployment call paths. This is targeted source review across the product, not a guarantee every line or vulnerability was examined.
- Verified [PR #3 merge](https://github.com/TheFridey/QUANT/commit/be0923305193cfbf5ccfbf6336663e0b002ca5bf) and [post-merge CI](https://github.com/TheFridey/QUANT/actions/runs/40884676383). Logs: 92 test files passed; **301 passed, one skipped**. Migration, typecheck and lint steps succeeded. The workflow does not run production builds, Playwright or a full-engine soak.
- Ran seven focused probes on actual merged TypeScript transformed by Node, with dependency/database shims. These validate specific control-flow/selection bugs using simple values. They are not PostgreSQL/Redis integration tests, precision tests or broker tests.
- Did not start the complete application, visually inspect a running browser, run the full pnpm suite locally, authenticate to providers or place orders. UI findings distinguish source-confirmed behaviour from design recommendations requiring browser validation.
- No repository, broker account or user trading state was changed.

## Release 1 progress worth preserving

The worker now settles pending orders before replanning; it attempts mandatory Solana refresh; position protection has lifecycle IDs; pending fills receive a protection-arming call; reductions cancel/update armed protection; safety state is separate from notification ACK; row-level provenance exists; and terminal coverage no longer counts FAILED rows merely because they exist. Latest-window observation loading and retained incomplete flatten requests remain useful fixes.

These improvements should remain. The findings below describe residual defects and missing integration rather than assuming Release 1 did nothing.

## Severity and evidence

- **P0:** resolve before relying on unattended paper execution/accounting. This prioritises correctness; no assertion of current real-money loss is made.
- **P1:** required for the requested multi-market/demo MVP or a usable operational beta.
- **P2:** quality, scale and polish improvements, some essential before shared/public deployment.
- **Probe-confirmed:** focused executable source probe; **source-confirmed:** direct call-path evidence; **validation gap:** not demonstrated by current evidence; **design upgrade:** recommended feature, not a claimed defect.

Source links below are pinned to the audited SHA. The companion Cursor prompt uses IDs D01–D30 for acceptance tracking.

## Trading, safety and data findings

### D01 — P0: cycle context is recalculated rather than durably pinned

Source-confirmed. [StageRunner](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/apps/worker/src/stage-runner.ts#L99), [execution context](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/packages/shared/src/execution-context.ts).

Cycle creation does not persist an account/environment/config revision. observe, loadPlan and executor resolve context from current global engine config. The executor override stabilises its own transaction, not the complete queued cycle. An environment change between stages can redirect work or leave it unprocessable. Promotion can also change the global config without a cycle-version boundary.

Fix: persist account, environment, data/execution mode and strategy/config revision at cycle/intent creation, then reject mismatches. Define safe environment switching with in-flight work. Test switching global configuration while an old cycle waits in a queue.

### D02 — P0: isolation is incomplete in history, analytics and recovery

Source-confirmed. [Observation history](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/apps/worker/src/stage-runner.ts#L1117), [terminal snapshot](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/apps/api/src/terminal.service.ts#L108), [lab loader](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/apps/api/src/lab.service.ts#L591).

Worker history still filters by pair only. Terminal latest batch, some marks, recent orders/decisions and fill statistics remain global. Lab replay loads rows by time/pair without environment/origin filtering and relabels them REPLAY, losing the distinction between fixture and observed input. Eligible selection explicitly permits null environment rows. Protection retry also queries the latest price without environment filtering.

Fix: require typed scope at every data and reporting entry point. Quarantine unknown legacy provenance until reviewed; do not treat null as compatible with every account. Historical research may combine datasets only through an explicit selection manifest with provenance and exclusion reporting. Preserve potentially contaminated records and provide a reconciliation workflow.

### D03 — P0: post-eligibility selection is not enough to establish executable time

Probe-confirmed. [Eligible selector](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/packages/trading-engine/src/eligible-observation.ts).

The first query checks receivedAt >= eligibleAt, not that the provider event itself is eligible. Neither query has an upper bound of now. A newly received old market event is accepted; future-dated rows can also be selected. preferIngestJobId is declared but unused. Expiry is checked by settlement wall clock, but selection lacks an explicit event/receipt/expiry policy.

Fix: define timestamp semantics, enforce event and receipt bounds, preserve unknown event time explicitly and avoid fabricated accuracy. Test old-event/new-receipt, future event, future receipt, wrong environment, post-expiry and missing timestamp cases, plus a real changed-price fill.

### D04 — P0: aggregate risk calculations still mix units and discard open usage

Probe-confirmed. [Worker budget](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/apps/worker/src/stage-runner.ts#L880), [reservation reconstruction](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/packages/risk-engine/src/pg-reservations.ts).

PendingExposure adds base quantity directly as dollars. Two units at $100 therefore contribute $2 instead of $200 in that calculation. Open exposure uses average cost, despite a comment about marks. reconstructBudget replaces supplied open exposure/risk/slots with reservation-only totals. Completed entry reservations are released, so open positions are absent from that reconstructed risk budget. Slot semantics mix remaining capacity with used slots, which can unnecessarily suppress new orders while pending reservations exist. Fee reserves and fill-time price changes need consistent handling.

Fix: one authoritative budget model with explicit currency/quantity units, marked open exposure, actual stop risk and non-overlapping reservation remainders. Define total capacity versus used capacity once. Recompute after each economic effect under the account lock. Test simultaneous opens, existing positions, pending orders, fills, fees, cancellation and partial-release replay.

### D05 — P0: safety state is improved, but enforcement/order still has holes

Probe/source-confirmed. [Safety predicate](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/packages/shared/src/safety-state.ts), [executor](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/apps/worker/src/stage-runner.ts#L186).

ACK independence is now real for ENTRIES_SUSPENDED. However, active PROTECTION_RECOVERY alone does not block new entries under the current predicate. Pending orders settle before reconciliation/safety evaluation. New plan creation still precedes reconcileAndAlert, so a safety state discovered in that transaction does not automatically invalidate already-created orders before commit.

Fix: classify safety states by effect/scope; revalidate immediately before risk expansion, including pending settlements as policy requires. Unprotected exposure should trigger bounded remediation and prevent unjustified new risk in the affected scope. Keep exit paths available. Test safety activation during the same admission cycle, not only before loadPlan.

### D06 — P0: protection identity and coverage retain ambiguous matches

Probe-confirmed. [Coverage](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/packages/shared/src/protection-coverage.ts), [mandatory target decode](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/apps/worker/src/stage-runner.ts#L1526).

Splitting positionKey at the first colon misdecodes account IDs such as primary:fixture:etf:SPY into fixture:etf:SPY. The same pattern appears in protection evaluation/retry, where an unresolved exit can target no matching instrument. Coverage accepts a null-lifecycle leg for a current known lot. It can call an ARMED venue-native leg protected with ackState DESIRED_ONLY and no confirmed trigger, because trigger existence and quantity suffice.

Fix: structured account/instrument/lifecycle columns and exact matching; no delimiter parsing or legacy suffix fallback in execution. Native coverage requires venue confirmation; synthetic coverage requires an active engine policy. Test identical instruments across accounts/lots and desired-only/rejected native stops.

### D07 — P0: recovery intents are not safely scoped/typed enough

Source-confirmed. [Protection retry helper](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/packages/trading-engine/src/protection-lifecycle.ts), [worker retry callback](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/apps/worker/src/stage-runner.ts#L432).

Retry scans unresolved intents globally, outside the account admission transaction. The callback fetches a global latest mark, uses current global config, reads position before its fill transaction and does not acquire the account lock there. Attempt IDs use wall time. Failed amendment intents share the same UNRESOLVED queue as failed exits; the callback attempts to sell rather than dispatching by intent kind. An old unresolved intent is not explicitly fenced to the still-open lifecycle before reducing a new holding.

Fix: durable typed EXIT_RETRY/AMEND_RETRY/CANCEL_RETRY intents, immutable scope and lifecycle, transactional claims/leases, stable idempotency and broker unknown-state reconciliation. Lock before book mutation and validate remaining reduce-only quantity. Test two retry workers and a reopened instrument with an old unresolved intent.

### D08 — P1: mandatory refresh remains Solana-specific and is not scheduled first

Source-confirmed. [Observe](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/apps/worker/src/stage-runner.ts#L525), [held refresh](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/packages/market-data/src/held-refresh.ts).

The worker awaits discovery before refreshing mandatory risk. Non-Solana targets are returned as missing, not refreshed. Unknown-mint direct lookup handles only the first 20 missing targets, without a visible rotation policy. Fetch calls have no explicit abort deadline. A discovery/provider hang can delay protection monitoring.

Fix: independent priority subscriptions with bounded requests, batching/fairness and provider-specific routes. Track last refresh success for each held instrument and alert on coverage debt. Test 50 holdings beyond discovery and an indefinitely slow discovery request.

### D09 — P1: external demo execution is still incomplete

Source-confirmed. [Providers](https://github.com/TheFridey/QUANT/tree/be0923305193cfbf5ccfbf6336663e0b002ca5bf/packages/market-data/src/providers), [worker commit route](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/apps/worker/src/stage-runner.ts#L362), [verification script](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/scripts/verify-external-providers.mjs).

SANDBOX still routes to venue PAPER and local commit. Alpaca/OANDA helper methods do not form a complete submit/status/cancel/fill/position/balance execution gateway. OANDA lacks a normal entry submission path in its provider. Reconciliation mirrors local paper orders rather than retrieving authoritative broker truth. The credentialed script verifies quotes only, not a protected trade lifecycle.

Fix: complete a bounded named demo integration, wire the gateway and recovery, and require explicit external-test evidence. Missing keys block authenticating/verifying, not writing missing local methods. A key-present READY label must not imply successful connection.

### D10 — P1: practice endpoint and readiness checks are weak

Probe-confirmed. [Alpaca](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/packages/market-data/src/providers/alpaca-paper.ts), [OANDA](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/packages/market-data/src/providers/oanda-practice.ts).

Substring checks allow an arbitrary hostname containing a practice marker in its path. Configured requests carry credentials to those URLs; Alpaca data URL also needs validation. Authentication failures returned as strings do not update readiness. Quote validation does not uniformly enforce finite positive bid/ask, ask>=bid, tradable status or event age.

Fix: parsed exact HTTPS host/port allowlists, explicit injected test transports, redirect restrictions and connected/authenticated/entitled readiness states. Reject malformed/stale/nontradable quotes before they reach execution.

### D11 — P1: strategy instances are not the real execution owners

Source-confirmed. [Instance allocation](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/packages/agent-core/src/strategy-instances.ts), [worker gating](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/apps/worker/src/stage-runner.ts#L803), [library](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/packages/agent-core/src/strategy-library.ts).

Instance signals become an instrument allowlist, while global PULSE/promoted logic produces orders. No ENTER signals makes the allowlist null, permitting fallback entries. Instance exits are not dispatched. Instance budgets, health and timeframe are not implemented as complete controls. Order attribution uses a global strategy stamp. The mean-reversion module never enters; breakout is essentially a threshold adapter. Name matching selects implementations rather than an explicit versioned module binding.

Fix: executable instance intents with stable module version, budgets, position allocations/netting and exact attribution. Implement genuine strategy diversity and market-specific parameters. Zero valid intents should produce zero entries, unless a separately configured fallback instance generated them.

### D12 — P1: exit parity and product accounting are not complete

Source-confirmed/validation gap. [PULSE](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/packages/agent-core/src/pulse.ts), [backtest](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/packages/backtest/src/engine.ts), [ledger](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/packages/trading-engine/src/ledger.ts).

A promoted HOLD returns before ordinary PULSE stop/target/time checks. The backtester uses shared exit helpers, but runtime still has separate logic. The full book remains positive-quantity, USD, cash-funded spot-style accounting; metadata and conversion helpers do not establish short, margin, futures or non-USD account support. Static session rules do not establish venue calendars/UK early-close handling.

Fix: independent invariant position manager plus shared strategy/risk/exit event logic; an explicit correctly supported product subset with conversion, multiplier, fees and venue rules. Do not enable unsupported capabilities from labels alone.

### D13 — P1: promotion trusts client-supplied evidence

Source-confirmed. [Promotion API](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/apps/api/src/evolution.service.ts#L927), [promotion contract](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/packages/evolution/src/promotion.ts).

The authorised operator posts evidence booleans/sample counts/hash fields and config. The service passes them to promotion without loading and binding the claimed persisted report, dataset and artifact. This is a validation/provenance gap even though an admin is required; it should be impossible to accidentally approve an unrelated config as a validated artifact. Built-in strategy dispatch does not prove arbitrary generated source execution.

Fix: promote by persisted immutable report/artifact IDs; resolve evidence server-side; verify hashes/config/dataset/approval and compare-and-swap the active revision. Provide an explicit audited experimental-paper route if weakly evidenced strategies are allowed, instead of falsely labelling them validated. Keep hard account limits outside artifacts.

### D14 — P1: displayed performance and funnel windows are inconsistent

Source-confirmed. [Terminal analytics](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/apps/api/src/terminal.service.ts), [funnel derivation](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/packages/agent-core/src/funnel.ts).

Latest 200 closed ledger rows are combined with all-time fees and earliest 500 equity snapshots. Instance attribution passes feeUsd=0 and uses global strategyVersion as instance identity, so fee attribution and ownership are not established. Funnel counts use the latest 200 events, not an explicit day/cohort. ORDERED can be derived from a proposed plan even if actual reservation/commit rejected it. Deduplication is per cycle, not unique opportunity across polls. Pending fills are not comprehensively represented by new-order fill IDs.

Fix: explicit scope/time range/dataset/sample labels, ledger-derived lifecycle trades and actual transition events. Count signals, intents, orders, fills and closed trades separately. Report per-instance allocated fees and current stop risk. Never present fixture activity as evidence of profitability.

## UI/UX and quality-of-life findings

### D15 — P1: market selection is not an execution control

Source-confirmed. [Market API](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/apps/api/src/evolution.service.ts#L114), [selector UI](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/apps/web/src/components/terminal/sections/evolution-sections.tsx).

The toggle persists MarketSelection, but the worker does not read it to determine subscriptions/admission. Users can see Disabled while the discovery path still evaluates instruments. Only index reference quotes are populated in this selector.

Fix: separate discover/watch/allow-new-entry/monitor-existing states, scope selections, and enforce them in the worker. Disabling entry eligibility must never unsubscribe an open holding's safety feed.

### D16 — P1: operational controls conflict with config immutability

Source-confirmed. [Strategy controls](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/apps/web/src/components/terminal/sections/strategy-section.tsx), [updateConfig](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/apps/api/src/terminal.service.ts#L989).

Pause new entries calls PATCH engine/config, which rejects every change while RUNNING. After promotion, changing any config field is refused as a strategy mutation, including operational flags. Operator closing also requires RUNNING, so a paused engine cannot use the ticket to reduce risk. Resume/start clears flattenRequested even if previously incomplete.

Fix: distinct versioned strategy configuration, hard risk policy and operational commands. Pause-entry should work immediately while trading; reduce-only close/cancel/flatten should work under documented paused/emergency policy. Keep explicit status/progress rather than requiring an unsafe resume just to close.

### D17 — P1: polling can overwrite unsaved form edits

Source-confirmed. [Strategy form](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/apps/web/src/components/terminal/sections/strategy-section.tsx), [snapshot provider](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/apps/web/src/components/terminal/snapshot-context.tsx).

An effect resets all form state whenever config object identity changes. Every snapshot response creates a new object, normally every five seconds and on socket nudges. A user can lose edits mid-typing.

Fix: dirty drafts keyed by revision, explicit reset/apply diff and optimistic concurrency. Preserve drafts across refresh; warn about conflicting server changes. Add field bounds, units, inline errors and feasibility preview.

### D18 — P1: connection status does not prove fresh market state

Source-confirmed. [Snapshot refresh](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/apps/web/src/components/terminal/snapshot-context.tsx), [command bar](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/apps/web/src/components/terminal/command-bar.tsx).

Socket connected is labelled Market/WS live although it only proves terminal transport connectivity. Overlapping polling/socket refresh calls have no coalescing, abort or monotonic-version guard, so an older response can overwrite a newer one. Failed refresh retains the previous snapshot; action enablement is not independently gated by response age. connect_error isn't handled. Navigation remounts the provider and resets refresh preference.

Fix: separate transport, API, worker, provider and quote freshness; show last successful update/age persistently. Coalesce requests and reject stale responses. Revalidate all actions server-side and preview freshness client-side. Persist preferences; support visibility-aware polling and reconnect recovery.

### D19 — P1: order ticket lacks durable user intent and useful preview

Source-confirmed/design upgrade. [Ticket](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/apps/web/src/components/terminal/sections/trading-section.tsx), [submitOrder](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/apps/api/src/terminal.service.ts#L1019).

Each request makes a fresh cycle; the client supplies no idempotency key. A slow/uncertain response or reload/retry can create another intent. The API polls internally for up to 12 seconds, and UI can label still-running work as an error. Ticket shows notional but not quantity, expected stop loss, fees, available budget or selected account. A position absent from the discovery tape cannot easily be selected for manual close.

Fix: preview→submit with a stable client intent ID and async receipt/status timeline. Reuse the ID on retry; bind preview to account/config/quote revisions and revalidate at admission. Default to a fast paper flow, with confirmation reserved for consequential actions. Add reduce-only selected/bulk position controls.

### D20 — P1: critical position states are hard to act on

Source-confirmed/design upgrade. [Positions](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/apps/web/src/components/terminal/sections/positions-section.tsx).

The table has no row close/partial-close/protection action, search, sorting or saved filters. It renders unprotected text in a muted style and does not surface the new protectionStatus/recoveryNeeded fields as distinct operational states. Direction, strategy allocation, executable bid/ask, risk-to-stop and stop source/age need clearer representation. A 980px table is difficult to operate on small screens.

Fix: an urgent exception queue plus position drawer/timeline; coloured AND textual protected/exit-in-progress/failed/unknown states; direct scoped actions with progress; mobile cards and keyboard-accessible tables. Show net P&L and mark uncertainty separately.

### D21 — P1: account-specific book can be displayed against global/mislabelled marks

Source-confirmed. [Snapshot/latest marks](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/apps/api/src/terminal.service.ts#L108), [presentPair](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/apps/api/src/terminal.service.ts#L1098).

Snapshot uses the latest global batch and pair-only mark fallback. presentPair and portfolio mark presentation derive freshness from receipt age, without consuming stored origin/state in those call sites. A recent fixture/delayed quote can therefore appear LIVE in a view even when worker provenance is more accurate. The header mode is based on DATA_MODE rather than the complete execution environment, so the persistent chrome is not a reliable account identity.

Fix: one backend presentation contract for account/environment/source/freshness across all pages, with top-level environment/account/provider and timestamp. Require explicit unavailable/closed/delayed states, not a global green label.

### D22 — P2: history and analytics need real datasets and pagination

Source-confirmed/design upgrade. [History](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/apps/web/src/components/terminal/sections/history-section.tsx).

Trade history is the recent snapshot order list, capped at 40 global rows. It shows first-fill price/fee rather than weighted multi-fill aggregation and opens raw JSON. There is no durable deep link, cursor pagination, date/market/strategy filter, CSV export or lifecycle round trip view. Chart history can truncate ascending rows, and the scanner/terminal uses repeated snapshots rather than a complete market chart workflow.

Fix: paginated scoped queries; human-readable lifecycle events and fee breakdown; stable shareable internal links, CSV/JSON exports, order/fill/trade distinctions; chart overlays for entries/stops/targets and real OHLC when supported.

### D23 — P2: onboarding and provider setup are developer-oriented

Design upgrade grounded in Settings/Runbooks. A first session relies on environment edits and internal config names. Missing credentials, unsupported products, unavailable data and insufficient account capital need distinct user actions. A status flag does not explain what the owner should do next.

Add a resumable setup wizard: select paper environment/account, diagnose infra, select markets/provider capabilities, verify credentials server-side without exposing them, choose feasible risk/strategy presets, preview coverage/costs and start. Include copyable diagnostics, a read-only readiness checklist and deterministic isolated demo. Secrets remain server-side, with clear save/replace/revoke semantics if managed in-app.

### D24 — P2: navigation and mobile need a coherent information hierarchy

Design upgrade. [22-section navigation](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/apps/web/src/lib/sections.ts).

Condense primary navigation into Desk, Markets, Orders/Positions, Strategies, Research and Operations. Put specialised lab/agent modules inside these areas with deep links rather than a flat mobile strip. Add global instrument/command search, favourites, saved views, breadcrumbs and a compact persistent safety/action area. Preserve rich diagnostics under progressive disclosure instead of removing them.

## Research, security, operations and release evidence

### D25 — P1 before shared deployment: session/role and transport controls need completion

Source-confirmed/validation gap. [Authentication](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/apps/api/src/auth.service.ts), [WebSocket](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/apps/api/src/terminal.gateway.ts).

JWT verification trusts embedded roles for 12 hours without current-user/session-revocation lookup. Socket auth is connection-time only, broadcasts to all authenticated sockets and accepts any CORS origin. Logout clears browser storage but doesn't revoke the token server-side. Login limiting is per-process memory and error semantics are inconsistent. These are manageable private-local limitations, not suitable evidence for a public multi-user launch.

Fix: choose/document single-operator versus multi-user scope; enforce least-privilege roles server-side, revocation/session expiry and socket expiry/origin/account rooms. Use proxy-aware shared rate limits. A future multi-user version needs ownership checks, not just ADMIN/non-ADMIN labels. Preserve smooth ordinary paper trading.

### D26 — P1 before hosting: deployment/backup/recovery are incomplete

Source-confirmed/validation gap. [Compose](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/docker-compose.yml), [API startup](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/apps/api/src/main.ts).

Compose starts only Postgres/Redis, publishes their ports on all interfaces and uses development credentials. API binds 0.0.0.0. No complete production process/deployment configuration, tested restore, readiness including worker/provider liveness or migration-upgrade drill is demonstrated. Changing ADMIN_PASSWORD in env does not rotate an existing seeded user's hash because bootstrap only creates missing users.

Fix: local loopback bindings, private production network, app health/process supervision, TLS/reverse proxy, graceful drains, safe migration orchestration, explicit password rotation, encrypted backup and tested restoration. Prevent test/soak scripts from accepting operator accounts/databases. Do not expose development defaults while claiming NODE_ENV checks alone establish security.

### D27 — P1: CI and soak do not prove end-to-end readiness

Source-confirmed/validation gap. [CI](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/.github/workflows/ci.yml), [soak](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/scripts/soak-capacity.mjs), [browser setup](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/apps/web/playwright.config.ts).

301 passing tests are useful. CI does not run builds/browser/migration-upgrade/capacity tests. Browser config has no managed server startup. Existing soak directly calls reservation/OCO helpers, not the full worker/data/UI pipeline; 50 slots does not mean 50 filled protected positions. Config caps discovery at 100 versus the original 200 target. Some tests assert source wiring/helper existence or conditionally assert a fill only if it exists.

Fix: non-vacuous worker/database scenarios, browser keyboard/mobile tests, production builds, upgrade/restore checks and a guarded full-engine harness. Publish supported capacity/latency from measured results, not target counts. Longer observed-data beta needs honest duration and market coverage.

### D28 — P2: research/model operations need evidence lineage and cost boundaries

Source-confirmed/design upgrade. [Model router](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/packages/evolution/src/router.ts), [lab](https://github.com/TheFridey/QUANT/blob/be0923305193cfbf5ccfbf6336663e0b002ca5bf/apps/api/src/lab.service.ts).

Default model identifiers include placeholders such as gpt-research/claude-research. Router default budgets are memory-backed unless a store is provided; cross-process reservations/spend enforcement needs verification. Research UI seeds a hard-coded hypothesis rather than offering a complete configurable experiment workflow. Generated discoveries need observed-data provenance and independent evidence, not a successful pipeline status.

Add provider/model configuration validation, shared budget reservations, retry/usage accounting, cancellation, experiment queue states, dataset manifests, comparison, champion/challenger and rollback. Capture BEFORE/DURING/AFTER learning with strict entry-safe reconstruction, account/environment scope and explicit uncertainty. Keep research out of the order-critical path.

### D29 — P2: data growth and snapshot architecture will become costly

Source-confirmed. Every terminal refresh builds a large multi-domain snapshot; socket nudges also trigger it. Each agent stage reloads/replans; there are per-pair history/security calls and per-position reconciliation over historical fills. Protection pagination loads all matching rows every snapshot. Backtest loading synchronously caps 20,000 earliest rows without a dataset completeness contract.

Fix after correctness: query budgets, bounded queues/timeouts, account/environment indexes, batched histories, incremental event projections, paginated domain endpoints, retention/archival, materialised summaries and downsampled charts. Measure before introducing new infrastructure. Do not put expensive lab computation on request/exit-critical paths.

### D30 — P2: accessibility and feedback need explicit acceptance

Source-confirmed/design upgrade, not a visual-contrast audit. History rows are pointer-clickable without equivalent row buttons/keyboard behaviour; some mutation calls have no caught error/pending feedback; tiny labels and wide tables require browser review. Modal primitives use Radix, which is a useful base; don't replace working accessibility with custom overlays.

Add labelled controls, focus-visible states, keyboard-complete tables/drawers, live-region mutation results, readable error text, non-colour-only safety badges, reduced-motion support, responsive sizing and touch targets. Run automated checks plus keyboard and mobile browser verification. Offer persistent density/timezone/preferences and explain jargon such as LIVE, DEMO, venue ACK and planned risk in context.

## Suggested product experience

The default Desk should answer: Which account/environment is active? Is data current? What is open? Is every holding protected? What can trade next? Why is anything blocked? What requires my action?

Prioritise an exception queue, open positions, available/reserved capital, open stop risk and unique-opportunity funnel. Include compact strategy/provider summaries, with full research tools a click away. Use a single instrument workspace for chart, quote age, eligibility, strategies, open allocations and order/protection timeline. Keep the dark terminal identity but standardise spacing/type and reduce decorative motion around critical data.

Quality-of-life priorities: revision-safe drafts, async mutation receipts, command search, saved filters/favourites, last-success timestamps, one-click copy of sanitised diagnostics, scoped CSV export, per-position reduce-only close, bulk action previews and a session journal. Persist layout/density/timezone. Default to a fast paper workflow; require confirmation for account-wide flatten, destructive state changes and eventual live activation.

## Ordered programme

1. **Release 1.1: correctness closure.** D01–D07 plus presentation isolation D21. Regression tests use actual PostgreSQL/worker transactions. No cosmetics accepted as substitutes.
2. **Release 2: real market/strategy integration.** D08–D15, with named demo routing, complete lifecycle/reconciliation, scoped instrument eligibility, correct product accounting and executable instance allocations. Finish local implementation even if credentialed verification is blocked.
3. **Release 3: operational UX.** D16–D24 and accessibility D30; build directly on truthful backend contracts. Add onboarding and trade review without hiding advanced diagnostics.
4. **Release 4: operational evidence.** D25–D29, full-engine load/failure/restart/browser/restore tests, observed-data paper beta. Capacity target: 200 configured instruments and 50 simultaneous protected positions where proven on stated hardware. Do not force real-market trades to satisfy a quota.
5. **Separate live-readiness gate.** Complete named live adapter, independent reconciliation, safe protection, human-first approval and explicit bounded automation limits. No automatic transition from local simulation to real orders.

## Probe results

| Probe | Observed result |
| --- | --- |
| P1 | Pending base quantity 2 contributes $2 rather than price-derived dollar exposure |
| P2 | Reconstruction with no reservations resets supplied open exposure/risk/slot usage to zero |
| P3 | Eligible selector accepts an old event with a new receipt, lacks an upper bound, permits null environment |
| P4 | Desired-only native stop reports protected; null lifecycle can match a known current lot |
| P5 | primary:fixture:etf:SPY decodes as fixture:etf:SPY |
| P6 | ACTIVE PROTECTION_RECOVERY alone does not suspend entries |
| P7 | Alpaca guard accepts arbitrary host with paper-api in URL path; no network requests used |

The companion implementation prompt translates every finding into staged work, tests and release gates. It requires rechecking current HEAD before applying this snapshot's findings, preserving later fixes and existing data.
