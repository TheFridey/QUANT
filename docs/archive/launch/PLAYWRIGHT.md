# Playwright — Gate 1 browser E2E (local paper)

Specs live under `apps/web/e2e/`. Config: `apps/web/playwright.config.ts` (baseURL `http://127.0.0.1:4317`, traces/screenshots/video **retain-on-failure**).

## Prerequisites

1. Postgres + Redis up (this VM: apt packages; elsewhere `pnpm infra:up`)
2. Isolated DB recommended: `odin_e2e` with `DATABASE_URL=postgresql://odin:odin@127.0.0.1:5432/odin_e2e`
3. `DATABASE_URL` / `REDIS_URL` / `JWT_SECRET` / `ADMIN_PASSWORD` set (see `.env.example`); `pnpm db:deploy`
4. Apps running: api `:4318`, web `:4317`, worker (`pnpm --filter @odin/api --filter @odin/worker --filter @odin/web dev`)
5. `cd apps/web && pnpm exec playwright install chromium` (once)

## Commands

```bash
cd apps/web
pnpm exec playwright test               # all e2e (serial, 1 worker)
pnpm exec playwright test e2e/paper-mvp.spec.ts
```

## Coverage (`e2e/paper-mvp.spec.ts` + smokes)

| Flow | Assertion style |
| --- | --- |
| Login / logout | UI + URL |
| Start local paper / pause / resume | Command-bar UI → snapshot `engine.status` |
| Market selector enable/disable | UI toggle round-trip |
| Strategy budget / config save | PATCH while paused → snapshot `engine.config` |
| Dirty draft vs polling | Unsaved Max positions survives ≥6s refresh |
| Ops pause-new-entries | Toggle while RUNNING → `opsControls.pauseNewEntries` |
| Signal / rejection reasons | Overview + Risk + snapshot `whyNoTrades` / `whyBlocked` |
| Preview / submit paper BUY | Est. qty/fees UI; new FILLED order id; cash drop; open position |
| Protection view | Positions shows PROTECTED (or equivalent) |
| Reduce / close | Positions Close → position gone / SELL FILLED |
| Alert ack | Seeded `DurableAlert` + Risk panel **ACK** button (notification-only; ACK≠clear safety) |
| History filters | Side/symbol Apply |
| Disconnect / reconnect | Settings socket row down→connected via offline |
| Mobile nav | Viewport 390×844 group tabs → Ticket |
| Keyboard | Focus enabled Pause/Resume/Sign out |

Smokes: `login.spec.ts`, `operator-desk.spec.ts`, `command-centre.spec.ts`.

## This release run (2026-10-29)

| Item | Value |
| --- | --- |
| Stack | api+worker+web against **`odin_e2e`**, `EXECUTION_MODE=PAPER`, `LIVE_MONEY_ENABLED=false` |
| Result | **8 passed / 0 failed** (~24s) |
| Label | **`VERIFIED_E2E` for Gate 1 local paper browser paths listed above** |
| Artifacts | On failure: `apps/web/test-results/` (trace/screenshot/video; gitignored). Green run: `apps/web/test-results/.last-run.json` |
| HTML report | `apps/web/playwright-report/` (gitignored) |

### Gaps (honest)

- Manual BUY needs workable risk knobs (`minOrderNotionalUsd` / `maxRiskPerTradePct`); helpers tune these while PAUSED before ticket submit.
- External practice / LIVE / real-money routing **not** exercised (and must not be).
- Snapshot-cost / browser latency SLO **not** claimed here.
- CI browser job uses `ODIN_MARKET_FEED=deterministic` (PAPER-only, no public market egress).

Do **not** treat helper vitest ITs alone as browser E2E. Prefer this Playwright suite against a live stack for Gate 1 UI proof.
