# ASCEND-00: safety and trade autopsy

Baseline: `main` at `a5a4674` (1 Nov 2026), also the commit deployed on the VPS. Code-level findings are from reading the source and running tests. Production findings come from read-only queries against the VPS database on 1 Nov 2026 at ~11:00Z, with the operator's approval. The queries are in [`forensics/2026-11-01-queries.sql`](forensics/2026-11-01-queries.sql).

## 1. Daily-loss lockout (priority zero)

### Reported incident

The account reached about $9,679.11 (−3.21% of $10,000) against `maxDailyLossPct = 3`. `CIRCUIT_BREAKER` rejections were observed, and then an operator resumed the engine.

### How the gate works (observed in code)

- **Start-of-day equity.** `rollSessionEquity` (`packages/shared/src/session-equity.ts`) rolls `PaperAccount.sessionStartEquityUsd` at Europe/London midnight (BST/GMT aware), and never rolls while equity is unknown. The worker persists the roll in `apps/worker/src/stage-runner.ts` (around line 766).
- **Daily P&L.** Daily P&L is current mark-to-market equity minus the persisted start-of-day equity. It is `null` (entries blocked, `DAILY_PNL_UNAVAILABLE`) unless the valuation is `LIVE` or `CASH_ONLY`.
- **Breaker.** `evaluateCircuitBreaker` (`packages/risk-engine/src/evaluate.ts`) is evaluated once per cycle in `planCycle` (`packages/agent-core/src/plan.ts:101`). `evaluateRisk` rejects every `BUY` while it is open. It also rechecks `DAILY_LOSS_LIMIT` against the in-cycle P&L, which includes losses realised earlier in the same cycle.
- **BUY paths.** All of them go through `riskFor` → `evaluateRisk` with `circuitBreakerOpen`:
  - legacy pulse entries (`plan.ts:230`)
  - operator tickets (the API's `submitOrder` only queues an operator cycle; `terminal.service.ts:1351`)
  - strategy-instance entries (`plan.ts:451`)
- **Resume.** `engine/resume` (`terminal.service.ts`, `act`) writes only `EngineControl.status` and `flattenRequested`. It does not touch `sessionStartEquityUsd`, `highWaterMarkUsd` or any risk input.

### Required properties

| # | Property | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Start-of-day equity uses the Europe/London day | Holds | `session-equity.test.ts`; `daily-loss-lockout.test.ts` (BST case at 23:30Z) |
| 2 | Admission checks the gate for every BUY | Holds within a cycle. The breaker is computed once from the cycle's frozen inputs, and each BUY is rechecked against in-cycle realised P&L | `daily-loss-lockout.test.ts` |
| 3 | Operator resume cannot nullify the threshold | Holds: resume changes no risk input | Code reading of `act`; `daily-loss-lockout.test.ts` "after an operator resume" |
| 4 | Worker restart cannot reset it | Holds: state lives in `PaperAccount`, and the roll is a pure function of it | `daily-loss-lockout.test.ts` "unchanged by a restart" |
| 5 | Config reload cannot reset it | Holds for reloads. An operator can still **raise** `maxDailyLossPct` (bounds 0.1–100) through a strategy PATCH while paused; that is an explicit, audited operator action, not a bypass | `daily-loss-lockout.test.ts` "config reload"; `strategy.ts` bounds |
| 6 | A new strategy instance cannot bypass it | Holds | `daily-loss-lockout.test.ts` "strategy instance created after the breach" |
| 7 | Entries stay blocked until the lockout legitimately expires | Holds since the F1 fix (branch `fix/ascend-00-daily-loss-latch`). Before it, a same-day recovery re-admitted entries | `daily-loss-lockout.test.ts` "F1"; `apps/worker/src/daily-loss-latch.integration.test.ts` |
| 8 | Exits and protective actions stay possible | Holds | `daily-loss-lockout.test.ts` "stop-loss exit" |

**Evidence:**
- `VERIFIED_UNIT`: `pnpm vitest run packages/agent-core/src/daily-loss-lockout.test.ts` passes 14 tests. They run the real planner and risk engine on the incident's numbers.
- `VERIFIED_INTEGRATION` (locally, Postgres 16): `apps/worker/src/daily-loss-latch.integration.test.ts` runs full `StageRunner` cycles. It covers the latch holding across fresh runners (a worker restart), a no-breach control, and the London roll lifting the latch. CI passed on PR #21 (`test`, `browser-e2e`, `build-packages`).

**Deployment (1 Nov 2026):**
- Merged as `982c045` and deployed at 13:11 UTC, after a verified database backup (`/srv/quant/backups/quant-20261101T131037Z.dump`) and a build snapshot of `a5a4674` in `/srv/quant/releases/`.
- After the deploy, the migration was applied, all services were active, health was `ok`, cycles completed with no failures, and `sessionLowEquityUsd` was populated ($9,581.94 against the $9,679.11 day start, so the latch was inactive).

### Findings

**F1: the lockout was a level check, not a latch (fixed, operator-approved 1 Nov 2026).** The gate was recomputed from live equity every cycle, so a recovery from −3.21% to −2.90% within the same London day re-admitted entries.

The fix:
- **Storage:** `PaperAccount.sessionLowEquityUsd` (migration `20261101120000_session_low_equity`) holds the lowest equity seen this Europe/London day. It ratchets down each cycle in `rollSessionEquity` and resets on the roll.
- **Gate:** `evaluateRisk` and `evaluateCircuitBreaker` take `worstDailyPnlUsd` (session low − start of day) and reject BUYs once it reaches the limit. Exits are unaffected.
- **Backfill:** the migration fills the column from today's `LIVE`/`CASH_ONLY` equity snapshots, so a breach earlier on the deploy day is not forgotten.
- **Trade-off:** a brief mark-to-market dip to −3% now locks entries for the rest of the day. That is the intended conservative behaviour.

**Production confirms no bypass (31 Oct 2026, all times UTC = London GMT):**
- 15:59:40: the last entry, HALLOWTRUMP ($493.51), was admitted at equity $9,734.94 (daily P&L −2.65%, so $34.94 of headroom remained).
- 16:00:01: its protective exit filled at a −8.30% mid move, realising −$55.84. Equity went to $9,679.11 (−3.21%).
- 16:00:00 to 23:14:20: 171 entry intents were rejected with `CIRCUIT_BREAKER`.
- 16:07:45 and 16:12:51: two config revisions. The second raised the liquidity floor from $25k to $250k (inferred; see section 2).
- 16:15:21: resume (`claude-code (operator request: resume entries)`). Rejections continued after it.
- 23:14 to 00:00: no entry intents arrived, so nothing was rejected.
- No `BUY` order of any status exists between 16:00:01 and 00:07:40 on 1 Nov, which is the first cycle of the next London day. The session rolled at 00:00 to $9,679.11.

**F2: an entry can carry more loss than the remaining daily headroom.** The overshoot was not a bypass. The planner admits an entry whenever daily P&L is above −3%, even when that position's plausible stop-out loss exceeds the headroom left. Here the headroom was $34.94; the expected stop loss alone was ~$15 (3% stop) plus ~$17 of round-trip costs, and the realised gap was $55.84. **Fixed (operator-approved 1 Nov 2026).**
- **Headroom:** `dailyLossHeadroomUsd` (risk-engine) is the limit plus current in-cycle daily P&L, floored at 0, and 0 once latched.
- **Cap:** `maxEntryNotional` caps entries at headroom ÷ (stopLossPct + (feeBps + maxSlippageBps) + (feeBps + maxExitImpactBps)). Under defaults that divisor is 15.1%.
- **Replay:** on the HALLOWTRUMP entry, $34.94 of headroom caps the notional at $231.39 instead of $493.51.
- **Minimum order:** when the cap falls below `minOrderNotionalUsd`, the entry is rejected (`MIN_ORDER_EXCEEDS_RISK_CAP`); it is never rounded up. An operator BUY above the cap is rejected (`SIZE_ABOVE_CAP`).
- **Limit of the fix:** no gap allowance is added, because none can be justified from the data. A gap through the stop can still overshoot, and the F1 latch then stops any further entries that day.

**Safety review (`quant-safety-reviewer`, 1 Nov 2026): APPROVE WITH NOTES.** Nothing loosens risk. Notes 1, 2 and 4 were fixed on the same branch:

1. **Headroom was per trade, not portfolio.** Several entries in one cycle, or entries alongside open positions, could each use the full headroom. Now `openStopRiskUsd` (risk-engine) is subtracted from headroom before every entry. It sums, over the simulated book including entries admitted earlier in the cycle, the fall from mark to stop plus exit costs.
2. **The session low ratcheted on non-LIVE marks.** Now `rollSessionEquity` takes `equityTrusted`, and the worker passes true only for `LIVE`/`CASH_ONLY` valuations, matching the backfill.
3. **The API display can differ from the worker** when marks are missing at the London boundary. Display only; not changed.
4. **The low was a read-modify-write.** Within a day the worker now writes it with `LEAST(...)` in SQL, so a concurrent writer cannot raise it. A roll still sets it directly.
5. **Informational:** the latch sees executor-stage losses at the next cycle's valuation. SANDBOX orders admitted before a breach still submit (F3, open).

**Re-review of those fixes: APPROVE WITH NOTES.** Everything remaining errs towards blocking. Two notes were fixed:

- **Entry costs of same-cycle entries.** Headroom now uses the lower of in-cycle realised daily P&L and (simulated book equity − start of day). The book carries the entry costs of entries admitted earlier in the cycle.
- **Roll race.** The `LEAST` write is scoped to the current session, comparing `sessionStartedAt` as zone-free UTC text, so a stale writer cannot carry yesterday's low into today.

Left as is:

- **Fallback to cost when a mark is missing.** Unreachable on the BUY path, because a missing mark makes the valuation `INCOMPLETE`, which rejects every entry.
- **OCO stop at entry price, not average cost.** About 0.01% of notional.
- **Long-only assumption in `openStopRiskUsd`.** Holds today; add a guard if shorts are ever introduced.

**F3: BUYs admitted before a breach could fill after it (fixed, PR #24).** A `SANDBOX` (Alpaca practice) order admitted before a breach was still submitted by `apps/worker/src/sandbox-execution.ts` afterwards. Market-data paper fills settle in the same cycle, so this affected only the sandbox venue.

The fix: before first submission, `sandboxEntryBlock` cancels a `PRE_SUBMIT` BUY when the engine is not running, entries are paused, the day is unrolled, or the breaker is open on the latest trusted snapshot or the persisted latch. The update is fenced on PENDING + PRE_SUBMIT. `UNKNOWN` orders, which may already be at the broker, are left to sync.

## 2. Production forensics

### Ledger as of 1 Nov 2026 ~11:00Z

There are 27 closed round trips, not the 15 in the brief: 12 more GATO trades happened on 1 Nov. Every position is flat. Cash and equity are $9,597.26, a realised −$402.74 (−4.03%) on $10,000. The high-water mark is $10,106.00, so the drawdown is 5.03%, against a 10% limit. All entries came from `stratinst_primary_crypto` (`pulse-momentum-v1`).

### Loss decomposition (`VERIFIED_HISTORICAL` from the ledger)

Mid prices are reconstructed as fill price ÷ (1 ± recorded `slippageBps`).

| Slice | Trips | Wins | Net P&L | Mid-to-mid move | Slippage | Fees | Cost per trip, % of notional |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 31 Oct, pools < $250k liquidity | 14 | 4 | −$301.77 | −$88.48 | $177.20 | $36.09 | 3.47% |
| 31 Oct, GATO ($260k) | 1 | 0 | −$19.12 | −$12.12 | $4.03 | $2.97 | 1.39% |
| 1 Nov, GATO only | 12 | 2 | −$81.84 | −$1.55 | $45.73 | $34.56 | 1.39% |
| **All** | **27** | **6** | **−$402.74** | **−$102.15** | **$226.96** | **$73.62** | |

**Execution costs caused about 75% of the realised loss ($300.58 of $402.74).** On 1 Nov the signal's mid-to-mid result was essentially zero (−$1.55 over 12 trades), and the whole −$81.84 was cost. That sample is far too small to measure the signal's edge (`INSUFFICIENT_EVIDENCE`). It does show the edge would need to beat a ~1.4% round-trip hurdle even in a $250k pool, and ~3.5% in a $55k pool.

### Attribution by the brief's categories

| Category | Evidence | Finding |
| --- | --- | --- |
| 2. Buying after excessive momentum | The 14 thin-pool entries on 31 Oct had h1 change of +35% to +1,318% (median ~880%), m5 up to +113%, and token age 0.2–19 h (SIS, whitepaper and HALLOWTRUMP were under 1 h old) | **Yes, systematically on 31 Oct.** The strategy bought freshly launched tokens mid-pump. The floor was then $25k, and `maxEntryM5ChangePct` was evidently high enough to admit +113% (`whitepaper`) |
| 3/4. Thin liquidity, spread and impact | ~$440 entries in $47–71k pools paid 123–174 bps of slippage each way, against `maxSlippageBps` 150. Entries that would have exceeded it were rejected (9 `SLIPPAGE_LIMIT`, all thin-pool BUYs between 15:45 and 15:57) | **Dominant cost driver.** $177 of slippage on $6.1k of thin-pool turnover |
| 8. Failed or delayed protection | A 3% stop and 5% target sat inside the 20-second observation step. Protective exits filled at mid moves of −34.70%, −15.02%, −12.17% and −12.06% (stops) and +36.45%, +28.47% and +16.39% (targets). Ten of the 15 trips on 31 Oct closed on the first or second observation after entry | **Not a protection failure, a cadence and volatility mismatch.** Protection fired on the next observation each time. Brackets narrower than one-step volatility turn each trade into a symmetric gamble taxed by ~3.5% of cost |
| 1. Wrong signal | Thin-pool mid moves sum to −$88 across 14 trips, with a huge spread (−35% to +36%). GATO on 1 Nov: −$1.55 across 12 trips | `INSUFFICIENT_EVIDENCE` for a directional edge either way |
| 5. Slow execution | Decision-to-fill latency was not recorded separately; fills settle in the planning cycle at the decision observation | `INSUFFICIENT_EVIDENCE` (not recorded) |
| 6. Adverse regime / 9. Correlated exposure | Up to 2 concurrent positions (peak exposure $974 at 15:51:21); no SOL/BTC regime data was recorded | `INSUFFICIENT_EVIDENCE` |
| 7. Premature exit | The GATO `STRATEGY` exits on 1 Nov had small MFE (≤ +5.6%); the deep-pool MAE was ≤ −2.6% | No evidence of premature exit outside the noise |
| 10. Bad data | DexScreener prices are consistent with the fills; security was PASS (`solana_rpc`) on every entry | None found |

### Config at the time of the losses

No history of engine config is stored: `EngineControl` keeps only the current config and `updatedBy`, and `CyclePlan` does not snapshot the config. The liquidity floor in force per `configRevision` was inferred from Sentinel's own decisions:

| Revision | Floor |
| --- | --- |
| 12:34:45 | $25k |
| 15:44:01 | $25k (the first trade came 19 s later) |
| 16:07:45 | $25k |
| 16:12:51 | $250k |
| 16:15:21 (resume, current) | $250k |

What else changed at 15:44:01 cannot be reconstructed. **F6: config changes, including risk-limit changes, were not audited (fixed, PR #25).** A Postgres trigger now appends an `EngineConfigRevision` on every config insert or change: previous and new config, changed keys, actor, hash, and `engineUpdatedAt`. That last field matches `CycleRun.configRevision`. Rows are append-only. History before the deploy is not recoverable: the migration records the current config as a `BASELINE`.

### `SELL_EXCEEDS_POSITION` (20 rejections, not 14)

Each one pairs one-for-one with one of the 20 PROTECTION exit fills: same cycle, same quantity, `ownerScope = NET_CLOSE`. The worker's protection step (`apps/worker/src/executor/protect.ts`) and the planner's stop/target exit (`plan.ts`, NET_CLOSE identity) both close the position in the same cycle. The protection fill settles first, and the store's guard (`packages/trading-engine/src/store.ts:663`) rejects the second close.
- **Impact:** harmless to the ledger, with no double sell.
- **Weakness:** two exit intents are produced, and rejected orders inflate the order count.
- **Actual mechanism (from order timestamps):** the NET_CLOSE was created first, as `PENDING` (paper latency). Protection then filled the whole position in the same transaction, and the next cycle's settle rejected the pending sell.
- **Fixed (F5, PR #23):** settle now cancels a pending SELL on a flat position with `EXIT_SUPERSEDED` and releases its reservations. Protection is unchanged.
- **Known residual (pre-existing):** a pending exit is not fenced by position lifecycle, so it could in principle reduce a reopened lot. The planner's pending-net-close guard makes this unlikely; fencing by `lifecycleId` is a follow-up.

### Slippage-limit rejections (9)

All were automatic `ENTRY` BUYs on 31 Oct between 15:45 and 15:57, in BNB, whitepaper, SIS and HALLOWTRUMP ($55–70k pools). The cost gate worked as designed. Each rejection was followed by a fill in the same pool within a minute or two at 140–150 bps, just inside the cap. The fills that got through did so by barely clearing the limit.

### What this means for the research programme

1. No strategy should trade where the estimated round-trip cost (2 × impact + 2 × fee) exceeds the expected gross move. That is the brief's "expected net edge" gate (ASCEND-06), and the data here shows it is the first-order problem.
2. Stop and target distances must be set relative to volatility per observation step, not as fixed percentages.
3. GATO-type deep pools with a 2–7% m5 trigger showed no gross edge across 12 trips. This should become a registered hypothesis with a pre-declared sample size, not a tuning target.

## 3. Permanent trade autopsy (PR #26)

`packages/analytics/src/trade-autopsy.ts` implements the section 2 decomposition as pure, tested functions. `GET /api/terminal/autopsy` serves it.

Run read-only against the production ledger, it reproduces the forensic totals for the 27 trips: net −$402.74, fees $73.62, slippage $226.93, mid move −$102.18. Small differences come from it using observed mids instead of reconstructions. Flags are factual only, and unrecorded inputs are listed in `notRecorded`.
