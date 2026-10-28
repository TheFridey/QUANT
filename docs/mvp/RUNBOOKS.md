# QUANT MVP — Operator Runbooks

## First session walkthrough

1. Copy `.env.example` → `.env`; start Postgres + Redis; `pnpm install && pnpm db:deploy && pnpm build:packages`.
2. Start API + worker + web (`pnpm --filter @odin/api dev`, worker, web).
3. Open `/terminal`. Confirm **Execution = PAPER**, venue PAPER, LIVE refused without dual flags + broker.
4. Ensure `multiMarketPaperIngest` / `allowDemoPaperEntries` are true (defaults). Start engine.
5. Wait for a cycle: Solana LIVE (if DexScreener up) plus DEMO FX/ETF/commodity stubs appear on tape.
6. Risk panel shows execution mode, funnel counts, open durable alerts, why-blocked diagnostics.
7. Promote a reviewed strategy via `/evolution/promote` (OPERATOR only). Worker `loadPlan` reads `engine.activeStrategy` → `activeStrategyId`; fills stamp `id@version+src:…+art:…`.
8. Never set `EXECUTION_MODE=LIVE` expecting fills — MVP refuses live broker submission.

## Reconcile / entry suspension

- Worker executor runs paper self-truth reconcile each cycle.
- Set `ODIN_RECONCILE_FAULT=1` only in tests/labs to inject unknown exposure → durable `ENTRIES_SUSPENDED` alert → new entries blocked.
- Clear fault env and let a clean cycle resolve (`acked=true`) those alerts.
- Manual ack: `POST /terminal/alerts/:id/ack` (admin).

## LIVE gate

- Default PAPER. LIVE requires `LIVE_MONEY_ENABLED=true` and `LIVE_MONEY_CONFIRM=I_UNDERSTAND_LIVE_RISK` **and** still refuses because no live broker adapter exists (C40 stays BLOCKED_EXTERNAL).

## External demo

- Without `EXTERNAL_DEMO_API_KEY` (or equivalent), external demo adapter remains BLOCKED_EXTERNAL. Do not mark success from fixtures.
