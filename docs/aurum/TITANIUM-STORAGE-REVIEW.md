# TITANIUM independent storage review

Review date: 17 November 2026. Reviewed commit `34c05f2` on `aurum/01-storage`, against local main `dc24992`. Original branch preserved. Review checkout: `D:/Projects/QUANT-titanium-storage`, branch `aurum/titanium-storage-review`.

**Disposition: REJECT for integration/activation pending the high findings below.** No production connection, deletion, schema edit, approved-policy-list change or unlock-marker use occurred. Repository review is evidence of implementation, not proof of production safety.

## Verified safeguards

VERIFIED_REPOSITORY: `retention-policy.ts` defines `APPROVED_RETENTION_POLICY_HASHES = Object.freeze([])`. The CLI does not supply the executor's optional alternate allowlist. Normal CLI deletion therefore refuses all policies. `validatePolicy` and `executablePolicies` independently keep MarketObservation non-executable. SQL revalidates source content and the listed evidence dependencies at deletion statement time. The archive contains exact PostgreSQL `to_jsonb(row)::text`, with gzip checksum/size readback. Restore uses conflict preservation and content comparison rather than overwriting existing rows.

## Findings

Line references below refer to the reviewed commit under `apps/worker/src/ops/`.
The finding reproductions are adversarial reproduction recipes derived from source inspection unless explicitly labelled VERIFIED_TEST. The review did not execute destructive fault scenarios against the original unsafe executor; those scenarios remain unverified runtime hypotheses and blockers for an operational implementation.

### TS01 — HIGH — lock check and mutation use different sessions (OPEN)

- Evidence: `retention-prisma.ts:23-45`, `retention-executor.ts:308-310,363-365`. Holder owns a session advisory lock; observer checks it; another connection executes autocommit DELETE.
- Reproduction: have `heldBy()` return true, terminate the holder before the subsequent database query, start another executor, then allow the first DELETE. Both mutations can proceed. Existing concurrent-runner tests test acquisition, not this check/use interval.
- Consequence: the claimed single-runner fencing does not cover the operation it protects; concurrent manifest/cursor updates and restore interference remain possible.
- Correction: execute deletion and durable audit under the same transaction/session holding a transaction advisory lock, with a durable fencing token. Resume and restore must use the same protocol. Mere extra observer checks do not remove the race.
- Regression: terminate the backend at every handoff; prove no mutation by an obsolete token and one committed audit transition per batch.

### TS02 — HIGH — no durable deletion or restoration audit (BLOCKED_APPROVAL)

- Evidence: `retention-executor.ts:205-223,365-372,447-469`. Pending reconciliation assumes every missing source row was deleted by this run. Restore records no database or manifest restoration state and can partially commit before reporting failure.
- Reproduction: interrupt after DELETE, change/move the filesystem manifest, or interrupt restore after the first chunk. The database cannot identify the run that deleted/restored a row or distinguish committed and interrupted operations. Independently remove one pending source row; resume attributes it to this run.
- Consequence: filesystem-only status cannot authoritatively distinguish archived, verified, deletion pending/committed, restoration pending/complete, interrupted and failed. Copying an old manifest reverses apparent history without reversing the database.
- Correction: additive RetentionRun/RetentionBatch and append-only event records, with transactional row counts, hashes, policy/config/schema identity and database target identity. Approval scope below; no schema implementation authorised.
- Regression: process kill after each DB/filesystem transition, stale manifest replay, interrupted restore and independent row removal, with audit reconciliation checked against committed transactions.

### TS03 — HIGH — archive replacement can follow verification (OPEN)

- Evidence: `retention-executor.ts:92-115,337-365`; archive verification precedes the `beforeDelete` hook and DELETE; file paths are reopened, no immutable file ownership/identity contract exists. `atomicWrite` opens predictable temp names with `w`, follows symlinks and suppresses every directory-fsync failure.
- Reproduction: in `beforeDelete`, replace a published `.jsonl.gz` file with corrupt bytes, then return normally. DELETE uses in-memory source documents and proceeds; the surviving archive is corrupt. A pre-planted temp symlink can redirect a write. A directory-fsync I/O failure on Linux is swallowed like an unsupported Windows call.
- Consequence: source deletion can outlive its recoverable archive. Checksums in a writable manifest do not authenticate contents against an actor able to replace both.
- Correction: define an exclusive owner/private archive-root threat model, reject symlinks/reparse points, exclusive unpredictable temporary files, checked complete writes and platform-specific directory fsync handling; verify immutable archive identity under the same audited deletion protocol. Require independently verified off-host backup before approval.
- Regression: replacement/symlink attempts, short writes, file and directory fsync failures, and corruption immediately before deletion must leave source rows intact.

### TS04 — HIGH — production targeting and alternate allowlist not isolated (OPEN)

- Evidence: `retention-cli.ts:1,59-63,112-126`; it imports automatic `.env` loading and accepts any DATABASE_URL for restore. `retention-executor.ts:63,227` accepts caller-provided approved hashes without validating an isolated test database.
- Reproduction: provide any non-test database URL and a valid archive to `restore`; it attempts writes without an explicit target acknowledgement or local-only guard. A programmatic caller can pass `[policyHash(policy)]` directly and bypass the empty production approval list.
- Consequence: empty CLI policy approval prevents normal execute deletion but is not an enforced library-wide production prohibition; restore has no equivalent gate.
- Correction: remove automatic environment-file loading from this administrative CLI, require explicit validated target identity, constrain injectable approval to an actual isolated test adapter/environment, and require separately reviewed restore authorisation. No production target was used to reproduce.
- Regression: reject remote/non-test targets before constructing a client; reject an alternate allowlist on a non-test adapter; check credentials never enter logs.

### TS05 — HIGH — backup and capacity guards overclaim verification (OPEN)

- Evidence: `retention-executor.ts:164-170,280-300,315-325`. Backup validity means only file exists, nonempty and recent. Disk measured once on archive destination, not separately database/WAL volumes. Resume replays pending deletes before recording WAL baseline. Per-batch WAL may exceed the remaining budget; infinity is accepted for several numeric controls.
- Reproduction: a recent file containing `backup` passes the guard (also the integration fixture). Supply a different roomy archive volume while the database/WAL volume is full. Resume a pending delete with a tiny WAL budget: reconciliation runs before the budget baseline. Set maxWalBytes to Infinity in the library.
- Consequence: no restore-verified backup assurance; database volume exhaustion is not prevented by archive-volume free space. Resume work is excluded from reported WAL usage.
- Correction: verified backup metadata and restore proof; explicit DB/WAL/archive-volume identities and free-space checks; baseline before any mutation; finite bounded inputs and a conservative per-batch budget. Do not invent an off-host provider.
- Regression: invalid/future-dated backup evidence, split volumes, exhausted WAL disk, resumed pending batches and nonfinite numeric inputs.

### TS06 — HIGH — dependency recheck is snapshot-local (OPEN)

- Evidence: `retention-policy.ts:207-214` DELETE uses NOT EXISTS on evidence tables without a shared protocol with their writers. Cycle relationships use string identities rather than all being FK-enforced.
- Reproduction design: start DELETE snapshot, insert an Order/TradeIntent/EquitySnapshot for that cycle concurrently, then commit both. New evidence can refer to a cycle whose decisions/plan were deleted. This race has been identified statically; concurrent production-like reproduction is UNVERIFIED.
- Consequence: preservation cannot be asserted for concurrent or subsequently backfilled evidence merely from a one-statement recheck.
- Correction: establish immutable closed-cycle eligibility and a lock/constraint protocol shared with every evidence writer; until that is reviewed, keep deletion disabled. Any protected writer/schema changes require named approval.
- Regression: race every dependent insert with archival; replay/backfill a closed cycle; require either retention or a refused evidence mutation with explicit provenance.

### TS07 — MEDIUM — orphan archive publication prevents resume (OPEN)

- Evidence: `retention-executor.ts:335-359`. The archive is renamed before its batch entry reaches the manifest; existing filename causes ARCHIVE_FILE_EXISTS.
- Reproduction: kill after `atomicWrite(finalPath,gz)` and before `writeManifest`. Resume selects the same keys/sequence and refuses the existing file rather than reconciling it.
- Consequence: safely fails but is not restart-safe at this documented boundary; intervention is needed. No data deletion has yet occurred at that boundary.
- Correction/regression: audit-linked orphan adoption/quarantine after hash/content/source checks; process kill exactly after publication.

### TS08 — HIGH — manifest paths and structure are trusted (OPEN)

- Evidence: `retention-executor.ts:123-133,249,418,435`, `retention-policy.ts:285-327`; joins use unchecked run IDs/filenames and verification validates recorded ranges rather than actual decompressed key order/content. Restore accepts policy table definitions without calling validatePolicy or binding the supplied policy to its hash.
- Reproduction: a run ID `../other-run` or batch filename `../outside.jsonl.gz` leaves the intended root; a link redirects it further. A manifest with valid hash/bytes but false first/last keys passes range checks; duplicate keys inside gzip are not detected there. A compressed oversized file is fully inflated in memory.
- Consequence: unintended file reads/restore source, misleading overlap proof, resource exhaustion, and unreviewed restore policy SQL when a programmatic caller supplies it.
- Correction: strict schema/size validation, single-component IDs/files, canonical containment and link refusal, streaming bounded decompression, actual key/row/order verification, validated policy/hash binding.
- Regression: traversal on both path separators, links/junctions, malformed manifest, false ranges, duplicate row keys, gzip bomb and schema-version mismatch.

### TS09 — MEDIUM — CLI argument validation is permissive (OPEN)

- Evidence: `retention-cli.ts:23-40`; flags are looked up independently and missing values, duplicate flags and unknown arguments are not fully rejected.
- Reproduction: `plan --unknown anything` is accepted; `--max-batches 1 --max-batches 100` silently uses the first; a flag can become another flag's string value.
- Correction/regression: one strict command schema, unknown/duplicate/missing/integer-domain rejection before database construction, stable JSON error code and exit-status tests.

## Narrow additive audit approval package (prepared, not approved)

Request permission only to add `RetentionRun`, `RetentionBatch` and `RetentionAuditEvent` models plus one additive migration under `packages/shared/prisma/`; no existing financial/research row changes, policy activation, production migration, deletion or deployment.

- RetentionRun: UUID PK; unique run key; target database identity hash; policy hash; canonical policy JSON; schema version/migration hash; archive root identity; operator approval reference; fencing generation; timestamps; explicit state; failure reason; backup proof identity. No credentials/connection URLs.
- RetentionBatch: UUID PK; run FK; unique (runId, tableName, sequence); immutable archive URI relative to approved root, hash, compressed/uncompressed byte counts, actual first/last keys, exported row count; deletion committed count; retained count/reasons; restore count; transaction identity and timestamps. Unique archive identity within a run; CHECK nonnegative/count consistency. State transitions permitted only through reviewed transactional code.
- RetentionAuditEvent: append-only ID/run/batch FK, operation/idempotency key unique, prior/new state, actor/approval identity, fencing token, row counts and timestamps. No UPDATE/DELETE privileges/triggers permit loss of audit history.
- Deletion and DELETION_COMMITTED event share one PostgreSQL transaction and the holder lock; restoration chunk and corresponding event do likewise. Filesystem publication is recorded separately, with orphan/interruption reconciliation from committed audit state. A terminal success requires verified actual counts and hashes.
- Additive migration must pass migration-schema tests and real concurrency/crash/restore tests in `odin_test`; independent database and safety review required. Rollback after audit records exist is a forward repair, never DROP TABLE. No account creation or account ownership changes in this scope.

## Build/CLI evidence

VERIFIED_TEST: `pnpm --filter @odin/worker build` fails with Nest's generic missing-@swc message. Direct `require('@swc/cli')` and `require('@swc/core')` find the installed packages, then fail loading the native binding. Underlying loader causes explicitly report unsafe Windows cache-root DACLs and request a safe SWC_NATIVE_BINDING_CACHE. Installed versions are @swc/cli 0.7.10 and @swc/core 1.16.20; no missing-dependency or version-upgrade diagnosis is justified. No ACLs were weakened.

Disposable database `odin_test_titanium_storage` was created using the existing loopback-only PostgreSQL container, separately from the root regression database. `DATABASE_URL=<explicit local fixture target> pnpm db:deploy` applied all 31 existing migrations successfully. Offline frozen install in the review checkout was interrupted because package materialization was unusually slow; existing local dependency junctions were reused without changing lockfile or dependency versions.

VERIFIED_TEST: `pnpm --filter @odin/worker exec nest build --builder tsc` completed successfully on the root checkout. This is Nest's supported TypeScript compiler fallback, not proof the default SWC build works, and the root checkout then contained product work rather than the storage branch. The actual storage CLI was separately compiled from its real source using the installed TypeScript compiler with Node16 module resolution, ES2022, strict checking, existing worker Node types, and no environment-file loader. This targeted compile passed.

## Post-review correction and verification

The original executor is **quarantined**, rather than declared repaired. The unsafe archive/delete body was removed from the corrected branch; original source remains in commit `34c05f2`. The real empty approved-policy list is now authoritative; caller-injected approvals cannot enable deletion. Even a future populated list encounters `DELETION_BLOCKED_PENDING_DURABLE_AUDIT`. All original deletion safety findings TS01/02/03/05/06/07 remain prerequisites to designing and approving an operational executor; they are **MITIGATED_INACTIVE**, not VERIFIED fixes. The additive audit package above remains BLOCKED_APPROVAL.

CLI automatic environment loading was removed. Database commands require an explicit loopback URL whose actual path names `odin_test` or `odin_test_*`. Restore additionally checks `current_database()` equals the requested disposable database before inserting anything. Production restoration is deliberately unsupported. Unknown/duplicate/missing CLI flags are refused. Run IDs and files reject traversal, alternate streams, reserved Windows names, trailing dots and existing link/junction components. Restore binds policy/hash, validates actual key ranges/order/deduplication and chunk bounds, and rechecks the actual second-read archive bytes against the manifest immediately before decompression. Root independent post-fix review identified the second-read checksum omission and aggregate memory gap; both received corrections and dedicated regressions.

Disposable recovery resource envelope: manifest at most 2 MiB, at most 256 batches, each compressed file at most 8 MiB, aggregate compressed metadata at most 32 MiB, each inflated batch at most 16 MiB and aggregate inflated bytes less than 64 MiB. These are defensive tooling limits, not approved production retention thresholds. Larger archives require a future streaming design. CLI verify shares the bounded readers. Run identity must match the requested manifest. Mutable local archive storage remains unsuitable as a production recovery design; no such readiness is claimed.

Findings TS04/08/09 are **FIXED for the restricted disposable CLI scope**, with TS08's production threat model explicitly deferred. Deletion code cannot reach the defects and production restore is refused. Root independent post-fix review is required before integrating the quarantine correction. The original storage branch remains rejected for direct integration.

The original 11 archive/delete integration tests were superseded by current zero-resource quarantine tests. This is an intentional removal of an unsafe capability, not a claim those 11 behaviours now work. Current targeted tests cover policy preservation, traversal/links, non-test targeting, alternate-approval refusal, forged/duplicate keys, decompression bounds, target identity mismatch, archive replacement between reads, run identity and aggregate limits. `pnpm vitest run --maxWorkers=2 apps/worker/src/ops/retention-boundary.test.ts apps/worker/src/ops/retention-restore.test.ts apps/worker/src/ops/retention-policy.test.ts apps/worker/src/ops/retention-executor.integration.test.ts` passed all 24 tests in four files. Targeted ESLint over those tests and changed CLI/executor/boundary sources passed. Combined branch results belong in the execution ledger.

Actual CLI proof used a synthetic one-row AgentDecision archive in the disposable database. Fixture setup explicitly exported then removed only its synthetic fixture row; **the quarantined retention executor did not perform that deletion**. Running the actual compiled CLI demonstrated:

| Command/condition | Exit | Evidence |
| --- | --- | --- |
| plan | 0 | PLAN_READ_ONLY, deletionEnabled false; MarketObservation blocked |
| verify valid one-row gzip | 0 | ok true, rows 1 |
| execute without approval | 2 | POLICY_NOT_APPROVED |
| restore one row | 0 | inserted 1, verified 1 |
| restore again | 0 | inserted 0, skippedExisting 1, verified 1 |
| unknown flag | 1 | INVALID_RETENTION_ARGUMENTS |
| missing flag value | 1 | INVALID_RETENTION_ARGUMENTS |
| duplicate flag | 1 | INVALID_RETENTION_ARGUMENTS |
| nonlocal production-shaped target | 1 | RETENTION_REQUIRES_LOCAL_DISPOSABLE_DATABASE, before client construction |
| run traversal | 1 | UNSAFE_ARCHIVE_COMPONENT |
| corrupted archive | 2 | SIZE_MISMATCH |

Exact stdout/stderr/exit statuses are retained in `docs/aurum/evidence/titanium-storage-cli.json`. No original production backup, provider account, production database or environment-file values were inspected.
