# APEX baseline

Factual state of QUANT at the start of Operation APEX, established on 2 Nov 2026 by inspecting the code, Git, CI and the existing status documents. It does not restate those documents: [`../STATUS.md`](../STATUS.md) (audit remediation), [`../ascend/STATUS.md`](../ascend/STATUS.md) and [`../ascend/singularity/README.md`](../ascend/singularity/README.md) remain canonical for what they cover. Where this file disagrees with them, this file records what the code showed.

Labels: as in [`../ascend/README.md`](../ascend/README.md), plus `NOT_VERIFIED` (could not be checked from this session) and `BLOCKED_APPROVAL`.

## Baseline commit

- `main` = `c3b23e9` (merge of PR #43, 1 Nov 2026 21:05 UTC). Working branch `ccr-e2adef27-cgrrwj` started from it.
- No open pull requests at start (GitHub API, 2 Nov 2026).
- CI on `c3b23e9`: `success`, run [41350184608](https://github.com/TheFridey/QUANT/actions/runs/41350184608). The four previous `main` runs were also green except one cancelled (superseded by a later push).

## Architecture (unchanged by APEX so far)

pnpm monorepo: `apps/api` (NestJS 11, port 4318), `apps/web` (Next.js 16.4.3, React 19.2, port 4317), `apps/worker` (BullMQ 5 jobs), `packages/{shared, market-data, risk-engine, trading-engine, agent-core, analytics, backtest, evolution}`. PostgreSQL 16 + Redis 7. Prisma 6.19.3 in `packages/shared`; Zod 4.6.7; decimal.js 10.6.0 for money. Details in [`../ARCHITECTURE.md`](../ARCHITECTURE.md).

Source size (non-test `.ts`, excluding generated Prisma): agent-core 4.8k lines, analytics 0.7k, backtest 4.2k, evolution 6.4k, market-data 6.0k, risk-engine 1.5k, shared 3.8k, trading-engine 4.0k, api 6.3k, worker 4.7k, web 0.9k (`.ts` only; most UI is `.tsx`).

## Test and CI status (executed in this session, local container)

| Check | Command | Result |
| --- | --- | --- |
| Unit + integration | `pnpm test` with local Postgres 16 / Redis 7, `DATABASE_URL_TEST=…/odin_test` | 153 files passed, 4 skipped; **822 tests passed, 25 skipped**; 63.7 s |
| Skipped | sandbox isolation tests (`sandbox-memory`, `-forgery`, `-adversary`, `-lookahead`, parts of `forge`, `router`, `acceptance`, `oracle-cycle`, `sandbox-probe`) | Skipped with reason: no bubblewrap in this container. They are `VERIFIED_CI` (Linux CI has bubblewrap) |
| Integration subset | 21 `*.integration.test.ts` files incl. 8 s engine soak | passed |
| Typecheck | `pnpm typecheck` | exit 0 |
| Lint | `pnpm lint` | exit 0 |
| Dependency audit | `pnpm audit --prod` | "No known vulnerabilities found" |
| Browser e2e / a11y | Playwright | `NOT_VERIFIED` locally (CI runs it; green on `c3b23e9`) |

## Database and migrations

25 Prisma migrations, latest `20261101190000_research_registry`. All applied cleanly to empty `odin` and `odin_test` databases in this container. 14 non-internal triggers enforce immutability or append-only behaviour (`CyclePlan`, `EngineConfigRevision`, `EngineControl` revision hook, `ExperimentReport` evidence, `ForwardPaperResult`, `HistoricalBar`, `HistoricalRawBatch`, `LifecycleAudit`, `PromotionApproval`, `ResearchHoldoutAccess`, `ResearchRun`, `ResearchTrial`, `StrategyArtifact`, `StrategyPromotion`). The `HistoricalBar` trigger was observed rejecting a `DELETE` in this session.

## Deployment topology (from repository documents only)

Per [`../ascend/STATUS.md`](../ascend/STATUS.md): a VPS with the checkout at `/srv/quant/app/repo`, backups at `/srv/quant/backups/*.dump` (`quant-backup.service`), build snapshots at `/srv/quant/releases/`, public access behind HTTP Basic Auth, and other ScaleSmiths sites on the same host. Last recorded deploy: `d2d1526` (1 Nov 2026 ~20:57 UTC). `c3b23e9` differs from `d2d1526` only in documentation.

**Everything about the live VPS is `NOT_VERIFIED` from this session**: there are no SSH credentials in the container and no attached computer, so processes, ports, TLS, Redis/Postgres health, backup schedule, retention, encryption, log retention and the running commit could not be inspected.

## Workstream classification at baseline

| Workstream | Classification | Basis |
| --- | --- | --- |
| ASCEND-00 lifecycle safety (daily-loss latch, headroom sizing, duplicate NET_CLOSE, sandbox BUY after breach, config audit, autopsy) | Implemented and verified | `VERIFIED_UNIT`/`VERIFIED_INTEGRATION`, production `VERIFIED_HISTORICAL` per ASCEND status; tests pass here |
| ASCEND-00 pending-exit lifecycle fencing | Missing | Confirmed in code: `Order` has no lifecycle column, so a pending reduce cannot be fenced to the lot it was created for. Needs a migration and a `trading-engine` change: `BLOCKED_APPROVAL` |
| ASCEND-00 chunked-exit modelling bias | Implemented but defective (documented) | Remainders re-quote against fresh liquidity (ARCHITECTURE "Known bias"): `BLOCKED_APPROVAL` |
| ASCEND-00 editable stop/target, protection amendments | Missing | No amend endpoint; needs protected paths: `BLOCKED_APPROVAL` |
| ASCEND-00 financial arithmetic | Implemented and verified (unit/integration) | decimal.js, 8 dp; property-based tests do not exist yet |
| ASCEND-01 historical warehouse | Implemented, partially verified | SOL/USDC, GATO, 4 speculative pools, SPY in production. FX history, corporate actions and an inactive-token cohort missing (`BLOCKED_EXTERNAL` / not started) |
| ASCEND-02 strategy library | Implemented and verified (historical) | 8 candidates + 3 controls; **no strategy validated** on any dataset |
| ASCEND-03 validation | Implemented and verified | Walk-forward, embargo, holdout once per instrument across versions, PSR/DSR (programme-wide), PBO |
| ASCEND-04 regimes | Implemented, partially verified | `regime-det-1.1.0`. Limitations: liquidity always UNKNOWN; exchange holidays count as gaps (documented); no persisted regime history |
| ASCEND-05 ML | Implemented, partially verified | SOL/USDC `NO_SKILL`; GATO/SPY `INSUFFICIENT_EVIDENCE`; no model-registry table |
| ASCEND-06 execution costs | Implemented, partially verified | Validates the predictor against the paper simulator, not a real venue |
| ASCEND-07 portfolio | **Missing** | No portfolio analytics or allocation research in code |
| ASCEND-08 ORACLE | **Implemented but defective** | `packages/evolution` has a bounded cycle, queue limits and lifecycle; budget and autonomy defects D-01 to D-03 below |
| ASCEND-09 trade memory | Partially implemented | `TradeMemory` with post-exit exclusion exists; no structured feedback loop |
| ASCEND-10 command centre | Partially implemented | Terminal and research tabs exist; no regime, portfolio or research-registry views |
| ASCEND-11 production validation | Partially implemented | CI gates exist; no consolidated release gate; production checks `NOT_VERIFIED` here |

## Defects found at baseline

| ID | Severity | Defect | Status |
| --- | --- | --- | --- |
| D-01 | High (budget control ineffective) | `EvolutionService.runPipeline` built a `ModelRouter` per request with an empty in-memory budget store, so each request could spend the full research cap again; Model Ops always showed $0 spent against the default $5, not the operator's cap | Fixed in `238399d` |
| D-02 | Medium | `FileBudgetStore` treated an unreadable or corrupt spend file as zero spend (fail-open) and wrote non-atomically | Fixed in `238399d` |
| D-03 | Medium | `assertActionAllowed` fell through to "Permitted" for unlisted (level, action) pairs: level 2 could forge code and run backtests with no approval gate, and level 4 (the disabled real-money level) was treated as most permissive. `mutate_risk_limits` was allowed whenever the operator-settable `allowRiskLimitMutation` flag was on, which is an operator-override path for risk limits contrary to `AGENTS.md`. No current caller exercised the risk path | Fixed in `238399d` |
| D-04 | Low | Protected-path guard false positives: a shell write whose text merely mentions a protected filename (for example in a code comment) is refused. That is the guard working as designed (fail closed); recorded so future sessions use the Edit/Write tools for non-protected files | Not a defect to fix; do not weaken |

## Pending protected changes

See [`PROTECTED_CHANGE_REQUESTS.md`](PROTECTED_CHANGE_REQUESTS.md). None was attempted; all need the operator-created unlock and, for schema changes, a production migration approval.

## Baseline limitations

- No live VPS access: production health, deployment and backup claims are `NOT_VERIFIED`.
- No bubblewrap in this container: sandbox isolation evidence relies on CI.
- Outbound network is restricted by the session policy: GeckoTerminal was refused (`connect_rejected`), so no new historical data could be fetched and no real-data research run was possible here.
