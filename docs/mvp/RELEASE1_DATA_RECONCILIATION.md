# Release 1 — Contaminated paper data reconciliation plan

**Do not silently delete** fixture / cross-environment contamination from primary paper ledgers.

## Symptoms addressed

- Fixture or REPLAY observations / fills / equity rows written into `MARKET_DATA_PAPER` (`primary`) account streams.
- Orders, positions, protection, and reservations executed against the wrong account id when `tradingEnvironment` was FIXTURE/REPLAY/EXTERNAL_DEMO.
- Alert ACK cleared worker entry suspension without a clean reconcile.

## Isolation after this release

- Cycle creation resolves one immutable `ExecutionContext` (`accountId`, `tradingEnvironment`, `metricsAccountId`).
- All economic reads/writes (book, locks, reservations, orders, fills, protection, funnel, equity) use that context.
- Terminal snapshot / equity history refuse cross-env fallback to `primary` when the env-scoped account is missing.
- Fixtures remain out of primary paper metrics via per-row `dataOrigin` checks (R09) and account scoping (R03).

## Recommended operator reconciliation (manual)

1. **Inventory**
   - List `PaperAccount` ids and `tradingEnvironment`.
   - Count `Order` / `Fill` / `EquitySnapshot` / `OpportunityFunnelEvent` rows per `accountId`.
   - Flag `MarketObservation` rows with `dataOrigin = FIXTURE_SEQUENCE` that also appear in cycles used by `primary`.

2. **Quarantine (copy, do not delete)**
   - Create reporting tags or a sidecar table / CSV export of suspect `primary` rows that have fixture provenance in the linked observation or cycle.
   - Prefer `accountId` reassignment to `primary:fixture` / `primary:replay` when the economic intent is clear and no conflicting open position remains on `primary`.

3. **Open risk**
   - For open `Position` on `primary` with fixture-linked fills: flatten under operator control in FIXTURE env after migration, or mark `PROTECTION_RECOVERY` safety state until resolved.
   - Arm protection only after a genuine eligible observation exists for the target environment.

4. **Safety state**
   - Active `AccountSafetyState(ENTRIES_SUSPENDED)` survives alert ACK; clear only via clean reconcile.
   - After migration, run one reconcile cycle per account; confirm suspension clears only when ledger/broker match.

5. **Metrics**
   - Rebuild funnel/equity views filtered by `metricsAccountIdFor(env)`.
   - Do not average FIXTURE equity into MARKET_DATA_PAPER dashboards.

## Schema notes

Migration `20261029140000_release1_correctness_lifecycle_safety` adds lifecycle, observation provenance, fill observation ids, and `AccountSafetyState` without dropping historical rows.
