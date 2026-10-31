# AGENTS.md

ODIN // QUANT: Solana research terminal and paper-trading system. pnpm monorepo (`apps/api` NestJS on 4318, `apps/web` Next.js on 4317, `apps/worker` BullMQ jobs; `packages/*` shared libraries). PostgreSQL 16 + Redis 7 via `docker compose`. Prisma lives in `packages/shared`. Read `docs/ARCHITECTURE.md` before cross-package changes; current status (audit findings and evidence) is in `docs/STATUS.md`; operations in `docs/RUNBOOKS.md`; superseded plans and decision logs are in `docs/archive/`.

This is safety-critical financial software. These rules override convenience.

## Execution and risk boundaries (require explicit operator approval)

- Live money is refused unless `LIVE_MONEY_ENABLED=true` **and** `LIVE_MONEY_CONFIRM=I_UNDERSTAND_LIVE_RISK` (`packages/shared/src/execution-gate.ts`). Never set, weaken, bypass or default those, and never change `EXECUTION_MODE` away from `PAPER` in env files, CI or code defaults.
- Do not add real-venue order submission, wallet/private-key handling or transaction signing. Practice/sandbox venues (`packages/market-data/src/*venue*`, `*broker*`, `execution-*`) stay non-live.
- Do not loosen risk limits or their defaults (`DEFAULT_STRATEGY` in `packages/shared/src/strategy.ts` is authoritative; the README's figures may lag it) or add bypasses, including operator-override paths and config-healing on load.
- Research proposals and backtests never auto-apply to a RUNNING engine or auto-promote (`packages/evolution/src/promotion.ts`).
- Ledger is the source of truth: missing marks are not zero P&L; stale/missing prices block new risk; no look-ahead in replay/backtests.

High-risk paths: `packages/risk-engine/**`, `packages/trading-engine/**`, `packages/shared/src/execution-gate.ts`, `packages/shared/src/strategy.ts`, `packages/market-data/src/` venue/broker/execution files, `packages/evolution/src/promotion.ts`, `.github/workflows/**`. Changes there need tests and an independent safety review before being reported done.

## Commands (repo root)

```bash
pnpm install
pnpm build:packages   # tsc -b
pnpm test             # vitest run; DB test only when DATABASE_URL_TEST names an *odin_test* database
pnpm typecheck
pnpm lint
```

Targeted tests: `pnpm vitest run packages/<pkg>/src/<file>.test.ts`. CI (`.github/workflows/ci.yml`) runs install → db:deploy → test → typecheck → lint → build, then Playwright e2e, with `EXECUTION_MODE=PAPER`.

## Conventions

- Never read or print `.env` values; use `.env.example` for shape. Never commit keys.
- Do not edit generated Prisma output (`packages/shared/src/generated`).
- Keep diffs focused; tests alongside changed rules. Report exact test commands and results.
