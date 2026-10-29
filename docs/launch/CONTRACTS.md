# QUANT Launch — Frozen Gate A Contracts

Versioned contracts for Gate A (stages 01–15). Lower-level mutation helpers must not invent an implicit `primary` default or treat null environment as compatible.

**Baseline:** `be0923305193cfbf5ccfbf6336663e0b002ca5bf`  
**Branch:** `cursor/quant-gate-a-correctness-95f1`

---

## 1. ExecutionContext

**Source:** `packages/shared/src/execution-context.ts`

```ts
type ExecutionContext = {
  accountId: string;
  tradingEnvironment: TradingEnvironment; // FIXTURE | REPLAY | MARKET_DATA_PAPER | EXTERNAL_DEMO
  dataMode: DataMode;                     // live | replay | demo
  metricsAccountId: string;
  configRevision?: string | null;
  strategyRevision?: string | null;
  riskRevision?: string | null;
};
```

**Rules**

- Pin at cycle / manual-intent creation (`pinExecutionContext`); stages load the pin via `loadPinnedExecutionContext`.
- Economic writes use `assertExecutionAccount` — refuse cross-account/env mutation.
- Mid-cycle live re-resolution must not redirect ledger/reservation/protection writes (`executionContextMatches`).
- Account mapping: `MARKET_DATA_PAPER` → `primary`; other envs → `primary:<env>` (e.g. `primary:fixture`).

---

## 2. PositionIdentity / position-key

**Source:** `packages/shared/src/position-key.ts`

```ts
type PositionIdentity = {
  accountId: string;
  instrumentId: string;
  lifecycleId?: string | null;
};

buildPositionKey(accountId, instrumentId) → `${accountId}:${instrumentId}`
instrumentIdFromPositionKey(positionKey, accountId) → instrumentId | null
```

**Rules**

- Display keys may contain colons inside `accountId` and `instrumentId` (e.g. `primary:fixture:etf:SPY`).
- Parsing **requires** the known `accountId` prefix — never recover identity by splitting on the first colon.
- Matching is exact key equality (`positionKeysEqual`); no suffix / first-colon fallback.
- Lifecycle fencing: when a position has a known `lifecycleId`, legs with a different or null lifecycle do not cover it.

---

## 3. EligibleObservation policy

**Source:** `packages/trading-engine/src/eligible-observation.ts`

Pending-fill selection requires:

| Constraint | Rule |
| --- | --- |
| Instrument | Exact `pairAddress` |
| Environment | Exact `tradingEnvironment` match |
| Null env | **Not accepted** when `allowNullEnvironment !== true` (default false for trading) |
| Receipt window | `eligibleAt ≤ receivedAt ≤ now` (and `< expiresAt` when set) |
| Provider event | When `eventTime` present: must also be ≥ `eligibleAt` and ≤ `now` — **old-event/new-receipt rejected** |
| Future | Future receipts / future event times rejected |
| Prefer cycle | Optional `preferIngestJobId` tried first, still subject to the same usability checks |
| Price | `priceUsd` must be non-null |

---

## 4. ReservationBudget — open + HELD semantics

**Source:** `packages/risk-engine/src/reservations.ts`, `packages/risk-engine/src/pg-reservations.ts`

```ts
type ReservationBudget = {
  cashAvailableUsd: string;
  exposureCapUsd: string;
  exposureUsedUsd: string;   // open-book usage (filled positions)
  slotsAvailable: number;
  slotsUsed: number;         // open-book slots
  riskBudgetUsd: string;
  riskUsedUsd: string;       // open-book risk
};
```

**Rules**

- `exposureUsedUsd` / `slotsUsed` / `riskUsedUsd` on the budget represent **open** (filled) usage from the book.
- **HELD** reservation remainings are added on top during `reconstructBudget` — CONSUMED fills already live on the open book and must not be double-counted.
- Production authority: `PostgresReservationAuthority` (account lock, idempotent `accountId+mode+clientOrderId`).
- In-memory `ReservationLedger` is test reference only.
- Status lifecycle: `HELD` → `RELEASED` | `CONSUMED`; partial release zeroes remainders without inventing capacity.

---

## 5. ENTRY_BLOCKING_SAFETY_CODES

**Source:** `packages/shared/src/safety-state.ts`

```ts
ENTRY_BLOCKING_SAFETY_CODES = [
  "ENTRIES_SUSPENDED",
  "PROTECTION_RECOVERY",
  "RECONCILE_ISSUE",
  "CIRCUIT_BREAKER",
  "FLATTEN_INCOMPLETE",
]
```

**Rules**

- Any **ACTIVE** row with one of these codes suspends new risk expansion (`entriesSuspendedFromSafety`).
- Exits, protection retry, and flatten remain available.
- Alert ACK never clears a safety code (`alertAckClearsSafetyCode` → always false).
- Resolve only after the underlying condition clears (clean reconcile / verified recovery).

---

## 6. ProtectionIntent kinds

**Source:** `packages/shared/prisma/schema.prisma` (`ProtectionIntent`), `packages/trading-engine/src/protection-lifecycle.ts`

| Kind | Purpose |
| --- | --- |
| `EXIT_RETRY` | Retry a failed protective exit (default) |
| `AMEND_RETRY` | Retry a failed stop/target amendment — must not sell the position |
| `CANCEL_RETRY` | Retry cancel of a protection leg |
| `RECONCILE_UNKNOWN` | Reconcile unknown venue submit before resending |

**Rules**

- Intents carry immutable `accountId`, optional `lifecycleId` / `instrumentId` fence.
- Retries claim transactionally under the account mutation lock.
- Old-lifecycle recovery must not close a reopened holding.
- Bound attempts / `retryAfter`; escalate via alerts without treating ACK as resolution.

---

## 7. Mandatory held refresh (Gate B / D08)

**Source:** `packages/market-data/src/held-refresh.ts`, worker `observe`

- Start mandatory refresh without awaiting discovery completion.
- Route by instrument prefix (`solana_dex` / `fx` / `etf` / `commodity` / `index`).
- Pair-address lookups use a fair rotating budget — never silently drop permanently past 20.
- Every fetch uses an abort deadline; hung discovery must not block held-mark progress.

## 8. Practice URL + readiness (Gate B / D10)

**Source:** `packages/market-data/src/practice-url.ts`, Alpaca/OANDA providers

- Exact HTTPS host/port allowlists only; reject live hosts and allowlisted hostnames smuggled in path/query/userinfo.
- Readiness: `MISSING_CREDENTIALS` | `INVALID_CONFIGURATION` | `CONNECTING` | `AUTH_FAILED` | `READY` — key presence alone is not READY.
- Incomplete quotes (non-finite, ask&lt;bid, stale event) are rejected before execution use.

## 9. ExecutionGateway (Gate B / D09)

**Source:** `packages/market-data/src/execution-gateway.ts`, worker executor

- `PAPER` → `LocalPaperExecutionGateway` may book local PAPER.
- `SANDBOX` → stub returns `MISSING_CREDENTIALS` or `NOT_IMPLEMENTED`; never books local PAPER fills and does not place broker orders from the stub.
- Missing credentials block verification only; unimplemented lifecycle must not claim READY.
