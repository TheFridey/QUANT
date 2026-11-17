# HORIZON Phase II: end-to-end acceptance matrix

**State:**

- `PASS`: a test exists and passes on this branch.
- `EXISTING`: covered by an existing suite; not re-run here unless stated.
- `NEEDS_PROTECTED`: can only be tested once a protected item lands.
- `OPEN`: not yet written.

Forced-signal lifecycle tests must use an isolated test account in the `odin_test` database. They are never production trades and never count as strategy opportunities.

| # | Stage | Crypto (Solana) | FX (EUR/USD) | USD/JPY | Metals (XAU) | Energy (WTI) | ETF (SPY) | Evidence / gap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Provider quote ingestion | EXISTING | OPEN (B1) | OPEN | OPEN | OPEN | OPEN | read-only probe `PROD` 17 Nov |
| 2 | Normalisation and provenance | EXISTING | OPEN (B2/B3) | OPEN | OPEN | OPEN | OPEN | `quote-quality.test.ts` EXISTING |
| 3 | Session validation | EXISTING | PASS | PASS | PASS (CFD break) | PASS (CFD break) | PASS (early close) | `sessions.test.ts` (`0119fdf`) |
| 4 | Currency conversion | n/a | n/a (USD) | NEEDS_PROTECTED (A5) | n/a | n/a | n/a | `fx-conversion.test.ts` helpers EXISTING |
| 5 | Position sizing | EXISTING | NEEDS_PROTECTED (A4) | NEEDS_PROTECTED | NEEDS_PROTECTED | NEEDS_PROTECTED | NEEDS_PROTECTED | |
| 6 | Strategy decision | EXISTING | OPEN (B4, B13) | OPEN | OPEN | OPEN | OPEN | |
| 7 | Risk admission | EXISTING | PASS (classifier) / NEEDS_PROTECTED (A1) | as FX | as FX | as FX | as FX | `quote-admission.test.ts` 20 tests |
| 8 | Paper order creation | EXISTING | NEEDS_PROTECTED | ← | ← | ← | ← | |
| 9 | Fill simulation | EXISTING (`fill.test.ts`) | NEEDS_PROTECTED (A4/A6) | ← | ← | ← | ← | |
| 10 | Ledger accounting | EXISTING | NEEDS_PROTECTED | NEEDS_PROTECTED (A5) | ← | ← | ← | |
| 11 | Position valuation | EXISTING | OPEN (needs B1 marks) | NEEDS_PROTECTED | OPEN | OPEN | OPEN | |
| 12 | Protective exit | EXISTING (`exit-policy.test.ts`) | NEEDS_PROTECTED | ← | ← | ← | ← | |
| 13 | Realised P&L | EXISTING | NEEDS_PROTECTED | NEEDS_PROTECTED | ← | ← | ← | |
| 14 | Restart and recovery | EXISTING (engine soak) | NEEDS_PROTECTED | ← | ← | ← | ← | |
| 15 | Duplicate processing | EXISTING (`@@unique([ingestJobId, pairAddress])`, idempotent intents) | OPEN | ← | ← | ← | ← | |
| 16 | Missing or stale data | EXISTING | PASS (classifier) | PASS | PASS | PASS | PASS | stale, missing and future cases in `quote-admission.test.ts` |
| 17 | Excessive spread | n/a (impact model) | PASS (classifier cap) | PASS | PASS | PASS | PASS (607 bps overnight case) | A6 wires it |
| 18 | Market closure | n/a | PASS | PASS | PASS | PASS | PASS | `sessions.test.ts` |
| 19 | PCR-1 lifecycle fencing | EXISTING (`lifecycle-fence` DB suite) | NEEDS_PROTECTED (A4 property test) | ← | ← | ← | ← | |
| 20 | Solana regression | PASS: targeted suites pass on this branch; full suite in EXECUTION-LEDGER | — | — | — | — | — | |

Supporting unwired components:

| Component | Tests | State |
| --- | --- | --- |
| Provider circuit breaker | 9 (`provider-circuit.test.ts`) | PASS |
| Maturity ladder and per-class scan capacity | 8 (`maturity-ladder.test.ts`; monotonicity over 2^10 fact combinations) | PASS |

Activation requires every column to be `PASS` for the asset class concerned (rows 1–19), on Linux CI, with independent safety, statistical and regression reviews.
