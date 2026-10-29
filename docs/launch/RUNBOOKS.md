# QUANT Launch — Owner Runbooks (stub)

Stub command sheet for Gate A/D handoff. Expand with measured results in `EVIDENCE.md`.

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
pnpm db:deploy
pnpm build:packages
pnpm --filter @odin/api dev
pnpm --filter @odin/worker dev
pnpm --filter @odin/web dev
```

## Gate A regression placeholders

```bash
pnpm exec vitest run packages/shared/src/execution-context.test.ts
pnpm exec vitest run packages/shared/src/position-key.test.ts
pnpm exec vitest run packages/shared/src/protection-coverage.test.ts
pnpm exec vitest run packages/shared/src/safety-state.test.ts
pnpm exec vitest run packages/shared/src/observation-origin.test.ts
pnpm exec vitest run packages/trading-engine/src/eligible-observation.test.ts
pnpm exec vitest run packages/risk-engine/src/reservations.test.ts
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
