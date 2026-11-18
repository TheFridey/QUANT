# AURUM status and execution ledger

## CATALYST — 18 November 2026 (current checkpoint)

Branch `aurum/05-titanium-integration`, from `add6e68`. PAPER only. Production unchanged: `aec2a80` (D8).

**Production read-only facts (D8):**
- the registry gap is reconciled (2,454 = 2,170 counted + 284 TEST);
- the database is 14 GB and the disk has 44 GB free;
- the database is under a seventh of the 102 GB used, so the rest of the disk is unmeasured.

Details: [D8-PRODUCTION-READONLY.md](D8-PRODUCTION-READONLY.md).

**Implemented (inactive unless noted):**
- **Legacy crypto retirement** (`LEGACY_CRYPTO_MODE`, default ACTIVE).
  - RETIRED stops Solana discovery and forces `pauseNewEntries` at read time only: in the plan, the config, PAPER settle and the SANDBOX outbox.
  - Held marks, exits, protection and history are unchanged.
  - Empty retired cycles are not errors and write no permanent REJECT row.
  - The mode is logged at worker start, and a typo logs a warning.
  - **Not activated.** See [CATALYST-STORAGE-AND-RETIREMENT.md](CATALYST-STORAGE-AND-RETIREMENT.md).
- **Gold quote quality tiers and spread statistics** (`gold-quote-tiers.ts`):
  - four tiers, with no default thresholds and validated ordering;
  - spread statistics in points, bps and £ per stake, and by New York hour.
- **Deterministic M1 → higher-timeframe aggregation** (`history/aggregate.ts`), exact decimals.
- **Documents:**
  - trial inventory: [CATALYST-TRIAL-INVENTORY.md](CATALYST-TRIAL-INVENTORY.md);
  - gold data plan: [CATALYST-GOLD-DATA.md](CATALYST-GOLD-DATA.md);
  - C3/C10 challenge: [CATALYST-C3-C10-CHALLENGE.md](CATALYST-C3-C10-CHALLENGE.md).

**Verification (local Windows; disposable PostgreSQL 16 on Docker tmpfs, fsync on, `127.0.0.1:55437/odin_test`):**

| Check | Result |
| --- | --- |
| Integration project (full) | **36 files / 183 tests pass**, including 4 new retirement tests and the GENESIS registry test |
| Retirement and nearest suites (cycle-plan, paper-lifecycle, daily-loss-latch, stage-runner, release1-executor, lifecycle-fence) after review fixes | pass |
| New unit tests | retirement 7, SANDBOX retirement block 1, quote tiers 5, aggregation 5: all pass |
| Full unit project, final code, `--maxWorkers=2` | **207 files pass, 6 skipped (DB-gated); 1,534 tests pass, 34 skipped, 0 failed**. An earlier run under heavier load had 1 transient Nest boot hook timeout in an untouched API test |
| Combined | 1,534 unit + 183 integration = **1,717 passing** (TITANIUM: 1,707) |
| `pnpm --filter @odin/worker typecheck`, market-data `tsc --noEmit` | pass |
| eslint on the 14 changed files | clean |
| Docker disk-volume run (before tmpfs) | timeouts at 60 s in 3 tests including 2 unchanged suites: environmental I/O, as TITANIUM found |

**Review:** `quant-safety-reviewer` on the retirement change gave APPROVE WITH NOTES.
- Fixed: 1 (SANDBOX outbox ignored retirement), 2 (typo never reported), 4 (retired cycles shown as errors) and 5 (no exit-while-retired test).
- Documented: 3 (the API shows the stored config) and 6 (demo and replay modes are unaffected).
- A test host without `legacy` crashed settle; it was found by the integration run and fixed by making the field optional, which keeps today's behaviour.

**Decisions needed:**

| # | Decision | Recommendation |
| --- | --- | --- |
| D3 | Activate `LEGACY_CRYPTO_MODE=RETIRED` after a fresh zero-obligation check | yes, after code review and deploy approval |
| D14 | Read-only disk, backup and growth inspection | yes, now |
| D15 | Backup dump retention | after D14 |
| D16 | Archive to separate storage | yes, required for real relief |
| D17 | OANDA earliest-history probe (about 8 requests, read-only) | yes |
| D18 | Read-only count of pre-registry `BacktestRun`/`ExperimentReport` rows | yes, before declaring |
| D7 | Legacy trial declaration: **2,684**, programme rule, an upper bound with reruns included | approve after D18 |
| D12 / D13 | C3 / C10 with the CATALYST amendments X1–X10 | approve scope; protected implementation follows |

## TITANIUM — 17 November 2026

Earlier records below are preserved. Current starting SHAs and classifications: [TAKEOVER-TITANIUM.md](TAKEOVER-TITANIUM.md). Command evidence: [TITANIUM-REGRESSION.md](TITANIUM-REGRESSION.md) and [EXECUTION-LEDGER.md](EXECUTION-LEDGER.md).

- IMPLEMENTED, INACTIVE: bounded financial domains and configured-margin correction; feed generation/reset fencing, provenance/state isolation and cancellable transport; authenticated read-only readiness contract. No account created.
- Storage independent review found high-severity defects. Deletion remains disabled, real allowlist empty; restore confined to disposable local databases. Production archive/delete/restore acceptance is not established.
- VERIFIED_TEST: historical PR #82 CI independently confirmed: 1,663 pass, one skip, 238 files, 177 integration tests and 14 browser tests. These do not prove the new combined branch.
- VERIFIED_TEST, combined local branch: 1,707 pass / 25 skip, 241 files pass / four skip; integration project 35 files / 179 tests (two no-resource quarantine tests). Portable packages/API/worker/web build, typecheck, scoped lint and zero-advisory production audit pass. Final browser run at 3b79f71: 14/14 pass (3.5m). Exact checkpoint and limits: [TITANIUM-REPORT.md](TITANIUM-REPORT.md).
- BLOCKED_APPROVAL: durable retention audit/transaction protocol, quote persistence, C3 and C10. Exact scopes: [TITANIUM-APPROVAL-PACKAGE.md](TITANIUM-APPROVAL-PACKAGE.md), [FEED.md](FEED.md), [TITANIUM-STORAGE-REVIEW.md](TITANIUM-STORAGE-REVIEW.md).
- BLOCKED_RESEARCH: historical reconciliation and holdout authority. Exact operator read-only SQL and counting semantics: [TITANIUM-TRIALS-AND-DATA.md](TITANIUM-TRIALS-AND-DATA.md). No subtraction-based declaration accepted.
- UNVERIFIED production: reported deployment, current obligations/balances, provider entitlement, storage growth, dataset coverage/hashes. No production inspection authorised or performed.
- NOT ACTIVATED: feed, campaigns, account, retirement flags, execution, retention or deletion. No push, PR, main merge or deployment authorised.

Existing unlock is unused. Original branches, legacy history and losses preserved. Authorised local verification is complete; full platform acceptance remains blocked by protected implementation and operator evidence. Windows skips, tmpfs durability limits and native SWC ACL refusal remain explicit.

This document also serves as EXECUTION-LEDGER.

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
| D8 | Authorise the read-only production dry run over ssh | STORAGE-PLAN §5 | yes, after this branch is deployed | real candidate counts. **Approved 18 Nov; metadata inspection done, see [D8-PRODUCTION-READONLY.md](D8-PRODUCTION-READONLY.md). Retention candidate dry run not run** |

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
