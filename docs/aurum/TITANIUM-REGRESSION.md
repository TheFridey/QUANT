# TITANIUM verification and safety review ledger

17 November 2026. IN PROGRESS; results below are scoped to their exact checkout and command. Production remains UNVERIFIED and unchanged by this operation.

## Historical baseline independently verified

PR #82 merged as aec2a80cbc6ca34ef4a32f267d04adbf938e128d. GitHub run 44083988025 succeeded in all three jobs. Job log summary: 238 files, 1,663 tests passed, one skipped. Independent extraction of 34 integration-project file summaries totals 177 tests (including singular `1 test` lines). Browser job reports 14 passed. These are historical CI results, not TITANIUM integration results.

## GENESIS investigation

Separate database `odin_test_titanium_regression`, existing loopback container quant-aurum-odin-test, PostgreSQL 16.13. Applied repository migration SQL in sorted migration order using psql ON_ERROR_STOP; exit 0. No protected migration was edited. This direct disposable setup does not create a Prisma migration-history ledger and is not a production deployment procedure.

Environment isolation: temporary preload outside repository replaces `process.loadEnvFile` with a no-op. NODE_OPTIONS points to it. DATABASE_URL and DATABASE_URL_TEST explicitly point to the separate loopback odin_test database; EXECUTION_MODE=PAPER. No environment-file values printed. Earlier reviewer pure-function runs used standard setup before the autoload was discovered; no DB/provider test was invoked by those pure suites. Future integration runs use isolated variables/preload.

Initial root GENESIS run began while migration was incomplete and failed four missing-ModelVersion-table checks. This was an orchestration error, not evidence of the reported timeout. Once migration completed:

`pnpm vitest run packages/evolution/src/genesis/registry-shadow.integration.test.ts` — 4/4 passed, exit 0, 28.63s overall, 13.229s test execution. Individual registry cases 895ms/1,508ms/1,108ms; shadow cycle 7,877ms includes explicit clock-boundary waits. No transaction timeout changed.

Normal-concurrency `pnpm test` was interrupted after resource pressure: free physical memory approximately 1 GB of 16 GB and an unrelated auth source/import test reported 55.375s against its 20s limit. Concurrent verification jobs were stopped; bounded rerun uses `pnpm vitest run --maxWorkers=2` with unchanged test/transaction timeouts. At sampled instants PostgreSQL had zero ungranted locks. Migration progress repeatedly showed IO/WALSync waits; track_wal_io_timing was off, so sync duration cannot be quantified from pg_stat_wal. Container has no explicit CPU/memory limit (Docker inspect NanoCpus=0/Memory=0), Docker guest budget about 7.54 GiB. These observations support resource-pressure investigation but do not prove the historical five-second failure's cause. Classification remains UNRESOLVED pending repeated/full/sequential evidence.

Registry source `packages/evolution/src/genesis/model-registry.ts:registerModel` prepares/validates artefact before transaction, then inserts ModelVersion and its initial lifecycle event atomically. It does not need a timeout increase based solely on one unrepeatable report. No application change made there.

## Root independent financial re-review

Inspected complete parser, product maths, configured wrapper and tests after reviewer corrections. APPROVE for inactive pure-function integration: bounded Decimal(24,8) inputs; separate 80-digit context; conservative stake/grid/penny checks; derived Decimal(24,2) overflow refusal; configured margin override honoured; requestedRiskFraction above configuration explicitly refused. LONG/SHORT sides and gap semantics preserved. Tests do not establish financial settlement or authority of caller-supplied configuration; C3/C10 remain blockers. The reported removal of an uncommitted extreme-value test cannot be attributed from committed git evidence.

## Root independent feed re-review

Inspected correction e544085 and full provider-circuit/gold-shadow source. APPROVE for inactive integration: mandatory matching generation token; each completion consumes generation; reset invalidates callbacks; OPEN stale completions cannot clear newer state; serialized feed uses abortable timeout and suppresses late completion; actual settlement releases the slot so ignored abort cannot accumulate overlapping calls. Future timestamps do not become watermark, outputs are deep copied, unknown tradeability fails quality, transport errors expose codes only. Read-only adapter change passes signal into GET/body consumption; order-capable provider untouched.

Notes: process-local circuit state is not durable; first completion consumes shared CLOSED generation, so general callers must serialize per key. Typed adapter payload/clock validity remains a dependency contract. Original millisecond timestamp/quote identity is insufficient for tick-complete streaming; persistence proposal requires raw timestamp identity. Feed has no worker schedule, persistent sink or authority to execute.

## Independent API/design review

Separate reviewer inspected readiness controller and global JWT guard registration: no critical/high runtime finding, no DB/provider/write calls. Live HTTP behaviour not yet tested. C3/C10 design review findings corrected: exact existing action/state enums, nullable prefill price, explicit membership FKs, precise legacy/global stop migration semantics and immutable simulation-quote FK. Retirement function is a structural proposal validator, not fresh account-scoped proof.

## Still required

## Root independent storage quarantine re-review

Inspected 1733ebf and the complete restore/CLI/boundary source after requesting second-read checksum and aggregate bounds. APPROVE only the quarantined, inactive storage integration: archive/delete execution body removed; no caller-injected approval, real list empty, unconditional durable-audit refusal after approval check. Restore requires explicit loopback odin_test URL and matching current_database(); exact restored bytes are rehashed before bounded decompression, before DB writes; requested run identity, table policy, actual key order/ranges/dedup and chunk/resource envelopes validated. CLI no longer autoloads environment. Original 34c05f2 is rejected for direct operational integration.

This is not acceptance of archive/delete operation or production restore. Underlying deletion findings are DEFERRED/BLOCKED protected audit/transaction design and unreachable in the integrated quarantine. Local mutable filesystem threat model remains a limitation; same-host path checks are not an adversarial production archive trust boundary. Successful synthetic fixture export/restore cannot stand in for a deletion crash-recovery proof.

Build finding resolved operationally by additive `build:tsc` scripts for API/worker and root `build:portable`; default Linux/CI build unchanged. Both installed CLI and core exist. A safe new cache leaf cannot repair insecure ancestor ACLs on this host, and supported temporary native-cache mode also refuses. No global ACL or native-loader security weakened; no dependency/lockfile upgrade. Next uses a separate binding that loads; actual Next build still required.

## Outstanding verification

Post-fix storage review, integration in dependency order, combined targeted/full tests, repeat GENESIS, sequential comparison, lint/typecheck/build and actual worker/browser evidence where the local environment supports it. Record commands and outcomes before closing this checkpoint. No incomplete check is a pass.
