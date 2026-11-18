# TITANIUM independent market-data review

Reviewed original branch `aurum/03-market-data`, `0cc864c`, against main. Review performed in isolated worktree `D:/Projects/QUANT-titanium-feed`, branch `aurum/titanium-feed-review`. No original branch was overwritten. No environment files, credentials, production database, provider endpoint, holdout or broker order route were accessed. Source inspection and synthetic tests are VERIFIED_REPOSITORY/VERIFIED_TEST evidence only. FEED.md contains the public-documentation investigation and unapproved persistence/threshold proposal.

## Findings and disposition

References identify original implementation lines at `0cc864c`; corrected implementations retain the function names.

| ID | Severity | Evidence and reproduction | Consequence | Correction / regression | Disposition |
| --- | --- | --- | --- | --- | --- |
| TF1 | HIGH | `packages/market-data/src/provider-circuit.ts:196,206`: admit two CLOSED requests with the same token; complete newer failure below threshold, then old success. Original success resets the failure count because epoch changes only on state transitions. Duplicate failure also counts repeatedly. | Breaker may fail to open, or open from duplicate completion; N3 claim incomplete. | Consume epoch on every completion; stale/missing tokens only increment stale diagnostic count. Test both completion orders and duplicate completion. | FIXED; targeted tests pass; root independent post-fix review required |
| TF2 | MEDIUM | `packages/market-data/src/provider-circuit.ts:80`: missing token failure in HALF_OPEN is accepted; OPEN success/failure writes diagnostics before token check. | Unknown old completion affects new-generation state or misleads readiness diagnostics. | Require matching token in every state; check before OPEN handling; add resetCircuit preserving epoch and reset regression. Serialise per key to count every CLOSED outcome; simultaneous requests share generation and first result consumes it. | FIXED; reset test included in final test run; root review required |
| TF3 | HIGH | `packages/market-data/src/gold-shadow-feed.ts:178`, read-only `providers/oanda-practice.ts:618`: injected pricing promise never settles; subsequent poll remains THROTTLED forever, with no result/timeout. Adapter has no deadline. | Feed outage hidden behind an in-flight slot; unbounded network wait. | Full-operation timeout, AbortSignal passed only to read-only GET/pricing, late results discarded, original request retains slot until settlement if abort ignored. Fake-time timeout/retry/no-overlap test and provider signal test. No order-capable provider change. | FIXED; targeted tests pass; stuck noncompliant transport still requires diagnosis/restart |
| TF4 | MEDIUM | `packages/market-data/src/gold-shadow-feed.ts:221`: future quote is stored with failed quality but also becomes latest; valid next event is OUT_OF_ORDER. | Malformed provider clock poisons ordering watermark and suppresses real observations. | Reject invalid/future event before watermark; regression future+one day then legitimate quote. | FIXED; targeted test passes |
| TF5 | MEDIUM | `packages/market-data/src/gold-shadow-feed.ts:221`: null provider tradeability passes generic admission; injected OFFLINE_FIXTURE descriptor is returned with practice provenance. | Missing halt state can look quality-passing; fixture relabelling possible through dependency contract. | Require actual OANDA practice source/feed and matching event timestamp; missing tradeability fails feed quality without changing original null field. Test fixture rejection and unknown tradeability. | FIXED; targeted tests pass |
| TF6 | MEDIUM | `packages/market-data/src/gold-shadow-feed.ts:294,311`: mutate nested eventTime/quality on a returned quote; original buffer is shallow-shared. Constructor also retains caller config. | API consumer can corrupt watermark, quality, or enable feed by mutating original configuration. | Deep-copy config, stored quote and returned snapshots; regression mutates each surface. | FIXED; targeted test passes |
| TF7 | MEDIUM | `packages/market-data/src/gold-shadow-feed.ts:69`: zero probeTimeout accepted here; poll subsequently throws INVALID_CIRCUIT_POLICY. | Documented structured failure/no-throw interface violated by invalid policy. | Validate nested breaker policy before any request; regression asserts INVALID_CONFIG and zero requests. | FIXED; targeted test passes |
| TF8 | MEDIUM | `packages/market-data/src/gold-shadow-feed.ts:294`: stored admissible=true remains after ten seconds with five-second configured age. | A UI could mistake receipt-time verdict for current readiness. | Add recomputed status.currentQuality; retain original receipt verdict; regression stale status. | FIXED; targeted test passes |
| TF9 | LOW | `packages/market-data/src/gold-shadow-feed.ts:215`: provider failure or thrown fetcher error is copied into response/circuit. Inject secret sentinel in error. | An upstream diagnostic can expose sensitive request data through a read API. | Expose fixed code-based messages only; sentinel regression. | FIXED; targeted test passes |
| TF10 | MEDIUM | `packages/market-data/src/providers/oanda-practice.ts:456` truncates nanoseconds to milliseconds; feed identity is provider/instrument/time only. Two distinct sub-millisecond events collide or revisions are discarded. | Cannot serve as streaming tick identity or durable complete history. | Preserve full provider event time and separate canonical payload/event keys in additive persistence package; current polling feed explicitly sampled, in-memory only. | BLOCKED_APPROVAL for durable ingestion; no tick-completeness claim |

No unresolved critical/high finding is knowingly left in the inactive reviewed source. TF10 blocks durable/streaming readiness and is not excused by unit tests. The review does not authorise broadening generic shared quote admission or execution rules.

## Verification evidence

Original reported counts independently confirmed at source inspection: 14 breaker tests and 10 feed tests in `0cc864c`. The corrected branch adds regressions. Exact executed commands:

```text
pnpm vitest run packages/market-data/src/provider-circuit.test.ts packages/market-data/src/gold-shadow-feed.test.ts packages/market-data/src/providers/horizon-providers.test.ts
pnpm exec tsc -b packages/market-data --pretty false
pnpm exec eslint packages/market-data/src/gold-shadow-feed.ts packages/market-data/src/gold-shadow-feed.test.ts packages/market-data/src/provider-circuit.ts packages/market-data/src/provider-circuit.test.ts packages/market-data/src/providers/oanda-practice.ts packages/market-data/src/providers/horizon-providers.test.ts
git diff --check
```

An initial `tsc` failed because a new worktree lacked package-level dependency links. After junctions to the existing root installation, package compilation passed; no dependency upgrade was made. Initial timeout retry test failed because two microtasks did not settle the intentionally abandoned promise; awaiting fake-timer microtask drainage corrected the deterministic test. This did not relax production timeout logic.

Final corrected-source run: 53 tests passed across three files (17 breaker,16 feed,20 provider), no skip, in 21.66 seconds. Package compilation, targeted six-file ESLint and diff whitespace check all passed. Source correction commit: `e544085` on `aurum/titanium-feed-review`, parent `0cc864c`. Tests use injected clocks, synthetic pricing and test-only credentials, not actual provider traffic. Final combined integration verification and independent post-fix review remain root responsibilities.

## Boundaries

The breaker remains process-local. A fresh process has no old promises, but it does not restore prior outage/backoff state; no production restart durability claim is made. Callers resetting an active breaker must use resetCircuit, not replace it with initialCircuit while callbacks exist. Feed serialization supplies the required single-result-per-key discipline. Clock-source validity and typed fetch payload contracts are dependency requirements; untrusted raw provider payloads must pass the adapter parser.

No persistent quote sink, worker scheduling, empirical spread distribution, streaming entitlement proof, current account connectivity, historical refresh or production activation was demonstrated. The additive quote/run/bucket schema, immutable research snapshot design and bounded resource approval are the explicit remaining persistence boundary in FEED.md. Protected C2/C3/C10 plus research/trial accounting remain independent execution blockers.

