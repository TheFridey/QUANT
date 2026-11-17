# AURUM baseline (17 Nov 2026)

OPERATION AURUM, Milestone M0. Branch `aurum/00-foundation`, cut from `origin/main` `2bed7cd`.

**Labels**
- `VERIFIED_REPOSITORY`: checked in code or git in this session.
- `VERIFIED_PRODUCTION`: read-only query this session. There are none: this session did not access production.
- `RECORDED_PRODUCTION`: a production fact read earlier on 17 Nov 2026 (10:16–10:30 UTC) and recorded in [`../horizon/phase-ii/CURRENT-STATE.md`](../horizon/phase-ii/CURRENT-STATE.md). Not re-read here.
- `VERIFIED_TEST`: a test run observed in this session.
- `INFERRED`: reasoning, not observed.
- `UNVERIFIED`: not checked.
- `BLOCKED`: could not be checked; the reason is given.

## Repository and process

| Item | Expected | Observed | Label |
| --- | --- | --- | --- |
| PR #81 | merged as `2bed7cd` | merged 17 Nov 11:20 UTC; `origin/main` = `2bed7cd` | VERIFIED_REPOSITORY |
| CI on `main` | — | `2bed7cd` run 44074764945 succeeded | VERIFIED_REPOSITORY |
| Open PRs | — | none | VERIFIED_REPOSITORY |
| Unmerged branches | — | about 40 historic feature/docs branches, all older than #81; none carries AURUM work | VERIFIED_REPOSITORY |
| PR #81 post-fix safety review | outstanding | **closed in this session**: APPROVE WITH NOTES, 9/9 prior findings fixed or documented, 5 new LOW/INFO findings. Disposition is in [`STATUS.md`](STATUS.md) | VERIFIED_TEST |
| `.claude/protected-edits.unlock` | — | present before this work (see HANDOVER). Not used; no protected path was edited | VERIFIED_REPOSITORY |
| Local Docker / PostgreSQL | — | Docker daemon not running; no `psql` or `pg_dump` on the host | BLOCKED (no disposable database here) |

## Production (not re-read)

| Item | Expected | Recorded | Label |
| --- | --- | --- | --- |
| Deployed commit | `bed2f36` | `bed2f36`. #81 is not deployed | RECORDED_PRODUCTION |
| `primary` equity / HWM / drawdown | about $7,061 / $10,106 / 30.13% | 7,061.31 / 10,106.00 / 30.13%; every new BUY fails `TOTAL_DRAWDOWN_LIMIT` | RECORDED_PRODUCTION; the latch effect is INFERRED from `packages/risk-engine/src/evaluate.ts` |
| Database size and growth | about 13 GB, +750 MB/day | 13 GB; AgentDecision 7.6 GB, MarketObservation 3.8 GB, CyclePlan 1.1 GB, OpportunityFunnelEvent 0.7 GB; 49 GB free on disk | RECORDED_PRODUCTION |
| OANDA practice | configured; XAU available | XAU_USD REAL_TIME / DEALER_INDICATIVE, two-sided, tradeable; spread about 1.2 bps (6 Nov) | RECORDED_PRODUCTION |
| Research campaigns and GENESIS shadow | disabled | off: 0 campaigns, 0 shadow predictions | RECORDED_PRODUCTION |
| Prior gold research | no validated edge | hourly and daily XAU studies NO_SKILL (`docs/horizon/LEDGER.md`, checkpoints 3–4) | VERIFIED_REPOSITORY (as documented) |
| XAU datasets | stale | OANDA 1h/1d end 5–6 Nov 2026 | RECORDED_PRODUCTION |
| Trial accounting | discrepancy | 2,454 `ResearchTrial` rows; 2,170 was the `campaign-cli trials` programme count; `ResearchTrialLedger` empty; questionnaire in `docs/integrity/F03-F06-RESEARCH-INTEGRITY.md` §45 unanswered | RECORDED_PRODUCTION |

Re-reading production needs operator approval (global rule: ask before ssh). The read-only check AURUM needs next is in [`STORAGE-PLAN.md`](STORAGE-PLAN.md) §5.

## Architecture facts that drive AURUM (VERIFIED_REPOSITORY)

1. **Spot, long-only, USD book.**
   - `Position` holds `baseQty` and `avgCostUsd` with no direction or margin, and is unique on `(accountId, pairAddress)`.
   - `Fill` is USD-only (`priceUsd`, `notionalUsd`, `currency` default "USD").
   - `PaperAccount` is `cashUsd`.
   - Money is 8 dp `Decimal(24,8)` (`packages/shared/prisma/schema.prisma:30-480`).
   - A SELL is ambiguous between closing a long and opening a short. Spread betting cannot be layered on this without a new position model.
2. **Isolation is per trading environment, not per account.**
   - `accountIdForEnvironment` maps `MARKET_DATA_PAPER` to `primary` and other environments to `primary:<env>` (`packages/shared/src/environments.ts:43`).
   - `EngineControl` is a singleton `primary` holding the one risk/strategy config (`schema.prisma:18`; read with `id: "primary"` in `apps/worker/src/stage-runner.ts:215,708,1794` and `apps/worker/src/executor/settle.ts:19`).
   - `loadPinnedExecutionContext` only accepts account ids beginning `primary` (`packages/shared/src/execution-context.ts:105`).
   - **A second concurrent paper account with its own risk config, daily-loss state and HWM does not exist today.** Orders, fills, positions, ledger, equity snapshots, funnel events and safety states do carry `accountId`, so the row-level partitioning is reusable.
3. **XAU is registered** as `commodity:XAUUSD`, `COMMODITY_PROXY`, `PAPER_SPOT`, session `METALS_ENERGY_CFD`, provider `commodity_stub` (`packages/shared/src/instruments.ts:253-267`). The gateway routes commodities to no provider; OANDA is reached only by the probe and the held-mark refresh.
4. **No retention exists in code** for the four high-growth tables (grep: no retention module before this branch).

## Verification in this session (VERIFIED_TEST)

| Check | Result |
| --- | --- |
| `pnpm test` (local Windows) | 196 files passed, 2 failed, 6 skipped; **1,414 tests passed, 34 skipped, 0 failed**. The 2 failing files are the restore-drill `.mjs` import failures, which are environmental and also fail on the recorded baseline |
| `pnpm typecheck` | pass |
| `pnpm exec eslint` on the changed paths | clean |
| `pnpm build:packages` | pass |
| DB integration suite, browser e2e | not run: no PostgreSQL or Redis on this host |
