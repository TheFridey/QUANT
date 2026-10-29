# QUANT Launch — Gate Programme Plan

**Baseline SHA:** `be0923305193cfbf5ccfbf6336663e0b002ca5bf` (main)  
**Working branch:** `cursor/quant-gate-a-correctness-95f1`  
**Audit sources:** `QUANT_DEEP_AUDIT_RELEASE1.md`, `QUANT_CURSOR_FULL_PRODUCT_IMPLEMENTATION.md`

## Current focus

**Gate A — correctness (stages 01–15)** covering findings **D01–D07** and presentation isolation **D21**.

No reliable performance or “production-ready” claims until Gate A passes with worker/database evidence.

## Ordered programme (Gates A→D)

| Gate | Stages | Scope | Findings emphasis |
| --- | --- | --- | --- |
| **A — Correctness** | **01–15** | Immutable scope, economic units/reservations, eligible events, safety, lifecycle/protection/retry, priority mark refresh | **D01–D07, D21** |
| **B — Market/strategy execution** | 16–32 | Provider routing, named demo, market selection, strategy instances, replay parity, promotion/reporting | D08–D15 |
| **C — Operator beta** | 33–49 | Truthful UI, controls/onboarding, drafts/reconnect, positions/history, a11y, research workflows | D16–D24, D30 |
| **D — Operational release** | 50–60 | Auth/deploy/migrate/restore, CI/full-engine load, paper evidence, owner handoff | D25–D29 |

Stages are dependency milestones; independent work may proceed in parallel behind frozen contracts (`CONTRACTS.md`).

## Stage map (01–60)

### Gate A — 01–15

| Stage | Title |
| --- | --- |
| 01 | Baseline, reproduce and preserve |
| 02 | Freeze execution identity contracts |
| 03 | Pin context durably at cycle/intent creation |
| 04 | Complete environment and dataset isolation |
| 05 | Replace delimiter-based position keys |
| 06 | Establish timestamp and eligible-fill policy |
| 07 | Rebuild authoritative budget semantics |
| 08 | Make reservations durable and idempotent |
| 09 | Correct settlement/admission ordering |
| 10 | Complete safety effects and resolution |
| 11 | Complete lifecycle ownership of protection |
| 12 | Make native and synthetic protection truthful |
| 13 | Type and scope all recovery intents |
| 14 | Make stop/target/trailing/time independent of strategy HOLD |
| 15 | Prioritise mandatory data refresh |

### Gate B — 16–32

| Stage | Title |
| --- | --- |
| 16 | Complete the market-data gateway |
| 17 | Enforce real market selection |
| 18 | Complete provider configuration and readiness |
| 19 | Finish named external demo execution |
| 20 | Add authoritative venue reconciliation |
| 21 | Finish product and currency accounting |
| 22 | Use accurate venue sessions and costs |
| 23 | Make strategy instances executable owners |
| 24 | Add strategy allocations and conflict/netting policy |
| 25 | Implement useful strategy diversity |
| 26 | Implement deterministic opportunity allocation |
| 27 | Unify runtime and replay |
| 28 | Make promotion server-evidence-backed |
| 29 | Complete safe research autonomy and model operations |
| 30 | Make learning and trade memory useful |
| 31 | Correct analytics and reporting windows |
| 32 | Rebuild the opportunity funnel from actual events |

### Gate C — 33–49

| Stage | Title |
| --- | --- |
| 33 | Typed operator view models and truthful freshness |
| 34 | Desk / safety / why-blocked surfaces |
| 35 | Operational controls without config race |
| 36 | Draft-safe config editing |
| 37 | Connection / freshness honesty |
| 38 | Order ticket with durable intent |
| 39 | Actionable positions and recovery UI |
| 40 | Real history / trade detail |
| 41 | First-session onboarding |
| 42 | Navigation hierarchy |
| 43–49 | Markets/instrument pages, research UX, mobile/keyboard/a11y |

### Gate D — 50–60

| Stage | Title |
| --- | --- |
| 50–54 | Auth, socket scope, deploy/backup/restore, migrations |
| 55–58 | CI proof, capacity/soak, retention, observed-data paper |
| 59 | Bounded external demo (credentials permitting) |
| 60 | Independent release review and owner handoff |

## Gate A acceptance bar

1. ExecutionContext pinned; no mid-cycle global config bleed.
2. Marks/history/recovery scoped by `tradingEnvironment` (null never compatible).
3. Eligible fills reject old-event/new-receipt and future receipts.
4. ReservationBudget open usage + HELD remainders counted once.
5. ACTIVE safety (incl. `PROTECTION_RECOVERY`) suspends entries; ACK ≠ resolve.
6. Position keys: known `accountId` + exact match (`primary:fixture:etf:SPY` works).
7. Protection intents typed/scoped; native desired-only ≠ protected.
8. Terminal snapshot (D21) cannot show fixture/delayed quotes as LIVE for paper accounts.

Track status in `FINDINGS_MATRIX.md`; contracts in `CONTRACTS.md`; decisions in `DECISIONS.md`.
