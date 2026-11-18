# CATALYST: challenge to the C3 and C10 packages

18 Nov 2026. These are amendments to [TITANIUM-APPROVAL-PACKAGE.md](TITANIUM-APPROVAL-PACKAGE.md), which stays the base specification. Nothing protected was edited. Each item says what the current design misses, the evidence and the required change. Approval of C3 (D12) and C10 (D13) should cover these amendments explicitly.

## Findings that change the design

| # | Finding | Evidence | Required change |
| --- | --- | --- | --- |
| X1 | **The existing account lock silently locks nothing for an AURUM account.** `lockAccount` and `lockAccountBudget` run `SELECT id FROM "PaperAccount" WHERE id = $1 FOR UPDATE`. A GBP account has no PaperAccount row by design, so the query matches zero rows and returns normally. | `packages/trading-engine/src/store.ts:43`, `packages/risk-engine/src/pg-reservations.ts:371` | C10 adds `lockAurumAccount(tx, accountId)`, which locks the `AccountEngineControl` row and **throws if no row was locked**. AURUM code must never call the legacy helpers; a static test greps the AURUM modules for them. A DB test shows two transactions serialising on the new lock. |
| X2 | **Composite foreign keys stop cross-account *references*, not cross-account *reads or writes*.** A query built with the wrong `accountId` still reads or updates another account's rows. Account-ID checks and FKs alone are not isolation. | design review | Add PostgreSQL **row-level security** on every new AURUM table: `USING (account_id = current_setting('aurum.account_id', true))` and the same `WITH CHECK`, `FORCE ROW LEVEL SECURITY`, deny when the setting is unset. Every AURUM transaction runs `SET LOCAL aurum.account_id`. A test opens a transaction for account A and shows that rows of B are invisible and unwritable. |
| X3 | **One database role can do everything.** The legacy worker could write AURUM tables, and AURUM code could update legacy `Order`/`Position`. | existing migrations have no GRANT or ROLE statements | Two roles: `quant_legacy` (no privileges on AURUM tables) and `quant_aurum` (no UPDATE/DELETE on legacy financial tables, no BYPASSRLS). Ledger and fill tables get INSERT only, with UPDATE/DELETE refused by trigger (TITANIUM already requires the trigger). Roles are created by an operator script, not by an app migration. |
| X4 | **Process-level shared state crosses accounts.** `StageRunner` keeps `securityMemo`, `heldRefreshFairness` and the observability registry per process. `EngineControl` is read as `id: "primary"` in at least five places. | `stage-runner.ts` (`heldRefreshFairness`, `config()`, `loadPlan`), `executor/settle.ts:19`, `executor/protect.ts:27` | AURUM runs in its **own worker process and BullMQ queue namespace** (`aurum.*`), with its own runner class reading `AccountEngineControl` by explicit id. It must not be a second account inside the legacy StageRunner. A test asserts that the AURUM runner never reads `EngineControl` or `PaperAccount`. |
| X5 | **No margin close-out rule.** C3 reserves margin but never defines what happens when equity falls below the margin requirement. A gapping loss could take GBP equity negative with positions still open. | C3 table: no close-out state or origin | Add origin `MARGIN_CLOSEOUT` and a close-out level (for example equity ≤ 50% of reserved margin; the operator sets it). Add a ledger kind `NEGATIVE_BALANCE` with an explicit policy: either the account absorbs it, or the simulation refuses to continue. A test gaps through the stop and checks the close-out ordering. |
| X6 | **Ledger and materialised state can drift.** "GBP cash = sum of cash-affecting entries" is a test, not an invariant. | C3 "Required DB tests" | A deferred constraint trigger on commit checks `AccountFinancialState.cash = Σ ledger` for the touched account, so any transaction that breaks it fails to commit. |
| X7 | **The idempotency key is under-specified.** `economicEventId` has no stated derivation, so a retry with a new id would double-book. | C3 `unique(accountId,economicEventId,kind)` | Derive it deterministically, for example `sha256(accountId, orderId, fillSeq, kind)`, computed in one place and never from wall-clock or random values. A test retries a crashed fill with a fresh process and expects one ledger row. |
| X8 | **The daily-loss boundary is ambiguous.** C10 says "London session ID"; gold's trading day rolls at 17:00 New York; the generic product must be flat before that cut-off. | C10 `AccountFinancialState`; PRODUCT-SPECIFICATION | Pick one boundary for both daily loss and funding: 17:00 America/New_York, the same as `dailyAlignment` and the metals session break. Store the session id as that date, and test both DST transitions. |
| X9 | **Currency safety is checked only in the database.** TypeScript treats GBP and USD amounts as the same `string`/`Decimal`. | `spread-bet.ts` returns plain strings | Add branded types (`Gbp`, `UsdPrice`) for the AURUM adapter, and a lint rule or test that no AURUM module imports USD ledger helpers. This is cheap and catches errors before they reach a constraint. |
| X10 | **Global stop and account flatten are different operations.** They must not share a code path. | TITANIUM C10 text (correct, but not tested as separate paths) | See the table below. Tests: a global stop leaves account state and positions untouched while refusing entries everywhere; an account flatten touches only that account; neither clears the other's latch. |

## Global emergency stop vs account flatten

| | Global emergency stop | Account flatten |
| --- | --- | --- |
| Scope | every account, legacy and AURUM | one named account |
| Effect on entries | refused everywhere until cleared by global admin | refused for that account until its control row says otherwise |
| Effect on positions | **none by itself**: positions stay; protective and reducing exits continue | closes that account's positions at the next executable quote, as origin `FLATTEN` |
| Effect on latches | none | none: drawdown, daily-loss and HWM state are preserved |
| Authority | global ADMIN; separate from account membership | account OPERATE or ADMIN membership |
| Clearing | global ADMIN only; an account command cannot clear it | the account's own control; cannot clear a global stop |
| Storage | `GlobalRiskControl` (new), effective together with the existing legacy halt | `AccountEngineControl.flattenRequested` plus an `AccountControlEvent` |

## Primary-account protections that must not weaken

- `primary` keeps its existing `EngineControl`, `DEFAULT_STRATEGY` limits, drawdown latch and halt semantics. C10 only *adds* rows and adapters; it does not migrate `primary` (TITANIUM migration step 1).
- `loadPinnedExecutionContext` keeps refusing anything it refuses today. The `startsWith("primary")` check is replaced by exact registry lookup only for new AURUM paths, behind tests showing that every currently valid legacy id still resolves identically.
- The global stop is effective as legacy halt OR new latch. Neither can lower the other.

## Contamination test matrix (to implement under approval)

Each write path (order, fill, position, reservation, ledger, control event, risk config, financial state) and each read path (API account views, metrics, equity snapshot, readiness) is tested three ways:
1. under the wrong `aurum.account_id`, where RLS must refuse;
2. with a composite FK to another account's row, which must be refused;
3. through the application adapter with a forged id, where RBAC must refuse.

Legacy `primary` is included as the "other" account in every case.
