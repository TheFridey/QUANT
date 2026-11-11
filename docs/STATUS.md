# Status

The living status of ODIN // QUANT. One file, kept current. Superseded plans, matrices and agent prompts are in [`archive/`](archive/).

Live money is disabled (`packages/shared/src/execution-gate.ts`), and `EXECUTION_MODE` stays `PAPER`. Nothing on this page changes that.

## Evidence labels

| Label | Meaning |
| --- | --- |
| `VERIFIED_UNIT` | A Vitest unit test covers it and passes |
| `VERIFIED_INTEGRATION` | A test against Postgres/Redis covers it and passes (runs in CI; locally when `DATABASE_URL_TEST` names an `odin_test` database) |
| `VERIFIED_E2E` | A Playwright test against the running stack covers it and passes (CI `browser-e2e`) |
| `VERIFIED_CI` | Only CI can show it (Linux, bubblewrap, seccomp), and a CI run showed it |
| `VERIFIED_VISUAL` | Checked from before/after screenshots in [`ux/`](ux/); no automated assertion |
| `PARTIAL` | Part done, with the rest named |
| `DEFERRED` | Not done; the reason is given |

## Audit remediation (30 Oct 2026 audit, baseline `df09deb`)

Merged as PRs #10 (A), #11 (B), #12 (C), #13 (D) and #14 (E). Workstream F is on `refactor/cycle-plan`. The CI fix for the e2e race is PR #15.

### Critical

| ID | Finding | Fix | Evidence | Status |
| --- | --- | --- | --- | --- |
| C1 | Strategies could read future bars through `/proc/self/mem` | The sandbox streams one bar at a time over a lock-step protocol, with per-bar and overall timeouts and no `/proc` | `packages/evolution/src/sandbox-lookahead.test.ts`, `sandbox-protocol.test.ts` | `VERIFIED_CI` |
| C2 | A strategy could forge a sandbox result on stdout | Results are read only from an fd 3 pipe carrying a per-run nonce and per-bar token; every signal is re-validated, one per delivered bar; the static gate is renamed "lint" | `sandbox-forgery.test.ts` | `VERIFIED_CI` |
| C3 | Protective exits were rejected by entry slippage caps, and DEX impact was understated | Exit policy: risk-reducing sells fill up to `maxExitImpactBps` and the rest becomes a pending reduce order. Impact is constant-product on liquidity / 2 | `packages/trading-engine/src/exit-policy.test.ts`, `fill.test.ts`, `store.exit-policy.integration.test.ts` | `VERIFIED_INTEGRATION` |
| C4 | Promotion bypassed the RUNNING lock | Promote and rollback refuse while RUNNING and run as one transaction holding the engine row `FOR UPDATE` | `apps/api/src/promote-paper.integration.test.ts`, `promote-paper.test.ts`, `ops-controls.test.ts` | `VERIFIED_INTEGRATION` |

### High

| ID | Finding | Fix | Evidence | Status |
| --- | --- | --- | --- | --- |
| H1 | Config healing loosened limits | The heal function is removed. An invalid stored config raises a CRITICAL `CONFIG_INVALID` alert naming the fields; the worker runs exits only; `scripts/report-invalid-configs.mjs` reports affected rows read-only | `packages/shared/src/strategy.test.ts`, `apps/worker/src/config-exit-only.test.ts`, `packages/agent-core/src/alerts.test.ts` | `VERIFIED_UNIT` |
| H2 | DEMO and DELAYED quotes opened positions | `allowDemoPaperEntries` defaults to false. DELAYED never opens risk; DEMO entries need the flag and `DATA_MODE=demo` | `strategy.test.ts`, `store.exit-policy.integration.test.ts` | `VERIFIED_INTEGRATION` |
| H3 | The executor transaction had no timeout | `timeout` 20 s, `maxWait` 10 s, per-phase timings stored on the cycle. Plan reads leave the locked transaction through F1 | `apps/worker/src/engine-soak.integration.test.ts` (CI soak: p50 202 ms, p95 356 ms at 24 pairs) | `VERIFIED_CI` |

### Medium

| ID | Finding | Fix | Evidence | Status |
| --- | --- | --- | --- | --- |
| M1 | The sandbox memory limit was not enforced | `RLIMIT_AS` is measured per host and reported in RunnerConfiguration; 512 MB fails and 8 MB succeeds | `sandbox-memory.test.ts` | `VERIFIED_CI` |
| M2 | Seccomp artefacts lived in shared `/tmp` | Artefacts are built into package-owned `sandbox/build`; each run uses `mkdtempSync`; hashes are checked before every bind-mount | `build-sandbox.test.ts` | `VERIFIED_CI` |
| M3 | The hand-written BPF program had no portability guard | A generator script emits the BPF program and its committed SHA-256 is checked. Without seccomp, isolation is unavailable unless `ODIN_SANDBOX_ALLOW_NO_SECCOMP=true`, which the UI shows | `seccomp-profile.test.ts` | `VERIFIED_CI` |
| M4 | The API and web listened on all interfaces | They bind 127.0.0.1 by default; set `API_HOST`/`WEB_HOST` to change it | `apps/web/scripts/next-serve.test.ts`, `packages/shared/src/bootstrap-secrets.test.ts` | `VERIFIED_UNIT` |
| M5 | Sign out did not revoke the token on the server | The web calls `POST /api/auth/logout` first; afterwards the old token gets 401 | `apps/web/e2e/login.spec.ts` | `VERIFIED_E2E` |
| M6 | Socket auth ran after the join | Handshake middleware runs; events go only to the authenticated operator room | `apps/api/src/terminal-gateway.test.ts` | `VERIFIED_UNIT` |
| M7 | The secret checks were weak | `JWT_SECRET` must be ≥ 32 characters and not a known sample; the sample `ADMIN_PASSWORD` is refused whenever `WEB_ORIGIN`/`API_HOST` is not loopback | `bootstrap-secrets.test.ts` | `VERIFIED_UNIT` |
| M8 | A held stage lease reported success and dropped the next stage | A held lease throws the retryable `StageLeaseBusyError` | `apps/worker/src/stage-lease-busy.test.ts` | `VERIFIED_UNIT` |
| M9 | Health used a new Redis client per call and was too detailed in public | One client; public `/health` returns `{status}` only; detail is at `/health/detail`, behind auth | `apps/api/src/health.test.ts` | `VERIFIED_UNIT` |

### Low

| ID | Finding | Fix | Evidence | Status |
| --- | --- | --- | --- | --- |
| L1 | The login attempt map grew without bound, and unknown emails returned faster | The map is pruned on write; unknown emails run a dummy scrypt; trust proxy is documented in RUNBOOKS | `apps/api/src/auth-hardening.test.ts` | `VERIFIED_UNIT` |
| L2 | The revocation check reconnected to Redis on every request | Reconnects back off. Revocation is not durable while Redis is down, so the check returns 503 rather than failing open | `auth-hardening.test.ts`, `token-revocation.test.ts` | `VERIFIED_UNIT` |
| L3 | The daily loss limit used the starting balance | The base is start-of-day equity at Europe/London midnight; no roll while equity is unknown | `packages/risk-engine/src/evaluate.test.ts`, `packages/shared/src/session-equity.test.ts` | `VERIFIED_UNIT` |
| L4 | `paperLatencyMs` was 0 | The default is 1000 ms, taken from the CI soak (ingest to executor p50 706 ms, p95 905 ms, rounded up) | CI soak run 41100034580 | `VERIFIED_CI` |
| L5 | The Alpaca paper adapter used a loose environment read | It now uses a strict allowlist | `packages/market-data/src/fx-feed.test.ts` | `VERIFIED_UNIT` |
| L6 | Isolation tests failed hard without bubblewrap | They skip locally with a reason; a CI guard fails if CI lacks isolation | `sandbox-memory.test.ts` (CI guard) | `VERIFIED_CI` |
| L7 | Vulnerable transitive dependencies (multer, deepmerge-ts) | pnpm overrides pin multer 2.5.0 and deepmerge-ts 8.0.2. Major upgrades of Nest and Prisma are deferred: no patched 11.x or 6.x release exists | `pnpm audit --prod` → "No known vulnerabilities found" (PR #13) | `VERIFIED_CI` |
| L8 | CI permissions were broad and actions were not pinned | `contents: read`, a concurrency group, PR and main triggers only, and actions pinned by SHA. The `quant-safety-reviewer` agent is added | `packages/shared/src/ci-workflow.test.ts` | `VERIFIED_UNIT` |
| L9 | — | No item L9 is defined in the remediation document, so there is nothing to close | — | n/a |

### UI (Workstream E, PR #14)

Before/after screenshots at 1440×900 and 390×844 are in [`ux/before`](ux/before) and [`ux/after`](ux/after). Axe found 59 serious or critical violations before and 0 after; `apps/web/e2e/a11y.spec.ts` keeps it at 0 (`VERIFIED_E2E`).

| ID | Item | Evidence | Status |
| --- | --- | --- | --- |
| UI 1 | Button and input sizes (`font: inherit` in `@layer base`) | screenshots | `VERIFIED_VISUAL` |
| UI 2 | "Execution gate: PAPER only" and "Live: disabled"; API `executionGateOk`, `liveEnabled: false` | screenshots | `VERIFIED_VISUAL` |
| UI 3 | Redis status comes from the queue connection, not "unknown" | health pill | `VERIFIED_VISUAL` |
| UI 4 | Drawdown shown as a negative percentage below the HWM | `apps/web/src/lib/format.test.ts` | `VERIFIED_UNIT` |
| UI 5 | The Overview leads with the desk summary; the checklist moves to Settings; one health pill | `apps/web/e2e/paper-mvp.spec.ts` | `VERIFIED_E2E` |
| UI 6 | Shared number formatting | `format.test.ts`, `command-centre.spec.ts` | `VERIFIED_E2E` |
| UI 7 | Developer copy replaced with plain labels | screenshots | `VERIFIED_VISUAL` |
| UI 8 | Sign out moves to the Account menu; Emergency stop stands alone | `login.spec.ts`, `paper-mvp.spec.ts` | `VERIFIED_E2E` |
| UI 9 | Ticket side toggle, notional/quantity, and a review step with fees, impact, stop risk and exposure | `apps/web/src/lib/estimates.test.ts`, `paper-mvp.spec.ts` | `PARTIAL`: stop and target are shown read-only from the strategy (see deferrals) |
| UI 10 | Chart: volume, entry/stop/target lines, de-duplicated time labels | screenshots | `VERIFIED_VISUAL` |
| UI 11 | Close and Close all confirm with estimated proceeds and slippage | `paper-mvp.spec.ts` | `PARTIAL`: stop/target editing is deferred |
| UI 12 | Recent orders show quantity, time and status | screenshots | `VERIFIED_VISUAL` |
| UI 13 | One Research page with tabs; old paths redirect | `curl -I /terminal/forge` → 307 `research?tab=forge` (PR #14) | `VERIFIED_VISUAL` |
| UI 14 | Mobile: sticky header, one Engine menu, wrapping group strip | mobile screenshots, `paper-mvp.spec.ts` (mobile strip label) | `VERIFIED_E2E` |
| UI 15 | The snapshot is kept across navigation; the header shows "Updated Ns ago" | `SnapshotProvider` in `apps/web/src/app/terminal/layout.tsx` | `VERIFIED_VISUAL` |

### Workstream F

| ID | Item | Evidence | Status |
| --- | --- | --- | --- |
| F1 | One immutable `CyclePlan` per cycle. Stages project it; the executor admits against it with conservative reservation pricing; a malformed plan refuses entries but still runs exits | `packages/agent-core/src/cycle-plan.test.ts`, `apps/worker/src/cycle-plan.integration.test.ts`; quant-safety-reviewer: PASS | `VERIFIED_INTEGRATION` |
| F2 | Split the executor into modules; one `gateAndQuote()` in `store.ts` | `gateAndQuote()` landed in B (#11). The executor phases are in `apps/worker/src/executor/` (`settle`, `plan-consume`, `admit`, `protect`); reconcile stays `StageRunner.reconcileAndAlert`. The code was moved verbatim (checked line by line) and no test changed | `VERIFIED_INTEGRATION` |
| F3 | Order history and the activity feed are scoped to the active account | `apps/api/src/account-scoping.integration.test.ts` | `VERIFIED_INTEGRATION` |
| F4 | Limits tables are generated from `DEFAULT_STRATEGY` and checked for drift; this page; superseded docs archived | `packages/shared/src/limits-table.test.ts` | `VERIFIED_UNIT` |
| F5 | Structured log metrics: `odin_stage_duration_ms`, `odin_queue_lag_ms`, `odin_executor_phase_ms`, `odin_executor_transaction_ms`, `odin_sandbox_run_ms` | `packages/shared/src/metrics.test.ts`, `apps/worker/src/stage-lease-busy.test.ts` | `VERIFIED_UNIT` |

### Deferred, with reasons

- **Editable stop/target on positions and per-order stop/target on the ticket (UI 9, UI 11).** The API has no protection-amend endpoint, and BUY orders accept only `notionalUsd`. Adding them needs new protection-arming paths in the worker and trading engine, which is a protected risk path. Proposed as its own change.
- **Known chunked-exit bias (review F5 on B).** Each exit remainder is quoted against fresh pool liquidity, so a very large exit split into chunks is modelled more favourably than one real constant-product exit. Backtests share this bias. It is documented in `ARCHITECTURE.md` (Accounting), not corrected.
- **Worker `runtimeState` can overwrite `lastPromotion` (review on C).** This is audit metadata only. `StrategyPromotion` remains the record, and config is unaffected.
- **Nest 11.x and Prisma 6.x major upgrades (L7).** Overrides close the advisories; upgrade the majors when patched releases exist.

## Earlier programme items corrected here

| ID | Was | Now | Why |
| --- | --- | --- | --- |
| D25 | `IMPLEMENTED` | `PARTIAL` | Single-operator scope is implemented and tested: logout revocation that fails closed (L2), socket handshake auth with an operator room (M6), and login pruning (L1). Multi-user accounts, per-account socket rooms and a shared, proxy-aware rate limiter are still open. |
| D26 | `IMPLEMENTED` | `PARTIAL` | Loopback binds for compose, API and web are done (M4). A backup and restore drill, and rotating the admin password without an API, are still open. |

The rest of the D01–D30 programme record is in [`archive/launch/FINDINGS_MATRIX.md`](archive/launch/FINDINGS_MATRIX.md).

## Research campaigns (OPERATION EVIDENCE, 11 Nov 2026; branch `evidence/research-campaigns`, not merged or deployed)

Research only. Detail, review outcome and open decisions: [`evidence/ADR-0001-research-campaigns.md`](evidence/ADR-0001-research-campaigns.md); state for the next session: [`evidence/HANDOVER.md`](evidence/HANDOVER.md).

| Item | Evidence | Note |
| --- | --- | --- |
| Durable, resumable campaigns with immutable results | `VERIFIED_INTEGRATION` | Run locally against PostgreSQL; CI not yet run on the branch |
| Programme-wide trial ledger; authorised once-only holdout | `VERIFIED_INTEGRATION` | Open decision: deflated-Sharpe variance floor |
| HORIZON verdict: consumed holdout no longer reported as pending | `VERIFIED_UNIT` | Defect demonstrated before the fix |
| Bounded CLI and opt-in worker job | `VERIFIED_INTEGRATION` | Real evaluator process exercised by the demonstration run only |
| Bridge to GENESIS shadow | `PARTIAL` | ML 2.0 on 24/7 markets only; no route for rule-based strategies or gold/FX models |
| Campaign evidence in API and terminal | `PARTIAL` | API `VERIFIED_UNIT`; browser journey written, not run locally (no Redis) |

## Next

Per the remediation document: record 30 days of DexScreener data, then run one backtest with the corrected impact model and latency. No new features before that.
