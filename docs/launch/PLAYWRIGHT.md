# Playwright — Gate 1 browser smoke

Specs live under `apps/web/e2e/`. Config: `apps/web/playwright.config.ts` (baseURL `http://127.0.0.1:4317`).

## Prerequisites

1. Postgres + Redis up (this VM: apt packages; elsewhere `pnpm infra:up`)
2. `DATABASE_URL` / `REDIS_URL` set; `pnpm db:deploy`
3. Apps running: `pnpm dev` (api `:4318`, web `:4317`, worker)

## Commands

```bash
cd apps/web
pnpm exec playwright install chromium   # once
pnpm exec playwright test               # all e2e
pnpm exec playwright test e2e/login.spec.ts e2e/operator-desk.spec.ts
```

These are **smoke** tests (login gate / paper-only copy / operator desk text). They are **not** full paper lifecycle E2E and must not be labelled VERIFIED_E2E for trading until flows cover entry→fill→protection against a live stack.

**This release run:** Playwright was **not** executed against a running api+web stack. Prefer `apps/worker` paper-lifecycle + engine-soak ITs for trading path evidence until browser E2E is green.
