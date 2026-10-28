# QUANT MVP — Evidence Log

Baseline HEAD at inspection: `0689e33013051816266d8947c1a3340b01828429` (matches review SHA).
Branch: `cursor/quant-mvp-multimarket-5f64`

## Credential inventory (names only)

| Variable | Present locally | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes (from `.env.example` copy) | local Postgres |
| `REDIS_URL` | yes | local Redis |
| `JWT_SECRET` / `ADMIN_*` | sample defaults | not production |
| `BIRDEYE_API_KEY` | empty | security UNKNOWN path |
| `OPENAI_API_KEY` / `HERMES_*` | empty | mock LLM |
| External broker / FX sandbox keys | absent | `BLOCKED_EXTERNAL` |

No secret values printed. Do not purchase, fund, or place real-money trades.

## Baseline commands

```text
pnpm install          # ok
pnpm build:packages   # ok
pnpm test             # 111 passed / 3 failed / 13 skipped (pre-change)
```

Pre-change failures (environment, not trading-logic regressions):
- `packages/evolution/src/sandbox-probe.test.ts` — `bwrap` missing (`ENOENT`)
- `packages/evolution/src/oracle-cycle.test.ts` — requires bubblewrap isolation
- `packages/evolution/src/acceptance.test.ts` — report null when sandbox unavailable

## Defect verification (HEAD `0689e33`)

| # | Claim | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | Paper-only Solana spot; indices RESEARCH_ONLY/NO_EXECUTION; FX absent | **CONFIRMED** | `docs/ARCHITECTURE.md` L1–7; `packages/shared/src/instruments.ts` SEED_INSTRUMENTS (only `PAPER_SPOT` is Solana universe; indices `RESEARCH_ONLY`/`NO_EXECUTION`); no FX asset class |
| 2 | Defaults $100 / 4 pos / 12 pairs / 5% / $5 min; ceilings 10/30 | **CONFIRMED** | `packages/shared/src/strategy.ts` DEFAULT_STRATEGY + schema refine `maxPositions<=10`, `universeLimit<=30` |
| 3 | $5 cap = $5 min deadlock; never round up through risk | **CONFIRMED** | `maxEntryNotional` caps at 5% equity; `plan.ts` `sizeOrder` rejects `BELOW_MIN_NOTIONAL` when `notional < minOrder`; no round-up path exists, but defaults leave zero headroom after fees |
| 4 | Candidates from ingest only; held outside discovery get marks without exit eval; flatten cleared with holdings | **CONFIRMED** | `stage-runner.ts` `loadPlan` builds `pairs` only from `ingestJobId=cycleId`; held marks loaded separately but never added to `pairs`; `executor` clears `flattenRequested` unconditionally after commit loop |
| 5 | `loadObservationHistory` asc take:40 keeps earliest | **CONFIRMED** | `stage-runner.ts` L361–365 `orderBy: { receivedAt: "asc" }, take: 40` |
| 6 | plan computes future `eligibleAt`; store fills with `eligibleAt=input.now` | **CONFIRMED** | `plan.ts` L369–392; `store.ts` L103–118 creates `FILLED` with `eligibleAt: input.now`; `CommitOrder` type omits eligibility fields |
| 7 | Planner adds buy exposure without subtracting completed sells | **CONFIRMED** | `plan.ts` L174–176 only increments on BUY |
| 8 | Backtest trailing/time exits absent from PULSE path | **CONFIRMED** | `backtest/engine.ts` uses `trailingStopPct`/`maxHoldingMs`; `pulse.ts` held exits = stop/TP/m5 fade only |
| 9 | Discovery = DexScreener boosted + SOL by liquidity | **CONFIRMED** | `market-data/dexscreener.ts` `fetchSolanaUniverse` boosts URL + WSOL mint |
| 10 | PULSE long-only Solana momentum rules | **CONFIRMED** | `pulse.ts` L149–168; `isTradableQuote` Solana mints in `market.ts` |
| 11 | Promoted strategies vs hard-coded PULSE | **PARTIAL** | Worker loads `engine.config` / `activeStrategy` into `parseStrategyConfig` (params can change thresholds); entry/exit **logic** remains hard-coded `runPulse` — promotion does not swap decision code |
| 12 | Daily loss = today realised + lifetime unrealised vs session equity; starting balance denom | **CONFIRMED** | `stage-runner.ts` L297–316 sums day `REALIZED_PNL` + current unrealised; `evaluate.ts` denominates by `startingBalanceUsd` |
| 13 | AEGIS REVIEW/BLOCK entry-blocking; UNKNOWN honest | **CONFIRMED** | `aegis.ts` `blocksEntry` for BUY+BLOCK/REVIEW; UNKNOWN ≠ PASS; does not hard-block paper entry |
| 14 | Green CI ≠ trading scenarios work | **CONFIRMED** | CI can pass unit tests while multi-market E2E / fault scenarios absent; sandbox tests fail locally without bwrap |

## Validation after Gate A/B/C continuation

```text
pnpm build:packages   # ok
pnpm typecheck        # ok
pnpm lint             # ok
pnpm test             # 163 passed / 1 skipped
```

Added: reservations, protection/OCO, correlation, reconcile, session-equity, strategy-library, funnel, paper-multimarket ingest, multi-market.e2e.

Migrations: `20261028220000_mvp_order_identity_session`, `20261028230000_mvp_reservations_funnel_alerts`.

See REQUIREMENTS_MATRIX.md for status counts.
