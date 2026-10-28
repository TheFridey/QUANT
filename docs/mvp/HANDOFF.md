# QUANT MVP — Handoff

## Branch / PR

- Branch: `cursor/quant-mvp-multimarket-5f64`
- Base: `main` @ `0689e33013051816266d8947c1a3340b01828429`
- PR: see GitHub after open

## What changed / works end-to-end (honest)

- **Gate A complete** for the confirmed engine defects: sizing deadlock heal + no round-up, held-position exit monitoring, flatten incomplete survival, latest observation window, pending `eligibleAt`, in-cycle sell capacity release, sessions + FX money helpers, registry FX/ETF/index split.
- **Gate B partial**: order identity columns, session equity fields, trailing/time exits on PULSE, live-money server gate (refuses LIVE), FX stub + external demo boundary (no fake success), activity presets ($10k / 8 pos / 24 universe / $25 min).
- Solana paper path still the primary live ingest; multi-market paper instruments registered; FX quotes are DEMO stub unless fixtures supplied.
- `pnpm test`: **143 passed** / 1 skipped (with local Postgres+Redis+bubblewrap).

## Gate progress

| Gate | Status |
| --- | --- |
| A (01–10) | **DONE** (A03/A04 partial depth) |
| B (11–29) | **PARTIAL** (~half) |
| C (30–43) | **PARTIAL** / mostly NOT_STARTED; C40 BLOCKED_EXTERNAL |
| D (44–58) | **NOT_STARTED** (docs only) |

## Matrix summary counts

DONE 14 · PARTIAL 12 · BLOCKED_EXTERNAL 4 · NOT_STARTED 28 — see `REQUIREMENTS_MATRIX.md`.

## Commands run (this environment)

```bash
sudo apt-get install -y postgresql redis-server bubblewrap
# create role/db odin + odin_test
export DATABASE_URL=postgresql://odin:odin@127.0.0.1:5432/odin
export DATABASE_URL_TEST=postgresql://odin:odin@127.0.0.1:5432/odin_test
export REDIS_URL=redis://127.0.0.1:6379
pnpm install && pnpm db:deploy
DATABASE_URL=$DATABASE_URL_TEST pnpm db:deploy
pnpm build:packages && pnpm test && pnpm typecheck && pnpm lint
# Results: 143 passed, 1 skipped; typecheck/lint clean
```

## Unresolved / external

- Live FX/broker sandbox credentials → `BLOCKED_EXTERNAL` (`EXTERNAL_DEMO_API_KEY`)
- Birdeye / OpenAI optional
- Atomic reservations, OCO, correlation budget, multi-market E2E ≥20 positions, funnel UX, generated-strategy **code** promotion (params only today)
- Daily loss midnight/HWM edge cases still PARTIAL

## Next owner — first session

1. `git fetch && git checkout cursor/quant-mvp-multimarket-5f64`
2. Bring up Postgres/Redis; `pnpm db:deploy`; `pnpm test`
3. Implement B19 atomic reservations + B23 OCO; wire FX/ETF paper into worker ingest alongside Solana
4. Add regression scenarios 12–28 under `packages/**/mvp-regression*.test.ts`
5. Do **not** mark external adapter DONE without a real sandbox ack

## Docs

- `docs/mvp/IMPLEMENTATION_PLAN.md`
- `docs/mvp/REQUIREMENTS_MATRIX.md`
- `docs/mvp/DECISIONS.md`
- `docs/mvp/EVIDENCE.md`
- `docs/mvp/HANDOFF.md` (this file)
