# OPERATION AURUM, PROJECT MIDAS

QUANT specialises in **XAU/USD** as a simulated UK financial spread bet, with GBP account currency. It is **PAPER ONLY**: no live money, no broker orders, no signing, no gate weakened.

If the research finds no defensible edge, the deliverable is a correct research and simulation platform that abstains from trading.

This programme supersedes OPERATION HORIZON Phase II / BREAKOUT (`docs/horizon/phase-ii/`, kept as history).

TITANIUM's current local checkpoint is on `aurum/05-titanium-integration`. Independent review corrected inactive product/feed code and quarantined unsafe retention deletion. Production and gold execution remain untouched. Start with [TITANIUM-REPORT.md](TITANIUM-REPORT.md) for the final results, TAKEOVER-TITANIUM.md for the baseline and TITANIUM-REGRESSION.md for attempts; approval scope is in TITANIUM-APPROVAL-PACKAGE.md. Historical M0 records below remain evidence of their original checkpoint.

| Document | Purpose |
| --- | --- |
| [STATUS.md](STATUS.md) | current checkpoint, execution ledger, operator decisions |
| [BASELINE.md](BASELINE.md) | verified and recorded baseline, with labelled evidence |
| [ARCHITECTURE.md](ARCHITECTURE.md) | ADR: subsystem mapping, isolation gap, dependency graph |
| [SCOPE.md](SCOPE.md) | GOLD_ONLY profile and legacy-account preservation |
| [STORAGE-PLAN.md](STORAGE-PLAN.md) | Workstream Zero retention and archival |
| [PRODUCT-SPECIFICATION.md](PRODUCT-SPECIFICATION.md) | broker evidence and the generic simulation profile |
| [SPREAD-BET-ACCOUNTING.md](SPREAD-BET-ACCOUNTING.md) | units, P&L, margin, sizing, order actions, state machine |
| [PCR-AURUM-01.md](PCR-AURUM-01.md) | protected change request (draft) |
| [EXECUTION-LEDGER.md](EXECUTION-LEDGER.md) | interrupted workstream reconciliation and integration evidence |
| [FEED.md](FEED.md) | transport, quality economics and protected persistence proposal |
| [TITANIUM-TRIALS-AND-DATA.md](TITANIUM-TRIALS-AND-DATA.md) | counting semantics, operator read-only SQL and dataset availability |

The remaining documents named in the brief are written at the milestone that produces their evidence (STATUS, "Not done or blocked"). They are not created as placeholders.

## Code (pure, unwired, inactive)

- `packages/shared/src/aurum-scope.ts`: GOLD_ONLY default-deny admission.
- `packages/shared/src/spread-bet.ts`: quotes, P&L, margin, sizing, gaps.
- `packages/shared/src/spread-bet-lifecycle.ts`: position state machine.
- `apps/worker/src/ops/retention-policy.ts` and `retention-dry-run-cli.ts`: retention planning and read-only estimates.
