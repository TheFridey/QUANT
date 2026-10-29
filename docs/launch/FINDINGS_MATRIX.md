# QUANT Launch — Findings Matrix (D01–D30)

**Baseline:** `be0923305193cfbf5ccfbf6336663e0b002ca5bf`  
**Branch:** `cursor/quant-gate-a-correctness-95f1`  
**Verification levels:** implementation ≠ verification. VERIFIED_* only when evidence recorded.

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
| D11 | P1 | IMPLEMENTED | `strategy-instances.ts` buildInstancePlanGates; empty ENTER allowlist (no null fallback); EXIT→pulse; order `strategyInstanceId` stamp | `pnpm exec vitest run packages/agent-core/src/strategy-instances.test.ts packages/agent-core/src/pulse-exits.test.ts packages/agent-core/src/active-strategy.test.ts` | VERIFIED_UNIT |
| D12 | P1 | IMPLEMENTED | `pulse.ts` promoted HOLD falls through to stop/target/time exits when held | `pnpm exec vitest run packages/agent-core/src/pulse-exits.test.ts` | VERIFIED_UNIT (exits; product accounting still OPEN) |
| D13 | P1 | IMPLEMENTED | `promotion.ts` evidenceFromExperimentReport; `evolution.service` promote resolves reportId server-side, refuses missing | `pnpm exec vitest run packages/evolution/src/promotion.test.ts apps/api/src/promote-paper.test.ts` | VERIFIED_UNIT |
| D14 | P1 | OPEN | Analytics window mix | analytics / terminal | — |
| D15 | P1 | IMPLEMENTED | `market-admission.ts` + stage-runner loadPlan MarketSelection map; plan blocks ENTRY, exits/monitoring remain | `pnpm exec vitest run packages/agent-core/src/market-admission.test.ts packages/agent-core/src/pulse-exits.test.ts` | VERIFIED_UNIT |
| D16 | P1 | OPEN | Ops controls vs config immutability | api / web | — |
| D17 | P1 | OPEN | Polling overwrites drafts | web | — |
| D18 | P1 | OPEN | Socket≠market-live | web | — |
| D19 | P1 | OPEN | Ticket idempotency / preview | api / web | — |
| D20 | P1 | OPEN | Position actionable UI | web | — |
| D21 | P1 | IMPLEMENTED | Terminal snapshot env-scoped marks; provenance freshness; exact position keys | observation-origin + position-key | VERIFIED_UNIT (helpers) |
| D22 | P2 | OPEN | History pagination | api / web | — |
| D23 | P2 | DESIGN | Onboarding wizard | web | — |
| D24 | P2 | DESIGN | Navigation hierarchy | web | — |
| D25 | P1 | OPEN | Auth/session/socket | api | — |
| D26 | P1 | OPEN | Deploy/backup/restore | compose / docs | — |
| D27 | P1 | OPEN | CI/soak/capacity | .github / scripts | — |
| D28 | P2 | DESIGN | Research spend/lineage | evolution / lab | — |
| D29 | P2 | OPEN | Snapshot/query cost | api | — |
| D30 | P2 | DESIGN | A11y / feedback | web | — |

### Status counts (from rows)

| Status | Count |
| --- | --- |
| IMPLEMENTED | 15 (D01–D13, D15, D21) |
| OPEN | 11 |
| DESIGN | 4 |
| **Total** | **30** |

### Notes

- Gate A code paths updated on this branch; full worker/DB verification still pending for D01/D02/D07.
- Gate B (local): D08 multi-route mandatory refresh, D09 ExecutionGateway SANDBOX stub (no local PAPER masquerade; full demo lifecycle follow-on), D10 practice URL/readiness, D11 instance ownership, D12 HOLD≠bypass exits, D13 promotion evidence, D15 MarketSelection admission.
- Live money remains disabled.
