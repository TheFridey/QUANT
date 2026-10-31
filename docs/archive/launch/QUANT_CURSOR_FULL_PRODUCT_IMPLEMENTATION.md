# QUANT — complete correctness, multi-market execution, operator UX and release readiness

Paste this entire document into Cursor Agent in the QUANT repository. Enable multi-agent execution. Implement the work; do not stop after a plan, a prettier interface, helper functions or a higher test count.

## Mission

Build QUANT into a dependable, active multi-market paper/demo trading MVP with an excellent operator experience. Preserve existing useful work and data. The owner wants many concurrent opportunities across crypto, forex/currency pairs, executable index exposure, equities/ETFs and commodities, selectable by market and strategy. Stop losses, targets, portfolio limits and recovery must actually govern the running engine.

Preserve activity through market coverage, strategy diversity, correct resource allocation and reliable execution. Do not require an ever-growing chain of model approvals before every trade. Do not force trades to satisfy a daily count or silently increase leverage/risk. A quiet market is valid; broken integration or unexplained blocking is not.

The initial deliverable is internal paper trading driven by observed market data, isolated fixture/replay testing, and a complete named external demo route. Real-money execution remains disabled. The eventual product is human-first live approval by default, with explicitly enabled bot execution bounded by user capital, slippage, per-trade loss, total open risk and account limits. Implement the policy/config boundaries now without enabling a live-money route or submitting real orders.

This assignment authorises normal repository implementation and reversible local testing. Do not merge to main, deploy to an existing live environment, purchase subscriptions, sign up/fund provider accounts, send external messages or place real-money orders. Create reviewable PRs and exact owner setup instructions. Missing credentials should block actual external verification, not all remaining coding.

## Baseline and evidence

The audit baseline is main `be0923305193cfbf5ccfbf6336663e0b002ca5bf`, Release 1 PR #3. Merge CI passed 301 tests with one skip, migrations/typecheck/lint. Inspect current HEAD and reproduce each finding; do not overwrite a later fix. Read AGENTS.md and all applicable repository instructions.

Companion report: QUANT_DEEP_AUDIT_RELEASE1.md, dated 29 October 2026. If supplied, read it and copy the findings into docs/launch as an immutable baseline. If it is not present, continue using the self-contained requirements below. Do not block implementation waiting for an attachment containing information already in this prompt.

The audit used source review and focused probes, not a running browser/broker/full local suite. Treat source-confirmed findings as regression candidates and design upgrades as product requirements. Do not claim existing application behaviour was visually verified by that audit.

### Findings to reproduce and close

- D01: cycle account/environment/config context recalculated from global configuration rather than pinned durably at creation.
- D02: history, latest marks/orders/decisions, research datasets and recovery remain partly unscoped; null legacy environment treated as compatible.
- D03: eligible fill selection checks receipt lower bound, lacks now upper bound and can accept old provider events/future data.
- D04: pending quantity is added directly as dollar exposure; reconstruction overwrites open usage; remaining/total slot semantics conflict.
- D05: active protection recovery alone does not suspend expansion; reconciliation/safety can change after orders are planned.
- D06: colon-delimited account/instrument keys are decoded incorrectly; coverage accepts desired-only native stops and unknown-lifecycle legs.
- D07: unresolved recovery intents are global/untyped, use global marks/config and lack the complete account-lock/lifecycle/idempotency discipline.
- D08: mandatory refresh awaits discovery, is Solana-specific, caps some fallback lookups at 20 and lacks reliable deadlines.
- D09: SANDBOX still books local PAPER fills; named demo providers lack a complete integrated execution/reconciliation lifecycle.
- D10: practice-host checks use substrings; readiness is key-presence-based; quote validation incomplete.
- D11: strategy instances only gate a global strategy allowlist; zero entries can permit fallback; instance exits/budgets/ownership incomplete; mean-revert never enters.
- D12: promoted HOLD can bypass ordinary exit logic; replay/runtime differ; broad product metadata exceeds actual ledger capabilities.
- D13: promotion accepts client evidence fields instead of resolving/binding persisted report/artifact/config server-side.
- D14: performance/funnel windows mix cohorts; attribution fee breakdown and unique opportunity semantics incomplete.
- D15: MarketSelection toggles persist but do not govern worker admission/subscriptions.
- D16: Pause-new-entries uses a config endpoint that refuses RUNNING changes; promotion freezes operational flags; close while paused blocked; resume clears flatten intent.
- D17: polling replaces config object and overwrites unsaved strategy drafts.
- D18: socket connectivity labelled market-live; overlapping refresh can overwrite state; stale UI can still enable actions.
- D19: manual ticket lacks durable client intent ID, preview and reliable async receipt; closing depends on discovery tape.
- D20: position table lacks direct risk-reducing actions and clear urgent failure/recovery states.
- D21: scoped accounts can be presented against global marks and receipt-derived freshness that ignores provenance.
- D22: recent 40 orders masquerade as history; no proper multi-fill trade detail, pagination, scoped export or durable deep links.
- D23: first-session/provider onboarding remains developer-oriented.
- D24: 22 top-level modules/mobile strip needs a coherent information hierarchy and saved workflows.
- D25: JWT/role revocation, socket expiry/origin/account scope and distributed auth limiting incomplete for shared deployment.
- D26: Compose exposes development database/cache ports; production process, rotation, upgrade and restore evidence missing.
- D27: CI lacks build/browser/upgrade/full-engine capacity proof; helper slot tests are not active protected positions; universe ceiling=100.
- D28: research/model configuration, shared spend boundaries, experiment lineage and comparison workflow need completion.
- D29: monolithic snapshots, repeated planning and N+1 history/reconciliation will become expensive; data retention/query contracts incomplete.
- D30: keyboard/mobile/accessibility, mutation feedback, density/preferences and readable error/state presentation need explicit tests.

## Orchestration and delivery rules

Use a coordinator plus specialists for (1) context/accounting/reservations, (2) protection/recovery/safety, (3) providers/instruments/sessions, (4) strategies/research/replay, (5) API/terminal UX, (6) integration/security/operations. Adapt agent count to available slots. Assign one owner per shared contract/schema/migration and use worktrees/branches where available. Cross-review money/protection code independently from its author.

Freeze domain contracts before parallel implementation. Keep the current TypeScript/Nest/Next/Prisma/BullMQ structure unless a bounded change is justified. Avoid duplicate engines, incompatible quantity models or broad unrelated rewrites. Preserve existing balances, orders, fills, records and additive migration history. Never reset a user database to make tests pass.

Create docs/launch/PLAN.md, FINDINGS_MATRIX.md, CONTRACTS.md, DECISIONS.md, EVIDENCE.md, CAPABILITIES.md and RUNBOOKS.md. Each D01–D30 needs implementation paths, actual runtime call sites, regression command/result, external dependency and status. Keep implementation completeness separate from VERIFIED_UNIT, VERIFIED_DB, VERIFIED_WORKER, VERIFIED_BROWSER and VERIFIED_EXTERNAL. Compute counts from rows rather than grouping requirements into flattering totals.

Continue implementing all locally feasible work through the gates below. If a real dependency is missing, record an exact blocker and continue independent work. Context exhaustion means checkpoint/resume, not declaring completion. Do not repeatedly ask for permission for normal development already authorised by this assignment.

## Core invariants

1. One immutable account/environment/execution/strategy/config context owns every cycle, intent, reservation, order, fill, protection and report event.
2. Every monetary amount has an explicit currency; every quantity has instrument units. Decimal math and venue rounding are mandatory for financial values.
3. Every filled opening quantity has valid current-lifecycle protection or a durable urgent recovery state with bounded remediation. No green badge based on a desired object alone.
4. Stops/exit/reconcile continue independently of new-entry pause, discovery eligibility, research/model availability and UI navigation.
5. Retry can never create duplicate exposure or close a new position because an old lot had an unresolved intent.
6. Open plus pending exposure/risk/reserved resources are counted exactly once across workers and modes.
7. Fixture/replay/market-data-paper/external-demo execution and statistics cannot cross-contaminate. Unknown provenance is quarantined, not trusted by default.
8. Operator ACK is not safety resolution. Only verified recovery/reconciliation or an explicit audited policy action changes safety state.
9. Strategies/models emit intents and research; the trusted gateway owns risk and execution. Generated code cannot read secrets, alter account caps or call venues.
10. Evidence labels are honest: fixture, unit, database, worker, browser, external demo, observed-data paper and live are distinct.

## Programme: 60 implementation stages

### 01 — Baseline, reproduce and preserve

Record branch, SHA, dirty tree and current checks. Reproduce D01–D30 where possible and separate fixed, confirmed, partially confirmed and design-only items. Inspect current PRs and ownership before branching. Document backup before migrations and identify any potentially contaminated paper history without deleting it. Run baseline tests/builds and record pre-existing failures accurately.

Acceptance: baseline/evidence matrix exists, reproduction commands are runnable and unrelated failures are not hidden.

### 02 — Freeze execution identity contracts

Define versioned ExecutionContext containing account ID, environment, data mode, execution mode, venue capabilities, config/strategy/risk revisions and immutable intent identity. Model structured account/instrument/lifecycle keys; strings may be display IDs but cannot be parsed to recover execution identity. Validate at boundaries and include correlation IDs in events.

Acceptance: all economic APIs accept validated scope; no accidental implicit primary default in lower-level mutation helpers.

### 03 — Pin context durably at cycle/intent creation

Persist context on cycles and manual intents before enqueueing, including snapshot/revision references. Queue payloads reference immutable records. Every stage loads those records instead of resolving current global config. Define environment-switch/strategy-promotion behaviour with in-flight work; old cycles finish in original scope or are explicitly cancelled. Compare-and-swap active revisions.

Acceptance: pause/switch environment while a cycle is queued cannot redirect economic writes or change the intended strategy silently.

### 04 — Complete environment and dataset isolation

Scope positions/orders/fills/marks/history/funnel/equity/decisions/memory/recovery/lab datasets consistently. Backfill reliable legacy provenance; quarantine ambiguous rows and present a reconciliation report. Eliminate cross-environment account fallback and null-environment compatibility in trading. Allow explicit research dataset composition only with a recorded manifest and visible provenance. Include account scope in exports and deep links.

Acceptance: identical instruments/timestamps across FIXTURE and MARKET_DATA_PAPER never influence each other's decisions, ledger or performance.

### 05 — Replace delimiter-based position keys

Add explicit accountId, instrumentId and lifecycleId wherever recovery/protection still derives them from positionKey. Migrate safely and keep legacy display keys readable. Use exact foreign-key/identity matching; do not match by suffix or accept null lifecycle for a known current position. Define legacy-lot repair without inventing historical fills.

Acceptance: primary:fixture and other colon-containing account IDs work for refresh, trigger, retry, coverage and close; two lots cannot share protection accidentally.

### 06 — Establish timestamp and eligible-fill policy

Define provider event time, received time, decision time, eligibility, expiry and processing time. Pending fills need the right instrument/environment and a permitted market event within time bounds; future events/receipts cannot be consumed. Missing provider event time has explicit limitations. Preserve decision and fill observation IDs. Respect order expiry and venue sessions without relabelling old quotes as fresh.

Acceptance: changed-price eligible fill test plus old-event/new-receipt, future, delayed, expired, wrong-environment and missing-time cases.

### 07 — Rebuild authoritative budget semantics

Define total capacity, existing open usage, reserved remainder and available capacity separately. Value quantities using valid prices, contract multipliers and conversion; never use base quantity as dollars. Include costs and stress buffer where appropriate. Stop risk must derive from actual remaining protection distance/policy, not only current global stop percent. Unknown material account exposure blocks expansion with a reason.

Acceptance: hand-calculable examples reconcile open and pending cash/exposure/slots/risk exactly once.

### 08 — Make reservations durable and idempotent

Correct reconstructBudget to preserve authoritative open usage without double counting consumed fills. Include all entry routes, including operator orders. Reserve under account lock or equivalent serialisation. Mutation events need stable IDs and remaining-amount checks. Reject negative/non-finite/fractional-slot requests; repeated partial releases cannot create resources. Reconstruct across restart from orders/fills and durable reservation events.

Acceptance: two independent PostgreSQL clients race for the last resources; expected admissions only, including existing positions and fee reserves.

### 09 — Correct settlement/admission ordering

Under the immutable context, apply pending cancellation/settlement policy, reconcile relevant safety/account state, refresh book/caps, allocate intents, reserve, revalidate and commit. Re-evaluate expansion safety at settlement where required. Suppress duplicate pending entry intents by account/instrument/instance as policy dictates. After each economic mutation update budgets before the next admission. Exits retain priority.

Acceptance: pending fill plus same-cycle proposals cannot exceed position/risk limits or spend cash already used; halt/safety changes cannot be bypassed by earlier plans.

### 10 — Complete safety effects and resolution

Define effects/scopes for ENTRIES_SUSPENDED, PROTECTION_RECOVERY, RECONCILE_ISSUE, breakers and incomplete flatten. Notification ACK is separate. Active unprotected-risk recovery must have a documented expansion policy and urgent remediation. Resolve only after the actual condition clears; acknowledgement or clearing a fault flag is not sufficient proof. Surface active controls independently from alert visibility.

Acceptance: same-cycle safety activation blocks affected new risk; clean resolution reopens only the appropriate scope while exits continue.

### 11 — Complete lifecycle ownership of protection

Persist opening/closing lifecycle identity on the relevant orders/fills or a dedicated lifecycle record, with openedAt and extrema. Arm every opening fill route atomically. Resize remaining protection on adds/reductions; cancel terminal legs on flat. Use executable entry basis and explicit quantity coverage. Do not approximate lot identity using the timestamp when protection happened to be created.

Acceptance: immediate/pending/partial entry, close, reopen, scale-in and partial exit each preserve current-lot coverage and correct time/trailing metadata.

### 12 — Make native and synthetic protection truthful

Native protection is effective only when venue acknowledgement/status/quantity/trigger meet its contract. Desired-only, submitted, rejected and unknown remain distinct. Synthetic protection is labelled engine-dependent. Validate long/short stop side, tick rounding and distance; model stop-market versus stop-limit accurately. Stops cannot guarantee exact realised loss through gaps.

Acceptance: a desired-only native stop never yields protected=true; stale or wrong-lot legs never cover a holding.

### 13 — Type and scope all recovery intents

Separate EXIT_RETRY, AMEND_RETRY, CANCEL_RETRY and RECONCILE_UNKNOWN with immutable account/environment/instrument/lifecycle and stable economic intent ID. Claim retries transactionally and acquire the account mutation lock before changing the book. Do not sell a position because an amendment failed. Fence old-lifecycle recovery against current holdings. Bound retries/backoff and alert escalation; reconcile unknown submits before resending.

Acceptance: two retry workers, duplicate callbacks, old failed lot plus reopened holding, failed amendment and partial exit produce no unintended close or duplicate effect.

### 14 — Make stop/target/trailing/time independent of strategy HOLD

Build an invariant position manager shared by runtime/replay. Strategy HOLD cannot bypass protection or time-based exits. Persist trailing extremes and last confirmed amendments; trailing cannot loosen accidentally. Maintain correct partial quantities and stop/target OCO behaviour. Prevent exit of one allocation from reversing/closing another unintended allocation.

Acceptance: a promoted strategy that always HOLDs still has effective stop/target/time management; crash/restart keeps the same protection semantics.

### 15 — Prioritise mandatory data refresh

Create a durable mandatory subscription set from holdings, pending orders, active protection and unresolved recovery. Fetch it independently before/alongside discovery under bounded resource budgets. Route by provider; batch all targets with explicit fairness/rotation rather than silently dropping beyond 20. Use timeouts/abort and per-provider health. Track last-success/coverage debt per holding.

Acceptance: discovery hangs and 50 holdings leave discovery; healthy risk feeds and protection still progress, and unavailable instruments raise scoped recovery rather than fake freshness.

### 16 — Complete the market-data gateway

Wire the named providers into actual worker configuration, not only a status page. Preserve bid/ask, event time, origin, entitlement and session metadata end to end. Validate finite positive prices, spread direction, tradable status, event age and instrument mapping. Separate reference/delayed valuation feeds from executable intraday quotes. Use capabilities instead of Solana-specific required fields.

Acceptance: healthy crypto/FX/ETF observations reach the same paper pipeline without synthetic transaction counts, and one provider failure leaves unrelated routes alive.

### 17 — Enforce real market selection

Implement scoped discover, watch, entry-enabled and monitor-existing states. The worker must load effective selections/revisions and include them in subscription/admission. Disabling new entries never removes current-risk monitoring. Display registry support separately from configured, connected, warmed-up, session-open and tradable. Migrate the existing MarketSelection UI/state into this real control.

Acceptance: disable a market and prove no new automatic entry; an existing holding in it still refreshes and closes.

### 18 — Complete provider configuration and readiness

Use current official documentation for chosen adapters. Parse URLs and allowlist exact practice/data hosts/schemes/ports; reject live hosts hidden in paths/query/userinfo and unsafe redirects. Inject local test transports explicitly. Readiness needs missing credentials, invalid configuration, connecting, auth failure, missing entitlement, degraded and ready. Presence of a key is not a network health check.

Acceptance: URL guard adversarial tests, revoked credentials, rate limits, malformed quotes and missing entitlements produce actionable provider-scoped states without exposing secrets.

### 19 — Finish named external demo execution

Implement a complete supported provider lifecycle: instrument metadata, quotes/bars, submit with idempotency, order lookup, cancellation, fills, balances, positions and protection. Wire through an ExecutionGateway. Do not let SANDBOX merely stamp local PAPER fills. Build offline official-contract-derived tests and an explicit opt-in credentialed verification script. Do not send demo orders automatically because keys exist.

Acceptance: implemented demo route supports entry→fill/partial→protection→cancel/close→reconciled flat. Missing credentials block only the authenticating verification step; unsupported features remain labelled.

### 20 — Add authoritative venue reconciliation

For external demo, fetch venue snapshots/events independently of the local ledger. Reconcile orders/fills/positions/cash/reservations/protection and unknown submits. Detect missing local position rows and external manual changes under an explicit ownership policy. Internal paper reconciliation must independently validate ledger cash/net fills and coverage, not only copy orders into a broker-shaped list.

Acceptance: a broker-accepted timeout, externally removed stop, missing position row and balance drift suspend appropriate expansion and recover without fabricated correcting fills.

### 21 — Finish product and currency accounting

Support an explicitly documented product subset correctly: base/quote/settlement currency, contract multiplier, tick/lot/minimum, conversion source/time, fees, financing/funding and margin where implemented. Signed short accounting requires its own verified path; don't infer it from a SHORT stop helper. Refuse unsupported futures/borrow/derivatives. Distinguish FTSE/SPX reference levels from actual executable products. Retain accurate gold/oil proxy labels.

Acceptance: known FX cross/non-USD/ETF/commodity examples reconcile by hand; unsupported products cannot submit plausible-looking incorrect orders.

### 22 — Use accurate venue sessions and costs

Source calendars from a tested maintained abstraction or bounded verified venue data, with holidays/DST/early close/maintenance. Avoid US-equity hours for UK/commodity products. Use market-specific bid/ask/commission/minimum/slippage/funding/conversion models. DEX liquidity impact is not a universal FX/ETF model. Track model assumptions and actual-vs-estimated costs separately.

Acceptance: session and cost fixtures include early closes, FX weekend, crypto maintenance and gap-through stops; closed markets never generate fictional eligible executions.

### 23 — Make strategy instances executable owners

Persist explicit module/version/artifact binding, enabled instruments/timeframe/parameters/budget/status/health for each instance. Execute accepted instance intents, not just an allowlist around global PULSE. Zero eligible intents means zero new entries. Instance EXIT intents must reach the trusted position manager. Remove implicit name-substring module dispatch. Default instances must not reseed/reactivate deliberately paused user instances.

Acceptance: multiple instances actually produce distinct orders under their own identity; pausing one leaves others active and its position protection maintained.

### 24 — Add strategy allocations and conflict/netting policy

Represent internal strategy allocations separately from venue net positions. Define same-symbol, opposing-signal, pyramiding and hedging/netting policy. Attribute each fill, fee, realised/unrealised amount, stop and memory record to exact instance/lifecycle. Independent instance budgets cannot bypass account caps. Maintain reduction semantics during partial fills and external netting.

Acceptance: two instances share an instrument; one exits only its allocation; venue net exposure and all attribution reconcile exactly.

### 25 — Implement useful strategy diversity

Retain transparent momentum and implement actual trend/pullback, breakout and mean-reversion entry/exit conditions for supported markets. Mean-reversion must be able to enter and have a falsifiable hypothesis; breakout needs historical range/structure, not merely renaming the same percent threshold. Warmup uses real complete bars/history and market-appropriate indicators. Configure thresholds by family/market rather than copying a 2% M5 crypto threshold everywhere.

Acceptance: deterministic positive/negative/no-signal cases for each family, sensible cost-aware stops/targets and explicit capabilities. No profitability or minimum-frequency claim from fixtures.

### 26 — Implement deterministic opportunity allocation

Allocate actual intents by exit priority, available risk/cash/margin, cost assumptions, priority and bounded instance fairness. Include shared-factor/correlation groups without making missing historical correlation a universal block. Distinguish hard account constraints, instrument constraints and advisory warnings. Maintain a reasoned decision record. No external LLM call in the order-critical path.

Acceptance: identical input gives identical allocation; a fast strategy cannot monopolise all slots; correlated small trades consume the appropriate shared budget.

### 27 — Unify runtime and replay

Use the same strategy, risk, position-management and sizing modules with a deterministic clock/event interface. Both paths respect pending reservations, sessions, expiry, costs, conversion and account loss limits. Do not assert parity solely by testing a shared helper; feed the same tape through the actual runtime harness and replay and compare intents, admissions, protection and accounting.

Acceptance: non-vacuous parity suite includes realised buys/sells, partials, safety limits, trailing/time exits and changed eligible fill prices. Explain legitimate venue-execution differences explicitly.

### 28 — Make promotion server-evidence-backed

Promote persisted report/artifact/config IDs, not a client-supplied assertion that evaluation passed. Resolve immutable report/dataset/source/artifact hashes, approval, sample and forward-paper evidence server-side. Bind exact parameters and capabilities. Use revision-safe operator promotion/rollback. Built-in preset promotion must say preset; arbitrary generated execution must prove reviewed artifact dispatch. Offer explicitly labelled experimental-paper instances where appropriate without falsely claiming validation.

Acceptance: a forged/altered request cannot substitute a different config or artifact; approval applies to precisely the executed implementation.

### 29 — Complete safe research autonomy and model operations

Validate configured model identifiers/providers against actual available configuration; placeholders cannot masquerade as connected models. Implement shared spend reservations and usage audit across agents/processes, cancellation/timeouts and retry accounting. Sandbox generated code with resource/process/network/filesystem/secret isolation. Enforce no risk-policy mutation or direct execution. Keep approved trading alive if research/models fail.

Acceptance: concurrent model jobs cannot overspend the configured budget by racing; malicious artifacts fail; isolation skips are explicit and prevent untrusted-code execution claims.

### 30 — Make learning and trade memory useful

Store scoped BEFORE/DURING/AFTER observations, decisions, expected risk, costs, regime/hypothesis and outcome for wins and losses. Entry reconstruction excludes future/post-exit data. Add dataset/strategy/version lineage, comparable-case search and uncertainty. Research suggestions propose experiments rather than editing approved trading silently. Capture failure cases as evidence without inventing explanations from outcome alone.

Acceptance: a reconstructed entry contains only information available then; every claim can link to a measured trade/dataset and the correct account/environment.

### 31 — Correct analytics and reporting windows

Use consistent explicit account/environment/strategy/date/cohort filters. Build lifecycle-level closed trades from fills/allocations with fee attribution, weighted prices and partials. Show realised/unrealised/net/fees separately, sample size and data coverage. Do not combine last-200 wins with all-time fees and earliest-500 drawdown as one unlabeled metric. Handle deposits/withdrawals/session reference/HWM under a documented timezone policy.

Acceptance: exported and displayed totals agree with ledger reconciliation for the selected range, including multi-fill and cross-currency cases.

### 32 — Rebuild the opportunity funnel from actual events

Persist stable opportunity/intent/order/fill/lifecycle IDs. DISCOVERED, SIGNALLED, RESERVED, SUBMITTED, FILLED, REJECTED and CLOSED must correspond to actual transitions. Don't label a planned order ORDERED after reservation denied it. Count repeated polls separately from unique opportunities. Add selectable period/cohort and decisive block with actual/threshold/policy/scope. Include late pending fills and cancellations.

Acceptance: operators can explain a zero-trade day, and fixture/real-data/instance counts remain distinct and reproducible.

### 33 — Freeze truthful operator presentation contracts

Create typed view models for execution identity, provider health, quote state/age, account safety, current protection coverage, budgets and action eligibility. The API must derive marks from the same scoped provenance rules as execution. Client pages use one definition of LIVE/DELAYED/FIXTURE/SANDBOX/closed/unavailable. Add monotonic snapshot revision and server time. Hide secret/config internals that do not help operator decisions.

Acceptance: a fresh receipt of a fixture/delayed quote cannot turn a badge green LIVE; account/environment is consistent on every route.

### 34 — Redesign navigation around operator jobs

Keep the dark QUANT terminal identity but consolidate primary areas into Desk, Markets, Orders & Positions, Strategies, Research and Operations. Use nested routes/tabs for agents, genome, forge, confidence, memory and models. Preserve useful deep links and diagnostics. Add breadcrumbs, global command/instrument search, favourites and a compact persistent safety/action area. Avoid a 22-item horizontal strip on mobile.

Acceptance: users can reach an urgent failed position, a provider setup problem and a strategy experiment within a clear short path, using keyboard or touch.

### 35 — Build the operational Desk

Show current account/environment/venue and last successful update prominently. Prioritise exception queue, open positions, confirmed protection coverage, open stop risk, available/reserved capital, unique-opportunity funnel and healthy active strategy/provider summary. Make research secondary by default. Show queued/in-progress/failed action states. Provide useful empty, booting, warming-up, market-closed and unavailable states with next steps.

Acceptance: the Desk answers what is trading, what is protected, what is blocked and what needs intervention without interpreting raw JSON.

### 36 — Fix snapshot/reconnect architecture

Coalesce polling/socket invalidations, abort obsolete fetches and ignore out-of-order revisions. Separate transport connected from data/feed/worker freshness. Persist last-success/age and show retained stale data honestly. Handle connect_error, token expiry, reconnect, backoff and page visibility. Keep one stable provider across terminal navigation; persist refresh preferences and avoid reconnect storms.

Acceptance: delayed responses cannot roll state backwards; reconnect recovers correct scoped data; unavailable backend doesn't leave apparently actionable fresh tickets.

### 37 — Build resumable first-session onboarding

Guide environment/account selection, infra diagnostics, providers/capabilities, credential verification, instrument eligibility, feasible risk/strategy presets and first paper session. Offer an explicit isolated fixture demonstration without contaminating paper. Provide copyable sanitised diagnostics and exact external setup dependencies. Never imply credentials are the only remaining blocker for unimplemented methods. If credentials are entered in-app, keep encryption/redaction/replace/revoke and server-only use explicit.

Acceptance: a new operator can start the supported paper path and distinguish missing infrastructure, data entitlement, session closure and minimum-capital problems.

### 38 — Build an instrument workspace

Add searchable/filterable markets by asset/venue/session/data readiness/entry eligibility; favourites and saved views. One instrument page combines provider quote age, chart, strategies, allocations, recent decisions, risk budget, pending/protection orders and timeline. Show actual tradable product identity separately from reference indices/proxies. Market toggles must reflect effective worker state/revision.

Acceptance: an instrument outside discovery but held remains selectable/manageable; unsupported products clearly explain the missing capability.

### 39 — Upgrade charts honestly

Use actual OHLC/bid-ask data where supported with timeframe selection and timezone/session markers. If only sampled observations exist, label a sampled-price chart and don't invent candles. Overlay fills, entry, stop/target/trailing, uncertainty and lifecycle boundaries. Bound/ downsample long histories with server-side complete-range metadata. Synchronise selected instrument/timeframe across relevant views.

Acceptance: overlays match ledger prices/times; stale/fixture/delayed provenance is visible and chart controls work on mobile and keyboard.

### 40 — Implement a fast, previewed manual ticket

Provide account/environment, direction/capability, notional/quantity, price source/age, estimated costs, stop/target and planned loss/capacity impact before submission. Use a stable client intent/idempotency key; retries query the same receipt. Return async acceptance and progress rather than polling inside a request for 12 seconds. Unknown result is pending reconciliation, not an invitation to duplicate. Revalidate on the server.

Acceptance: double-click/reload/network timeout creates one economic intent; invalid previews show field-specific reasons. Keep ordinary paper flow quick and consequential confirmations proportional.

### 41 — Make positions operationally actionable

Add sort/filter/search, column/density preferences and mobile cards. Show direction, strategy allocations, executable mark age, net P&L, stop distance/risk, coverage quantity, synthetic/native confirmation and remaining exits. Provide position drawer with immutable lifecycle/order/protection timeline, copy IDs, reduce-only close/partial close and authorised protection changes. Failed/unknown/unprotected states need prominent text plus colour and a next action.

Acceptance: operator can close a selected held instrument while new entries are paused; actions survive refresh and show reconciled completion.

### 42 — Add scoped bulk and emergency controls

Separate pause entries, pause instance, cancel pending entries, flatten selected, flatten account and emergency halt. Give preview/progress per instrument, market-closed/failed reasons and durable action IDs. Flatten persists until its target state is reconciled; resume must not silently clear an incomplete request. Make controls reachable from all terminal pages without accidental activation. Account-wide destructive actions require a reviewable confirmation.

Acceptance: reconnect/restart/repeated clicks preserve one action; partial failure remains visible and pending with exit monitoring active.

### 43 — Separate strategy, risk and operating settings

Operational commands work while RUNNING. Immutable strategy promotion does not freeze pause toggles or provider controls. Hard risk policy is separately authorised/versioned and cannot be overwritten by a strategy artifact. Define effect of parameter changes on existing positions; tighter budgets restrict expansion without deleting stops. Provide before/after diff, affected positions and compatibility/feasibility checks.

Acceptance: Pause new entries acts immediately after a promoted strategy is active; existing protection is preserved through config changes.

### 44 — Preserve editable drafts and useful validation

Replace polling-driven form resets with dirty drafts keyed by config revision. Show unsaved state, reset/apply diff, server conflict and discard confirmation only when needed. Preserve drafts across refresh and route changes as appropriate. Add units, numeric bounds, inline field errors, cost/minimum feasibility and save pending/success states. Reuse accessible form patterns across strategy, risk and provider setup.

Acceptance: type continuously across several snapshot updates; no edit disappears. Concurrent server change produces an explicit conflict instead of lost updates.

### 45 — Build real order/trade history and exports

Use account-scoped cursor pagination and filters for dates, instruments, status, strategies and lifecycle. Distinguish signal, intent, order, fill and closed trade. Show weighted fill prices, all fees/slippage, partials/cancellations/rejections and broker/ledger IDs. Replace raw JSON-only detail with a human-readable timeline, retaining advanced raw view. Add scoped CSV/JSON export and stable internal deep links.

Acceptance: more than 40 orders remain searchable; displayed/exported totals agree with ledger and chosen filters. Keyboard can open every detail row.

### 46 — Complete analytics, journal and comparison UX

Show consistent time ranges and sample labels for equity/drawdown, net expectancy, costs, turnover, exposure time and risk utilisation. Add strategy/market comparisons, planned-versus-realised risk and unique opportunity/block breakdowns. Provide a session/trade journal with owner notes/tags and research links. Persist filters/timezone and clearly distinguish fixture results from observed-data forward paper.

Acceptance: changing the range updates every comparable metric consistently; insufficient sample remains visible rather than implying statistical confidence.

### 47 — Build actionable alerts and diagnostics

Keep durable alert events with severity/account/position/condition, acknowledged-by and independently resolved state. Add filter/dedup/snooze where policy permits, critical alert prioritisation and a link to the relevant action/trace. Optional outbound integrations are opt-in with explicit destinations; don't send externally by default. Provide sanitised support bundle export with config revisions, health and correlation IDs, never secrets.

Acceptance: ACK doesn't hide active safety from the Desk, and resolution follows actual condition recovery. Repeated failures don't flood the owner with identical alerts.

### 48 — Finish accessibility and personalisation

Use keyboard-complete navigation/tables/dialogs, focus-visible styles, semantic labels and live-region feedback. Preserve Radix accessibility. Validate non-colour-only statuses, touch targets, text scaling, reduced motion and small-screen layouts. Add saved density/columns/layout/favourites/timezone/refresh preferences. All errors should identify the operation and remedy; no unhandled control promise or silent mutation failure.

Acceptance: automated accessibility checks plus manual keyboard/mobile walkthroughs, with concrete screenshots/results only from an actual running app.

### 49 — Complete experiment and research workflows

Replace hard-coded hypothesis creation as the main research workflow with editable versioned experiments, dataset/time selection, budgets and success/failure criteria. Support queued/running/cancelled/failed states, logs, report comparison and champion/challenger. Show train/validation/untouched/forward evidence and sample limitations separately. Approval links to exact persisted artifacts; researcher autonomy never becomes a hidden live deploy.

Acceptance: owner can create a hypothesis, run a bounded experiment, compare results, inspect evidence and explicitly promote a supported candidate with traceable lineage.

### 50 — Complete sessions/auth and API boundaries

Declare single-operator versus multi-user scope. Implement server-side role/session revocation, password rotation and token expiry; logout should match the documented security model. Authenticate/revalidate WebSockets with allowed origins and account rooms; don't broadcast all account events to every authenticated connection. Add proxy-aware shared auth rate limiting and typed API errors/response validation. No credential in logs or client bundles.

Acceptance: revoked/expired users lose HTTP and socket access; unauthorised control requests fail; ordinary authenticated paper operations remain responsive.

### 51 — Make deployment configuration safe and repeatable

Separate local and hosted config. Bind local Postgres/Redis to loopback; use private production networking and secrets. Provide app/API/worker process supervision, production build/start commands, TLS/reverse-proxy settings, CORS/WebSocket origin config, health/readiness including worker/provider state and graceful shutdown/drain. Preserve persistent volumes and protect secrets in diagnostics. Add least-privilege account/provider guidance.

Acceptance: clean install and upgrade run from documented commands; no publicly exposed development DB/cache or accidental live startup.

### 52 — Add migration, backup and restore discipline

Use additive migrations with upgrade tests from a representative existing database. Make account initialisation and opening ledger entry atomic/idempotent. Handle pre-existing unprotected lots and ambiguous provenance with a reviewable repair plan. Implement backup/retention/restore commands and actually exercise restore on a test environment. Guard every destructive test/soak command against operator database/account scope.

Acceptance: migration preserves old financial records and new invariants; restored state recovers orders, reservations, protection, safety and strategy revisions coherently.

### 53 — Complete queue ownership, outbox and recovery

Use durable stage transitions/outbox dispatch so crash between DB commit and enqueue cannot lose a cycle. Renew leases or use enforced fencing at write boundaries; a TTL token alone is not sufficient. Busy work should deliberately defer/retry rather than report success. Recover stale jobs with ownership checks. Scope concurrency by account while allowing bounded parallel data/strategy work and priority exits.

Acceptance: worker stalls beyond TTL, loses ownership, resumes, crashes at enqueue boundary and duplicates jobs; exactly one economic effect and eventual recoverable stage progress.

### 54 — Optimise data/query paths using measurements

Measure query counts/latency for snapshots, stages, history, security and reconcile. Batch histories/marks, bound provider calls and re-evaluation, split domain endpoints and use incremental projections where useful. Add account/environment/instrument/time/status indexes and retention/archival policies. Prevent 20,000-row silent backtest truncation; paginate datasets with completeness metadata. Downsample charts explicitly. Avoid premature new infrastructure.

Acceptance: performance improves under representative load without changing economic results or making critical state eventually consistent in an unsafe way.

### 55 — Build meaningful regression/contract coverage

Each confirmed D finding needs a regression that fails on the old behaviour. Test integer/unit conversions plus real decimal precision/rounding with production dependencies. Use official provider payload fixtures at HTTP boundaries. Avoid tests that only assert function existence/source strings or `if (fill)` assertions that succeed with no fill. Keep fixture, database, worker and external claims distinct.

Acceptance: tests prove admissions, economic effects, coverage and scope with explicit expected outcomes, including failures and no-signal cases.

### 56 — Exercise full-engine fault scenarios

Run PostgreSQL/Redis, actual processors and API against a deterministic fake venue/data transport. Inject duplicate/out-of-order fills, unknown submit, partials, rejected protection, failed amendment, stale data, wrong provenance, delayed eligible events, price gaps, market closure and restarts. Include two independent workers/processes and API-triggered controls. Simulate external manual changes and lost queue publication.

Acceptance: no duplicate exposure, resource creation, wrong-lot exit, fictitious fill or false protection/flatten success; safety remains until verified resolution.

### 57 — Add browser and production checks to CI

Run production builds, migrate a fresh DB and upgrade fixture, then Playwright against managed API/worker/web services. Cover onboarding, edits across polling, market eligibility, manual intent receipt, pause/close, emergency progress, history/export, alerts/ACK, stale/reconnect and environment isolation. Test desktop and mobile/keyboard accessibility. Never use real credentials or operator databases in CI.

Acceptance: the merge pipeline proves the important user journeys, not merely that components compile.

### 58 — Measure actual capacity and paper soak

Target 200 enabled instruments and capacity for 50 simultaneously filled protected positions with explicit sufficient fixture capital on stated hardware. This is a capacity target, not a quota for actual market trades. Use the full engine, not direct helper calls. Define SLOs before measuring: quote/decision/submit/protection/reconcile latency percentiles, backlog, errors and resource use. Stress research/discovery while exits fire. Run the observed-data paper soak actually possible and provide a guarded longer-run command.

Acceptance: publish repeatable commands, duration, market coverage, failures and actual supported capacity. A fixture-shaped test cannot become an observed-data or production SLO claim because keys are present.

### 59 — Verify external demo and document live boundary

When explicit demo test permission and credentials are available, run a bounded permitted lifecycle through the actual gateway including protection and reconciliation. Use a separate account/database scope and retain sanitised evidence. Without access, label external verification blocked with exact setup steps. Keep all real-money submission disabled; list the separate requirements for eventual human-first live and bounded automatic execution.

Acceptance: no generic key-present shortcut, no automatic real order, no claim of external fills from local simulation and no live graduation from a passing paper report.

### 60 — Independent release review and owner handoff

Have an agent independent of each critical implementation review the final runtime call paths and evidence. Update D01–D30 plus all 60 stage statuses mechanically. Deliver a concise owner walkthrough, supported market/mode matrix, deployment/recovery runbooks, known limits and exact external blockers. Provide PR title/body with final scope, tests and risks. Do not merge automatically or declare profitable/production-ready without evidence.

Acceptance: owner can start the supported environment, see truthful health/protection/capacity, understand blocked opportunities and operate/recover the product using the documented UI and commands.

## Release gates

**Gate A — correctness (01–15):** immutable scope, economic units/reservations, eligible events, safety, lifecycle/protection/retry and priority mark refresh proved through worker/database tests. No reliable performance claims until this passes.

**Gate B — market/strategy execution (16–32):** actual provider routing and named demo implementation, selected markets enforced, genuine strategy instances/allocations, shared replay/position rules and evidence-backed promotion/reporting. Credentials may block external verification, not unfinished local methods.

**Gate C — operator beta (33–49):** truthful presentation, functional controls and onboarding, safe drafts and reconnect, actionable positions/history/alerts, mobile/keyboard verification and usable research workflows.

**Gate D — operational release (50–60):** auth/deployment/migration/restore/queue recovery, meaningful CI/full-engine load and paper evidence. Publish measured supported capacity and outstanding dependencies. Live trading is a separate gate.

Stages are dependency milestones, not a requirement to work serially. Parallelise independent code behind agreed contracts and integrate continuously. UI may proceed against typed fixtures, but acceptance requires the real backend.

## Required final handoff format

1. Final branch/SHA and PR links; no automatic merge.
2. Findings matrix D01–D30: fixed or explained with exact code/runtime evidence.
3. Sixty-stage matrix: implementation and verification separated.
4. Capability matrix by asset/provider/account mode: implemented, observed-data-paper verified, external-demo verified, unsupported, blocked.
5. Exact commands/results for tests, build, DB races, worker scenarios, browser/accessibility, migration/restore, capacity and soak. Include skips/duration/hardware and partial limitations.
6. Sanitised screenshots from real browser runs demonstrating Desk, positions/protection failure, draft preservation, mobile controls and history—not static mockups presented as working software.
7. Owner first session and recovery instructions, credential/config requirements, known defects and next decisions.

A large diff or green test count is not the finish line. Deliver correct scoped execution, dependable protection, genuine market/strategy breadth, an operator interface that controls the real engine and reproducible evidence that it works.

Begin with current-HEAD inspection and short parallel work assignment, then implement through the gates.
