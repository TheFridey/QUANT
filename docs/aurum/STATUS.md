# AURUM status and execution ledger

This document also serves as EXECUTION-LEDGER.

## Deploy and activation: `f4d8b99`, legacy crypto RETIRED (18 Nov 2026)

Operator instruction: "merge, deploy and activate" (D3). Production storage was the driver: D14 measured about 2.5 GB of disk a day, with about 17–18 days left. The plan followed was `docs/aurum/D3-RETIREMENT-ACTIVATION-PLAN.md`.

| Step | Result (observed) |
| --- | --- |
| PR [#84](https://github.com/TheFridey/QUANT/pull/84) CI, run 44312617178 | test, build-packages and browser-e2e pass; 240 files, **1,672 passed, 1 skipped**, including all 4 retirement DB integration tests |
| Merge | `f4d8b99` (merge commit; branch cut from the `main` tip, so the tested tree is the merged tree) |
| Preflight, read-only | production `aec2a80`, clean checkout; api, worker, web, postgresql and redis active; `/api/health` ok; 44 GB free. The worker loads `/srv/quant/app/repo/.env` via systemd `EnvironmentFile`, and its unit does not set `LEGACY_CRYPTO_MODE` |
| Zero-obligation check | open positions, non-terminal orders, unresolved protection intents, live protection legs, open recovery cases, held reservations and running campaign units: **all 0**. Money: `primary` cash 7,061.30912073, HWM 10,106.00207701, session start and low 7,061.30912073, config md5 `5ff22766…` |
| The 600 "in-flight" trade intents | **inert historical rows, not obligations.** 221 ADMITTED and 379 DEFERRED, the newest from 16 Nov 07:21. 324 have terminal orders (131 cancelled, 20 rejected, 173 filled); 209 SELLs have no order and no position; 67 ADMITTED BUYs never produced an order. No code reads TradeIntent back to create or settle orders (only the API capacity view and the history loader). The preflight check was over-broad and is now narrowed |
| Backup | `quant-backup.service` gave `quant-20261118T133349Z.dump` (2.08 GB, `pg_restore --list` verified); 42 GB free |
| Deploy | fast-forward `aec2a80` → `f4d8b99` (13 files: worker source, docs, `.env.example`); `pnpm install --frozen-lockfile` and env-sourced `pnpm build` succeed; `db:deploy` reports "No pending migrations". The built worker contains `legacy-retirement.js`. **Worker restarted only**; API and web were not restarted (code unchanged) |
| ACTIVE smoke | worker logs `legacy crypto active`; 5 cycles COMPLETE in 90 s; 120 Solana observations; 0 worker error lines; money and config md5 identical |
| Activation | `.env` backed up to `.env.bak-20261118T150653Z`. Appended `LEGACY_CRYPTO_MODE=RETIRED`, the only key touched; it appears exactly once. Worker restarted at 15:06:53 UTC |
| Verification | worker logs `legacy crypto retired: discovery off, new entries paused`, with no unrecognised-value warning. Up to 15:15 UTC: **26 cycles COMPLETE, 0 with error; 0 market observations; 0 orders**; 2 decision rows per cycle (EXECUTOR and ARCHIVIST PASS), against about 120 per cycle before. Cash, HWM, session equity, config md5 and stored `pauseNewEntries` (false) are unchanged. 0 worker error lines; `/api/health` ok |

**Expected effect** (derived; measure after 24 h with `docs/aurum/evidence/d14-production-readonly-20261118.sql`):
- database growth falls from about 0.85 GB/day to about 0.01 GB/day;
- the nightly dump stops growing, and the backup directory levels off at about 29–31 GB.

**Known:** the dashboard reads the stored config, so it still shows new entries as allowed. A manual BUY is refused by the worker (`PAUSE_NEW_ENTRIES`).

**Reversal:** restore `.env.bak-20261118T150653Z`, or set `LEGACY_CRYPTO_MODE=ACTIVE`, then `sudo systemctl restart quant-worker`.
**Code rollback:** check out `aec2a80` and rebuild, or restore snapshot `/srv/quant/releases/aec2a80-20261117T124248Z`, then restart the worker. No database action is needed.

**Not done:**
- 24-hour measurement;
- backup window (D15);
- AgentDecision retention option (D1);
- API visibility of the worker mode.

| | |
| --- | --- |
| **Milestone** | M0 (strategic foundation), first checkpoint |
| **Branch** | `aurum/00-foundation` from `origin/main` `2bed7cd` |
| **Production** | not touched. `bed2f36`, as recorded on 17 Nov |

## Checkpoint 1: 17 Nov 2026

### Done (code is pure, unwired and inactive)

| Change | Files | Tests |
| --- | --- | --- |
| PR #81 post-fix review gap closed, and its LOW findings fixed | `packages/shared/src/quote-admission.ts` (spread cap mandatory; a non-Date `receivedAt` is refused, not thrown), `packages/market-data/src/provider-circuit.ts` (legacy HALF_OPEN with null `halfOpenSince` reopens), `instruments.test.ts` (XAU/WTI session regression) | +3 assertions, +2 tests |
| GOLD_ONLY profile, default-deny | `packages/shared/src/aurum-scope.ts` | `aurum-scope.test.ts` (7 scope tests, 91 negative combinations) |
| Spread-bet maths: quotes, P&L, margin, sizing, gaps | `packages/shared/src/spread-bet.ts` | `spread-bet.test.ts` (21, including a 200-case property test) |
| Position state machine and action validity | `packages/shared/src/spread-bet-lifecycle.ts` | 2 tests in `aurum-scope.test.ts` |
| Retention policy, dry-run SQL, manifest verification, disk pressure | `apps/worker/src/ops/retention-policy.ts`, `retention-dry-run-cli.ts` | `retention-policy.test.ts` (8) |
| Documentation | `docs/aurum/*` | — |

### Verification (local Windows)

| Command | Result |
| --- | --- |
| `pnpm vitest run` on the 6 new or changed test files (after review fixes) | 83 passed |
| `pnpm test` | 196 files passed, 2 failed (restore-drill `.mjs` imports, environmental, also failing at baseline), 6 skipped; **1,414 passed, 34 skipped** |
| `pnpm typecheck` | pass |
| `pnpm exec eslint` on changed paths | clean |
| `pnpm build:packages` | pass |
| DB integration and browser e2e | **not run**: no PostgreSQL or Redis on this host |

### Reviews

| Review | Verdict |
| --- | --- |
| `quant-safety-reviewer`, PR #81 post-fix (`dcb5ae3..7696aeb`) | **APPROVE WITH NOTES.** H1, M2, L6, L8, L9 fixed in code; M3, M4, L-M5 fixed in docs; L7 documented. No protected path changed; nothing wired. New findings and their disposition are below |
| `quant-safety-reviewer`, this branch (pre-fix) | **APPROVE WITH NOTES.** Nothing wired; no protected path changed; 75 tests observed passing. Findings and their disposition are below |
| `quant-safety-reviewer`, this branch (post-fix, `ec1888b..4fbf4ab`) | **APPROVE WITH NOTES.** A1–A7 fixed correctly; no new loosening; no import cycle; still unwired; no protected path touched; 43/43 targeted tests passing. Four new LOW findings, all for the future executor or cosmetic (below) |

**Findings from the post-fix re-review** (all open; for `aurum/01-storage` unless noted):

| # | Finding | Severity |
| --- | --- | --- |
| P1 | `verifyManifest`: `expectedPolicyHash` is optional. The executor must require it | LOW |
| P2 | Duplicate detection is by table:seq only. It misses the same file under another seq and overlapping key ranges | LOW |
| P3 | `validatePolicy` does not force MarketObservation to stay `executorBlocked`. Make the block a hard rule | LOW |
| P4 | `cappedAtMaxStake` is set before the rounding loop and can be true after the loop has already reduced the stake. Cosmetic; fix at PCR C5 | LOW |

**Findings from this branch's review:**

| # | Finding | Severity | Disposition |
| --- | --- | --- | --- |
| A1 | A stop inside the spread understates the loss | MEDIUM | **Fixed**: `sizeStake` takes `closingSide` and refuses `STOP_INSIDE_SPREAD` |
| A2 | An unknown direction was treated as SHORT | LOW | **Fixed**: P&L and sizing return `INVALID_INPUT`; `entryPrice`, `exitPrice` and `stopFillPrice` throw |
| A3 | `actionValidFor` accepted unknown actions | LOW | **Fixed**: `UNKNOWN_ACTION` |
| A4 | The scope did not tie the product to gold; case and whitespace variants of `primary`; null roles threw | LOW | **Fixed**: product registry check, case-folded legacy check, account id pattern, null roles give `INVALID_PROFILE` |
| A5 | The rounded loss estimate could exceed the rounded permitted risk by 1p; `maxStakeGbp` not checked against the increment; an invalid scenario threw | LOW | **Fixed**, with a 300-case property test |
| A6 | Retention would archive observations hashed as research datasets; AgentDecision aged on `createdAt` only | MEDIUM (executor) | **Fixed**: MarketObservation is marked `executorBlocked: RESEARCH_DATASET_WINDOWS_UNMAPPED` and `executablePolicies` excludes it; AgentDecision ages on `GREATEST(createdAt, updatedAt)` |
| A7 | Manifest: a duplicate batch was reported as `HASH_MISMATCH`; no policy-hash check | INFO | **Fixed**: `DUPLICATE_BATCH`, `POLICY_MISMATCH` |
| A8 | The 2% risk-fraction code ceiling is above `DEFAULT_STRATEGY` 0.5% | INFO | **Open, by design**: the PCR C5 wrapper must enforce the configured limit (≤ 0.5%). Check at C5 review |
| A9 | The "flat before funding cut-off" rule is documented, not enforced | INFO | **Open**: PCR C7 |
| A10 | Provenance of `.claude/protected-edits.unlock` | INFO | operator to confirm (D6) |

**New findings from the PR #81 re-review:**

| # | Finding | Severity | Disposition |
| --- | --- | --- | --- |
| N1 | Spread cap optional in code | LOW-MEDIUM | **Fixed**. Test: an absent or null cap gives `INVALID_LIMIT` |
| N2 | Legacy HALF_OPEN record never times out | LOW | **Fixed**, with a test |
| N3 | A stale success can close a HALF_OPEN breaker | LOW | **Open**. Needs a per-probe token; do it when the breaker is wired (aurum/03) |
| N4 | No regression test for the WTI revert | LOW | **Fixed** |
| N5 | A non-Date `receivedAt` throws | INFO | **Fixed**: refused as `RECEIVE_STALE` |

### Not done or blocked

- **Archive/restore executor and disposable-DB proof.** BLOCKED: no PostgreSQL on this host. Next step: a CI `odin_test` integration test (STORAGE-PLAN §4).
- **Gold-only integration proof through the real order path.** Needs PCR-AURUM-01 C1.
- **AURUM account.** Needs the isolation work in PCR C10 (protected) and approval.
- **XAU shadow ingest, warehouse refresh, streaming investigation.** M1; follows retention.
- **Trial reconciliation.** Blocked on the operator questionnaire (`docs/integrity/F03-F06-RESEARCH-INTEGRITY.md` §45). No campaign starts before it is answered.
- **Not yet written** (later milestones, to avoid empty documents): DATA-SOURCES, DATA-INTEGRITY, RISK-MODEL (outline in PCR C9), FEATURE-CATALOGUE, MACRO-INTELLIGENCE, RESEARCH-PROGRAMME, TRIAL-ACCOUNTING, ORACLE, GENESIS, ACCEPTANCE-MATRIX, ROLLOUT-PLAN.

## Operator decisions required

| # | Decision | Evidence | Recommendation | Consequence |
| --- | --- | --- | --- | --- |
| D1 | Approve the retention windows (30/30/30/90 days) and the preservation rules | STORAGE-PLAN §2; about 65 days to a full disk at the recorded rate | approve, subject to the disposable-DB proof | the executor gets built in `aurum/01-storage`; deletion still needs a separate go |
| D2 | Run any GENESIS opportunity-history export older than 30 days before the first archival pass? | `opportunity-loader.ts` reads AgentDecision/CyclePlan | yes, if that window will be studied | otherwise restore from the archive when needed |
| D3 | Stop Solana ingest and crypto strategy scheduling (legacy `primary` latched, 0 open positions) | SCOPE §2 | yes, after AURUM FEED is live | about 103 k fewer rows a day; `primary` stops evaluating; its history is kept |
| D4 | Accept the generic simulation profile (no broker parity) | PRODUCT-SPECIFICATION §1 | accept | every AURUM result is labelled simulation |
| D5 | Approve the proposed AURUM account parameters | SCOPE §3 | approve for design; create only after C3 and C10 | none until creation |
| D6 | Remove the pre-existing `.claude/protected-edits.unlock` now, and recreate it per PCR item | BASELINE: it is present and was not created in this session | remove it | protected edits are blocked again until a scoped unlock |
| D7 | Answer the legacy-trial questionnaire (3 questions) | F03-F06 doc §45 | answer before M4 | unblocks FORGE |
| D8 | Authorise the read-only production dry run over ssh | STORAGE-PLAN §5 | yes, after this branch is deployed | real candidate counts |

## Deploy: `aec2a80` to production (17 Nov 2026, 12:42 UTC)

Operator instruction: "merge everything and push live". PR #82 was merged as `aec2a80` after green CI (run 44083988025: test, build-packages, browser-e2e 14 passed). The release also carries the previously undeployed #81 (`2bed7cd`).

| Step | Result |
| --- | --- |
| Preflight (read-only) | production `bed2f36`, clean checkout; api, worker, web, postgresql and redis active; `/api/health` ok; 0 open positions, 0 pending orders, 0 running research; `primary` cash 7,061.30912073, realised P&L −2,939.04876537; 48 GB free |
| Release content vs `bed2f36` | no migration, no dependency or lockfile change, no protected-path diff |
| PAPER-only env check | **not run by the agent.** The repo hook refuses any command naming those keys. Operator to confirm |
| Restore drill | **not run.** No password role on the VPS; operator chose "deploy, drill later" on 12 Nov |
| Backup | `quant-20261117T123713Z.dump`, 1.95 GB |
| Deploy | fast-forward to `aec2a80`; `pnpm install --frozen-lockfile`; env-sourced `pnpm build`; `db:deploy` reported "No pending migrations"; snapshot `/srv/quant/releases/aec2a80-20261117T124248Z` (68 MB); restarted worker, then api, then web |
| Smoke | `/api/health` degraded immediately after restart, ok within 75 s; `/login` 200; 0 worker error lines; 7 cycles COMPLETE, 1 running |
| Accounting | cash and realised P&L unchanged; 0 orders and 0 promotions since deploy; engine RUNNING, no flatten |
| Live behaviour change | from #81: XAU now uses the narrower `METALS_ENERGY_CFD` session; equity sessions are UNKNOWN outside 2025–2027 (fail-closed). Every AURUM module is unwired |

**Rollback:** there is no `bed2f36` snapshot. Check out `bed2f36`, rebuild, and restart worker, api and web. No database action is needed, because the schema is identical.
