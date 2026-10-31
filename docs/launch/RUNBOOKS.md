# QUANT Launch — Owner Runbooks (stub)

Stub command sheet for Gate A/D handoff. Expand with measured results in `EVIDENCE.md`.

## Scope (D25)

**Single-operator paper/local deployment.** One trusted operator on a private host or VPN.
JWT roles, socket fanout, and in-memory login rate limits are **not** a multi-user authorization product.
Do not expose the stack as a shared multi-tenant service without completing multi-user ownership, proxy-aware shared rate limits, and account-scoped socket rooms.

## Environment

```bash
# Branch / SHA
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD

# Baseline compare
git merge-base HEAD be0923305193cfbf5ccfbf6336663e0b002ca5bf
```

## Local bring-up

```bash
cp .env.example .env   # secrets only; never EXECUTION_MODE=LIVE for fills
pnpm install
pnpm infra:up          # Postgres/Redis on 127.0.0.1 only (see docker-compose.yml)
pnpm db:deploy
pnpm build:packages
pnpm --filter @odin/api dev
pnpm --filter @odin/worker dev
pnpm --filter @odin/web dev
```

Local paper login (`ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env`) is unchanged: `POST /api/auth/login`.
Logout: `POST /api/auth/logout` with `Authorization: Bearer <token>` revokes the JWT server-side (memory + Redis when available). Clearing browser storage alone is insufficient after logout.

### Auth rate limiting (proxy note)

Login attempt limiting is **per-process in-memory** keyed by Express `request.ip`.
It is **not** a shared Redis limiter and is only proxy-aware if the process is configured to trust forwarded headers (not enabled by default). For single-operator loopback use this is acceptable; do not treat it as production multi-replica abuse protection.

Socket origins are restricted to `WEB_ORIGIN` plus local paper defaults (`127.0.0.1:4317` / `localhost:4317`) — not any origin.

## Production bind / network (D26)

- **Compose (this repo):** publish Postgres `5432` and Redis `6379` on `127.0.0.1` only — never `0.0.0.0`.
- **Shared/production host:** prefer **no host port publish**; attach Postgres/Redis to a private Docker/K8s network reachable only by api/worker. Terminate TLS at a reverse proxy; do not expose DB/cache.
- **API and web listen:** both bind `127.0.0.1` by default (`API_HOST`, `WEB_HOST` override). In a container set `API_HOST=0.0.0.0` / `WEB_HOST=0.0.0.0` only behind a private network + reverse proxy. Do not publish raw API/DB ports to the public internet.
- **Secrets off loopback:** when `WEB_ORIGIN` is not a loopback origin the API refuses to start with a `JWT_SECRET` under 32 characters, any published sample secret, or the sample `ADMIN_PASSWORD`, regardless of `NODE_ENV`.
- **Login rate limit behind a proxy:** the limiter keys on `request.ip` and Express `trust proxy` is off, so behind a reverse proxy all clients share the proxy IP (one attacker can lock the operator out for 10 minutes). Enable `trust proxy` only for the exact proxy hop you control; never `true` on an internet-facing listener.
- Development compose credentials (`odin`/`odin`) are for local paper only — replace before any shared deployment.

### ADMIN_PASSWORD rotation limitation

`ensureFoundation` **creates** the admin user when missing; it does **not** update `passwordHash` when `ADMIN_PASSWORD` in env changes.
Changing `.env` alone does **not** rotate an existing seeded admin. Rotation requires an explicit password-update path (DB/hash rewrite or future admin API) — document this before claiming credential rotation is enforced.

## Gate A regression placeholders

```bash
pnpm exec vitest run packages/shared/src/execution-context.test.ts
pnpm exec vitest run packages/shared/src/position-key.test.ts
pnpm exec vitest run packages/shared/src/protection-coverage.test.ts
pnpm exec vitest run packages/shared/src/safety-state.test.ts
pnpm exec vitest run packages/shared/src/observation-origin.test.ts
pnpm exec vitest run packages/trading-engine/src/eligible-observation.test.ts
pnpm exec vitest run packages/risk-engine/src/reservations.test.ts
pnpm exec vitest run apps/api/src/token-revocation.test.ts
```

## Safety / recovery (owner)

```bash
# Inject reconcile fault in lab only — suspends entries; exits remain
# ODIN_RECONCILE_FAULT=1

# Alert ACK does NOT clear ACTIVE safety — clean reconcile required
# POST /terminal/alerts/:id/ack
```

## External demo (blocked without credentials)

```bash
pnpm build:packages
node scripts/verify-external-providers.mjs --provider alpaca_paper
node scripts/verify-external-providers.mjs --provider oanda_practice
```

## Restore / backup

TBD — document before Gate D migrations. Do not delete ambiguous paper history.
Until a tested restore drill exists, treat Postgres volume backups as operator-owned and unproven.
