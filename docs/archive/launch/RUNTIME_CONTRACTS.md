# QUANT Release — Shared Runtime Contracts

**Branch:** `cursor/quant-release-runtime-cc8a`  
**Baseline main:** `e08a5a1778c6555e324a2a62ab085352002f3bc0`  
**Authority:** TypeScript sources under `packages/shared/src/runtime-contracts.ts` (and linked modules). This doc is the human-readable freeze so parallel workstreams stay compatible.

Do not invent incompatible intent / allocation / order-state / API response models. Extend these contracts additively.

---

## 1. CanonicalAttributedIntent

**Source:** `packages/agent-core/src/strategy-instances.ts` → `CanonicalAttributedIntent`  
**Zod mirror:** `packages/shared/src/runtime-contracts.ts`

| Field | Type | Rules |
| --- | --- | --- |
| `strategyInstanceId` | string | Durable instance owner; required for automatic ENTRY/EXIT/REDUCE |
| `strategyVersion` | string | `moduleRef@version` or name@version |
| `moduleRef` | string \| null | Explicit binding; never derived from display name alone |
| `accountId` | string | Execution account (may contain `:`) |
| `tradingEnvironment` | string \| null | FIXTURE \| REPLAY \| MARKET_DATA_PAPER \| EXTERNAL_DEMO |
| `instrumentId` | string | Canonical instrument id |
| `pairAddress` | string | Venue/observation key (may equal instrumentId) |
| `action` | ENTER \| EXIT \| REDUCE \| HOLD \| RESEARCH | Strategies emit intents only — never broker orders |
| `observationId` | string \| null | Decision observation |
| `observationReceivedAt` | string \| null | ISO timestamp |
| `reasonCodes` | string[] | Honest codes; unknown stays unknown |
| `artifactHash` / `sourceHash` | string \| null | Provenance; never forge booleans from hashes |
| `libraryIntent` | string | Original StrategySignal intent |

**Identity:** Order `clientOrderId` / audit rows must include intent identity (`strategyInstanceId` + cycle + instrument). Same-symbol intents from different instances are **not** collapsed; netting is ownership-aware.

---

## 2. StrategyAllocationView

**Source:** `packages/trading-engine/src/strategy-allocations.ts` (runtime settlement)  
**Unique key:** `(accountId, strategyInstanceId, pairAddress)`

| Field | Rules |
| --- | --- |
| `id` | Stable cuid / `newId("alloc")` — **no** truncated collision-prone string |
| `qty` / `avgCostUsd` | Decimal strings; Decimal(24,8) |
| `lifecycleId` | Current open-lot fence |
| `committedCapitalUsd` / `pendingCapitalUsd` | Budget accounting; settle refreshes capacity |

**Settlement:** Every fill path in `commitProposedOrder` / pending fill settlement that carries `strategyInstanceId` must call `applyAllocationFill` in the same transaction. SELL may not exceed that instance’s qty unless `forceNetClose` (account flatten).

**Reconcile:** Sum of allocation qty for `(accountId, pairAddress)` should match venue net position; drift → audited repair, never silent history rewrite.

---

## 3. Order / fill identity

| Field | Rules |
| --- | --- |
| `clientOrderId` | Globally unique; idempotent submit key |
| `strategyInstanceId` | On Order + Fill when attributed |
| `intent` | ENTRY \| EXIT \| FLATTEN \| OPERATOR (REDUCE maps to EXIT with sized qty) |
| `executionMode` | PAPER \| SANDBOX \| LIVE — LIVE disabled |
| `venue` | PAPER for local; practice venue id for demo |

SANDBOX never books local PAPER fills. Unknown submit outcomes persist as durable `RECONCILE_UNKNOWN` / practice unknown-outcome records.

---

## 4. Instance scheduling / fairness

`allocateOpportunities({ signals, maxNewEntries, fairnessCursor? })`:

1. All EXIT / REDUCE accepted first (exit priority).
2. ENTER admitted with deficit round-robin / aging — **not** permanent alphabetical winner.
3. Persist `fairnessCursor` (last admitted instance id or RR index) on engine/account scheduling state across cycles.
4. Deterministic for identical inputs + cursor.

---

## 5. Market scoping

`instanceMatchesInstrument(instance, bar)`:

- Exact match on `instrumentId` or `pairAddress`.
- `solana:spot:universe` matches **Solana** instruments only (never EURUSD/ETF).
- Prefix wildcards `fx:*`, `etf:*` when explicitly configured.
- Held positions remain monitorable even when market entry is disabled (MarketSelection).

---

## 6. API response envelopes (operator)

Terminal / ops responses that explain inactivity must distinguish at least:

| Code family | Meaning |
| --- | --- |
| `NO_EDGE` | Market did not meet strategy thresholds |
| `STRATEGY_INSTANCE_GATING` / `NO_INTENT` | Instances active; no attributed ENTER |
| `BUDGET_EXHAUSTED` | Instance or account budget |
| `MARKET_ENTRY_DISABLED` | Operator market selection |
| `ENTRIES_SUSPENDED` / safety codes | Risk/protection halt |
| `MISSING_CREDENTIALS` / `BLOCKED_EXTERNAL` | Practice path only |
| `PROTECTION_RECOVERY` | Exits continue; expansion blocked |

Primary UI must not dump raw snapshot profiling; cost metrics stay diagnostic.

---

## 7. Promotion evidence

Validated promotion requires **server-resolved** `reportId` → `ExperimentReport`. Client-asserted evidence fields are ignored when `reportId` is bound. Optional distinct `UNVALIDATED` paper action may apply config without claiming validation. Lineage hashes: source ≠ artifact ≠ report; unknown stays unknown.

---

## 8. Practice broker

Complete Alpaca paper transport first (`AlpacaPracticeBroker` + HTTP). Wire through `ExecutionGateway` mode SANDBOX. `scripts/verify-practice-broker.mjs`: `ok` reflects real outcome; exit 3 `BLOCKED_EXTERNAL` when creds missing; nonzero on failure.

---

## 9. Verification labels

Use only: `NOT_IMPLEMENTED` \| `DESIGN_ONLY` \| `IMPLEMENTED_UNVERIFIED` \| `VERIFIED_UNIT` \| `VERIFIED_INTEGRATION` \| `VERIFIED_E2E` \| `BLOCKED_EXTERNAL`.
