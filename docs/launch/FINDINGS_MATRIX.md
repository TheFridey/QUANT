# QUANT Launch — Findings Matrix (D01–D30)

**Baseline:** `4adca801e4592ddb5cdcce107b2751b33bc5ba0c` (main tip after PR #4)  
**Branch:** `cursor/quant-paper-mvp-gate1-7ed8`  
**Verification levels:** implementation ≠ verification. VERIFIED_* only when evidence recorded.  
See also `docs/launch/IMPLEMENTATION_STATUS.md` for Gate 1 programme status.

| ID | Severity | Status | Package / call-site paths | Regression command | Verification |
| --- | --- | --- | --- | --- | --- |
| D01 | P0 | IMPLEMENTED | `execution-context.ts` pin/load; `CycleRun.pinnedContext`; `stage-runner` ingest/executor/loadPlan | `pnpm exec vitest run packages/shared/src/execution-context.test.ts` | VERIFIED_UNIT (resolve/pin helpers) |
| D02 | P0 | IMPLEMENTED | Worker history env filter; lab loadObservations env; terminal snapshot marks; protection mark env | eligible-observation + observation-origin + terminal paths | VERIFIED_UNIT (partial) |
| D03 | P0 | IMPLEMENTED | `eligible-observation.ts` bounds, preferIngestJobId, no null-env; `store.ts` passes now/expiresAt | `pnpm exec vitest run packages/trading-engine/src/eligible-observation.test.ts` | VERIFIED_UNIT |
| D04 | P0 | IMPLEMENTED | `reconstructBudget` open+HELD; consume zeros remainders; pending qty≠USD; slots=total capacity | `pnpm exec vitest run packages/risk-engine/src/reservations.test.ts packages/risk-engine/src/reconstruct-budget.test.ts` | VERIFIED_UNIT |
| D05 | P0 | IMPLEMENTED | `ENTRY_BLOCKING_SAFETY_CODES` includes PROTECTION_RECOVERY; `isEntriesSuspended` uses them | `pnpm exec vitest run packages/shared/src/safety-state.test.ts` | VERIFIED_UNIT |
| D06 | P0 | IMPLEMENTED | `position-key.ts`; exact coverage match; desired-only native not protected; worker/terminal decode | `pnpm exec vitest run packages/shared/src/position-key.test.ts packages/shared/src/protection-coverage.test.ts` | VERIFIED_UNIT |
| D07 | P0 | IMPLEMENTED | Account-scoped retry; AMEND≠EXIT; lifecycle fence; kind/lifecycle columns; account lock on retry | protection-crash (needs DB) + lifecycle API | — (needs VERIFIED_DB) |
| D08 | P1 | IMPLEMENTED | `held-refresh.ts` route/fairness/deadline; worker observe starts mandatory before awaiting discovery | `pnpm exec vitest run packages/market-data/src/held-refresh.test.ts` | VERIFIED_UNIT |
| D09 | P1 | IMPLEMENTED | `execution-gateway.ts` + worker SANDBOX refuses local PAPER booking (stub NOT_IMPLEMENTED / MISSING_CREDENTIALS) | `pnpm exec vitest run packages/market-data/src/execution-gateway.test.ts` | VERIFIED_UNIT (stub; full demo lifecycle still open) |
| D10 | P1 | IMPLEMENTED | `practice-url.ts` exact HTTPS allowlists; alpaca/oanda readiness + quote completeness | `pnpm exec vitest run packages/market-data/src/practice-url.test.ts` | VERIFIED_UNIT |
| D11 | P1 | IMPLEMENTED | Attributed ENTER/EXIT maps (`concurrentEntryByPair`); empty gating ≠ ungated PULSE; moduleRef binding; pause-preserving init; Order/Fill/Position `strategyInstanceId` + StrategyAllocation | `pnpm exec vitest run packages/agent-core/src/attributed-intents.test.ts packages/agent-core/src/strategy-binding.test.ts packages/agent-core/src/strategy-instances.test.ts packages/agent-core/src/pulse-exits.test.ts` | VERIFIED_UNIT |
| D12 | P1 | IMPLEMENTED | `pulse.ts` promoted HOLD falls through to stop/target/time exits when held | `pnpm exec vitest run packages/agent-core/src/pulse-exits.test.ts` | VERIFIED_UNIT (exits; product accounting still OPEN) |
| D13 | P1 | IMPLEMENTED | `promotion.ts` evidenceFromExperimentReport; `evolution.service` promote resolves reportId server-side, refuses missing | `pnpm exec vitest run packages/evolution/src/promotion.test.ts apps/api/src/promote-paper.test.ts` | VERIFIED_UNIT |
| D14 | P1 | IMPLEMENTED | `terminal.service` portfolio.analyticsWindows labels (sample scopes explicit; not single calendar) | snapshot payload | VERIFIED_UNIT (labels; full ledger redesign OPEN) |
| D15 | P1 | IMPLEMENTED | `market-admission.ts` + stage-runner loadPlan MarketSelection map; plan blocks ENTRY, exits/monitoring remain | `pnpm exec vitest run packages/agent-core/src/market-admission.test.ts packages/agent-core/src/pulse-exits.test.ts` | VERIFIED_UNIT |
| D16 | P1 | IMPLEMENTED | `updateConfig` operational-only while RUNNING; resume keeps incomplete flatten; PAUSED OPERATOR sell; strategy-section ops | `pnpm exec vitest run apps/api/src/ops-controls.test.ts packages/risk-engine/src/operating-controls.test.ts packages/shared/src/strategy.test.ts` | VERIFIED_UNIT |
| D17 | P1 | IMPLEMENTED | Strategy form dirty drafts keyed by `engine.updatedAt`; conflict banner + discard | strategy-section | — |
| D18 | P1 | IMPLEMENTED | Socket≠market pills; coalesce/abort refresh; stale revision ignore; connect_error; persist refreshMs | snapshot-context / command-bar | — |
| D19 | P1 | IMPLEMENTED | `clientIntentId` + async `submitOrder` receipt; `/orders/receipt`; ticket preview qty/stop/fees/budget | `apps/api/src/ops-controls.test.ts` + trading-section | VERIFIED_UNIT (receipt/idempotency) |
| D20 | P1 | IMPLEMENTED | Positions surface `protectionStatus`/`recoveryNeeded`; exception queue; row reduce-only close | positions-section | — |
| D21 | P1 | IMPLEMENTED | Terminal snapshot env-scoped marks; provenance freshness; exact position keys | observation-origin + position-key | VERIFIED_UNIT (helpers) |
| D22 | P2 | IMPLEMENTED | `GET /terminal/history` kind/side/symbol/offset; snapshot `historyMeta`; History UI order vs trade + keyboard Open detail (no CSV yet) | `pnpm --filter @odin/web typecheck` | — |
| D23 | P2 | IMPLEMENTED | `ReadinessChecklist` on Overview/Settings — infra/providers/risk with MISSING_CREDENTIALS vs NOT_IMPLEMENTED; links Settings + RUNBOOKS (not full wizard) | web readiness-checklist | — |
| D24 | P2 | IMPLEMENTED | `sections.ts` NAV_GROUPS Desk/Markets/Orders & Positions/Strategies/Research/Operations; mobile group+module strip (not 22 flat) | web sections + sidebar | — |
| D25 | P1 | IMPLEMENTED | Single-operator scope docs; logout+JWT revoke (memory/Redis); socket origin from env; JWT revalidate on socket; proxy rate-limit note | `pnpm exec vitest run apps/api/src/token-revocation.test.ts` | VERIFIED_UNIT (partial; account rooms / multi-user still OPEN) |
| D26 | P1 | IMPLEMENTED | compose Postgres/Redis bind `127.0.0.1`; RUNBOOKS production bind + ADMIN_PASSWORD rotation limitation | compose + `docs/launch/RUNBOOKS.md` | — (restore drill still OPEN) |
| D27 | P1 | IMPLEMENTED | CI `pnpm build` + `build-packages` job; soak comments helper≠full engine | `.github/workflows/ci.yml` / `scripts/soak-capacity.mjs` | — (full-engine/browser soak still OPEN) |
| D28 | P2 | IMPLEMENTED (partial) | `packages/evolution/src/lineage.ts` distinct hashes + approval binding + partitions (spend budgets still prior autonomy path) | `pnpm exec vitest run packages/evolution/src/lineage.test.ts` | VERIFIED_UNIT (lineage helpers; full lab UX open) |
| D29 | P2 | OPEN | Snapshot/query cost | api | — | profile before optimising; not claimed fixed |
| D30 | P2 | IMPLEMENTED | Global `:focus-visible`; history Open buttons; positions `aria-live` mutation status; non-colour status words on readiness/protection (Radix kept) | web globals + history/positions | — |

### Status counts (from rows)

| Status | Count |
| --- | --- |
| IMPLEMENTED | 28 (D01–D27, D30) |
| OPEN | 1 (D29) |
| DESIGN | 1 (D28) |
| **Total** | **30** |

### Notes

- Gate A code paths updated on this branch; full worker/DB verification still pending for D01/D02/D07.
- Gate B (local): D08 multi-route mandatory refresh, D09 ExecutionGateway SANDBOX stub (no local PAPER masquerade; full demo lifecycle follow-on), D10 practice URL/readiness, D11 instance ownership, D12 HOLD≠bypass exits, D13 promotion evidence, D15 MarketSelection admission.
- Gate C (operator UX): D16 ops vs strategy immutability, D17 draft preservation, D18 socket≠market-live refresh hygiene, D19 ticket intent/preview/async receipt, D20 position protection/close actions.
- Gate D (partial): D14 analytics window labels; D22 history pagination hooks; D23 readiness checklist; D24 nav hierarchy; D25 single-operator auth/socket hardening; D26 loopback compose + rotation note; D27 CI production build; D30 focus-visible/live-region. Remainders: D28 research lineage, D29 snapshot cost, multi-user rooms, tested restore, full-engine/browser soak, CSV export / full onboarding wizard.
- Live money remains disabled.
