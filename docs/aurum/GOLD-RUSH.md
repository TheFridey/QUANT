# OPERATION GOLD RUSH: programme reconciliation, readiness and approval register

Checkpoint: 18 November 2026. PAPER ONLY. Facts are labelled VERIFIED (observed in this operation, with evidence), RECORDED (from an earlier operation's evidence, not re-checked) or UNVERIFIED.

This is the single authoritative register for AURUM decisions. Other documents keep their history and link here.

## 1. Repository and production baseline

| Item | State | Evidence |
| --- | --- | --- |
| `main` | `f4d8b99` (merge of #84) | VERIFIED `git log origin/main` |
| Production | `f4d8b99`, `LEGACY_CRYPTO_MODE=RETIRED` since 2026-11-18 15:06:53 UTC | VERIFIED during the D3 deploy (STATUS on PR #85's branch) |
| PR #82 AURUM M0 | MERGED, DEPLOYED (`aec2a80`) | VERIFIED |
| PR #84 retirement | MERGED, DEPLOYED, ACTIVATED | VERIFIED: CI run 44312617178, 1,672 passed / 1 skipped |
| PR #85 deploy record | **OPEN**, not merged | VERIFIED `gh pr list` |
| Integration branch | `aurum/gold-rush-integration`: `main` + merge of `aurum/05-titanium-integration` (conflict-free) + COMMAND visibility fix | this operation |

**Branch reconciliation** (all originals preserved):

| Branch | Content | Disposition |
| --- | --- | --- |
| `aurum/01-storage` `34c05f2` | first executor | SUPERSEDED: patch-equivalent copy in `aurum/05` (`git cherry`), then quarantined by the TITANIUM storage review |
| `aurum/03-market-data` `0cc864c` | N3 fence, shadow feed | SUPERSEDED: in `aurum/05`, plus review fixes |
| `aurum/04-product` `a86f4b7` | P4, account config | SUPERSEDED: in `aurum/05`, plus Decimal and margin fixes |
| `aurum/titanium-feed-review` `e544085`, `aurum/titanium-storage-review` `1733ebf` (worktrees `../QUANT-titanium-*`) | TITANIUM review fixes | SUPERSEDED: patch-equivalent in `aurum/05`. The storage worktree holds 5 untracked CLI-evidence paths, left untouched |
| `aurum/05-titanium-integration` `0956a2c` | TITANIUM + CATALYST + D8/D14 docs | integrated into `aurum/gold-rush-integration`; not on `main` |
| `aurum/catalyst-retirement` | retirement only | MERGED (#84) |
| `docs/deploy-f4d8b99` | D3 deploy record, narrowed preflight | PR #85 OPEN |

## 2. Readiness record

Status words: NOT_STARTED, IMPLEMENTED, VERIFIED, REVIEWED, MERGED, DEPLOYED, ACTIVATED, BLOCKED, SUPERSEDED. No percentages.

| Category | Status | Evidence | Blocker or next step |
| --- | --- | --- | --- |
| LEGACY_RETIREMENT | **ACTIVATED** | D3 record; 26 cycles, 0 observations, 0 orders | 24-hour D14 measurement (§4); dashboard visibility fix on the integration branch |
| STORAGE (archive/restore) | IMPLEMENTED, REVIEWED, **BLOCKED** for deletion | TITANIUM-STORAGE-REVIEW; `DELETION_BLOCKED_PENDING_DURABLE_AUDIT` | protected audit schema; D1 policy (AgentDecision has no NO_INTENT rows, D14); D16 off-host destination |
| STORAGE (capacity) | VERIFIED | D14: about 2.5 GB/day before retirement | measure after retirement; D15 backup window |
| MARKET_DATA (feed core, breaker N3, tiers) | IMPLEMENTED, VERIFIED (unit), REVIEWED | FEED.md, TITANIUM-FEED-REVIEW, CATALYST tiers | not wired; persistence needs D11 (protected schema); thresholds D9/D10 need measurement |
| HISTORICAL_WAREHOUSE | existing pipeline DEPLOYED; aggregation IMPLEMENTED | CATALYST-GOLD-DATA §4 | D17 history-depth probe; acquisition approval |
| PRODUCT_MODEL | IMPLEMENTED, VERIFIED, REVIEWED | TITANIUM-PRODUCT-REVIEW (extreme Decimal, configured margin) | D4/D5 approval |
| ACCOUNT_ISOLATION (C10) | design only | TITANIUM-APPROVAL-PACKAGE + CATALYST X1–X10 | D13 |
| EXECUTION (C3, C1–C9) | design only | PCR-AURUM-01, TITANIUM C3 | D12, then per-item approvals |
| RISK | legacy unchanged; AURUM ceilings IMPLEMENTED (pure) | `aurum-account-config.ts` | C10 |
| FEATURES (ATLAS) | NOT_STARTED for gold | — | data first (warehouse) |
| MACRO | NOT_STARTED | — | source licensing review |
| RESEARCH | inventory IMPLEMENTED (doc) | CATALYST-TRIAL-INVENTORY | D18, then D7 declaration; campaigns stay blocked |
| ORACLE / GENESIS | existing GENESIS DEPLOYED, disabled | worker log: "genesis shadow disabled" | research prerequisites |
| COMMAND | readiness API IMPLEMENTED (TITANIUM); retirement visibility IMPLEMENTED (this branch) | §3 | review, CI, merge, deploy |

## 3. Work in this checkpoint

1. **Integration.** Merged `aurum/05-titanium-integration` into current `main`, conflict-free.
   - The retirement files are byte-identical on both sides, so nothing is duplicated.
   - No protected path appears in `git diff origin/main` (risk-engine, trading-engine, execution-gate, strategy, promotion, workflows and Prisma all checked).
2. **COMMAND visibility of retirement.** This fixes the D3 known gap: the dashboard said new entries were allowed while the worker refused them.
   - The parser moved to `@odin/shared` so the API applies the worker's exact rules; the worker module re-exports it.
   - The API snapshot (`execution`, `opsControls`) and the risk hierarchy now report `pauseNewEntries` = stored OR retired, plus `storedPauseNewEntries` and `legacyCryptoMode`. `readConfig` is untouched, so no save path can persist the overlay.
   - The capacity explanation adds "Legacy crypto retired…".
   - `/api/aurum/readiness` adds `legacyCrypto` with `source: API_PROCESS_ENV`.
   - Web:
     - the pause toggle changes only the stored flag;
     - a note explains that retirement keeps entries paused;
     - risk and settings show "yes (legacy retired)".
   - **Limitation:** the API reads its own environment. In production both services are expected to load the repository `.env`; the worker's unit is VERIFIED to, the API's unit is UNVERIFIED and must be checked at deploy. The worker's start-up log remains the authoritative signal.

### Verification of `aurum/gold-rush-integration` (local Windows; disposable PostgreSQL 16 on tmpfs, fsync on)

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile`, `pnpm build:packages` | pass |
| `pnpm typecheck` (all packages and apps) | pass, after a forced rebuild of `@odin/shared` (the incremental build had skipped the moved file) |
| ESLint over `apps` and `packages` | clean. The repo `pnpm lint` (`eslint .`) also walks `.claude/worktrees`, and the guard hook refuses the ignore flag, so the source directories were linted explicitly |
| Full integration project | **36 files / 183 tests pass** |
| Full unit project | **208 files pass, 6 skipped (DB-gated); 1,537 tests pass, 34 skipped, 0 failed** |
| After the review fixes: API unit and integration | 23 files / 124 tests and 7 files / 25 tests pass |
| Browser e2e | **not run locally** (needs the full stack); runs in Linux CI on the PR |

**Review** (`regression-reviewer`, visibility change): APPROVE WITH NOTES.
- No safety regression, no protected path.
- `readConfig` and every save path are untouched.
- The risk hierarchy is display-only.
- Fixed:
  - the e2e toggle test read the effective flag, which would break under a RETIRED API (it now reads the stored flag);
  - the mode is read once per snapshot;
  - snapshot fields now carry `legacyCryptoModeSource: API_PROCESS_ENV` and `legacyCryptoModeIssue`.
- Not fixed:
  - the risk hierarchy labels the pause "Operator pause". That text is in protected `packages/risk-engine` and is left as is.
  - The capacity view may list two suspension entries (operator and retired). Accepted.

## 4. Legacy retirement: 24-hour measurement (PENDING)

The window closes at **2026-11-19 15:06:53 UTC**. The query set is ready: `evidence/d14-production-readonly-20261118.sql` plus `df -h /` and `ls -l /srv/quant/backups`. Running it needs D14-style read-only approval for that date. Results so far are only the first 26 cycles (§2). **No measured post-retirement growth figure exists yet**; the 0.01 GB/day figure is a projection.

## 5. Operator approval register

Categories: APPROVED_DESIGN, APPROVED_IMPLEMENTATION, APPROVED_DEPLOYMENT, APPROVED_ACTIVATION, APPROVED_DESTRUCTIVE_OPERATION. One category never implies another.

| # | Decision | Status | Scope granted | Not granted | Evidence |
| --- | --- | --- | --- | --- | --- |
| D1 | Retention windows 30/30/30/90 | OPEN | — | any archive or delete | STORAGE-PLAN; D14 shows the AgentDecision rule archives about nothing |
| D2 | GENESIS history export before archival | OPEN | — | — | STORAGE-PLAN |
| D3 | Legacy crypto retirement | **APPROVED_DEPLOYMENT + APPROVED_ACTIVATION** (18 Nov, "merge, deploy and activate") | merge #84, deploy `f4d8b99`, set `LEGACY_CRYPTO_MODE=RETIRED`, restart the worker | deletion of any history; changing stored config | STATUS deploy record (#85) |
| D4 | Generic spread-bet profile, no broker parity | OPEN (recommended) | — | — | PRODUCT-SPECIFICATION |
| D5 | AURUM account parameters | OPEN | — | account creation | SCOPE §3; proposal hash in TITANIUM-APPROVAL-PACKAGE |
| D6 | Pre-existing unlock file provenance and removal | OPEN | — | any protected edit | BASELINE |
| D7 | Historical trial declaration (proposed 2,684) | OPEN | — | running `declare-legacy-trials` | CATALYST-TRIAL-INVENTORY |
| D8 | Read-only production SQL/metadata (trial and dataset package) | **APPROVED, executed once** (18 Nov) | the D8 query set | writes, ssh changes | D8-PRODUCTION-READONLY |
| D9 | Reference spread thresholds | OPEN | — | adopting 10 bps | CATALYST-GOLD-DATA §5: measure first |
| D10 | Quote freshness thresholds | OPEN | — | adopting 5 s | same |
| D11 | Shadow quote persistence and resource budget (protected schema) | OPEN | — | schema change | FEED.md, TITANIUM package |
| D12 | C3 implementation | OPEN | — | protected edits | TITANIUM C3 + CATALYST X1–X10 |
| D13 | C10 implementation | OPEN | — | protected edits | same |
| D14 | Post-retirement storage measurement | **APPROVED, executed** (18 Nov, pre-retirement inspection) | that inspection | the 24-hour re-measurement is a new read-only run | D14-PRODUCTION-STORAGE |
| D15 | Backup window / off-host dumps | OPEN | — | — | D14 |
| D16 | Archive destination: separate storage | OPEN | — | — | CATALYST-STORAGE |
| D17 | OANDA earliest-history probe (about 8 requests) | OPEN | — | — | CATALYST-GOLD-DATA §2 |
| D18 | Read-only count of pre-registry research rows | OPEN | — | — | CATALYST-TRIAL-INVENTORY |

## 6. Dependency graph (workstreams)

```text
GR-01 integration ──► GR-10 COMMAND ──► deploy (D-approval)
GR-11 storage verify (24 h) ──► D15/D16 ──► D1 ──► protected audit schema ──► archive
GR-02 feed ──► D11 schema ──► persistent shadow ──► D9/D10 measurement ──► thresholds
GR-03 warehouse ──► D17 probe ──► M1 acquisition ──► GR-08 ATLAS features ──► GR-09 MACRO (context only)
GR-04 trials ──► D18 ──► D7 declaration ──► research campaigns (G6)
GR-06 C10 ──► GR-05 C3 ──► GR-07 C1–C9 execution ──► G4/G5
```

Independent now, without approvals: GR-01, GR-10, the GR-08 feature-definition scaffolding on existing hourly and daily data, and GR-09 source review.

## 7. Proposed sequence

- **Merge:**
  1. PR #85 (docs);
  2. the integration PR, after Linux CI and review;
  3. later, protected PRs one by one (C10, then C3), each with its own approval.
- **Deploy:** the integration PR, as worker + API + web.
  - It carries the Next 16.4.5 patch and the portable build, so the build must be checked on the VPS.
  - API and web restarts are needed this time.
- **Activation:** nothing new is activated by the integration PR. The shadow feed, persistence, the account and execution each need their own activation decision.
