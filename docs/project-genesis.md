# PROJECT GENESIS

Engineering record for the research-pipeline repair on the existing ODIN // QUANT repository. Times are Europe/London.

## Phase 1 — Repository health

Completed 2026-10-28 16:58.

CI run `40724329670` failed in `pnpm typecheck` with `TS2307` on `@odin/shared` inside `packages/analytics`. The workspace link is present in `pnpm-lock.yaml` (`@odin/analytics` → `link:../shared`). The same error reproduces for every Node16 package that imports `@odin/shared` before declarations exist. Analytics was the first dependent the CI log reported.

Root cause: `moduleResolution: Node16` resolves `@odin/shared` only through `package.json` `exports`, which point at `dist/*.d.ts`. `dist` is gitignored. `pnpm typecheck` previously ran `tsc --noEmit` and never produced those declarations. Vitest passed because it aliases workspace packages to source.

Fix: library packages are composite TypeScript projects. The root `tsconfig.json` references them in dependency order. `pnpm typecheck` and `pnpm build:packages` run `tsc -b`, which emits each package's declarations before dependents compile. Consumers keep resolving the published `exports` (declaration files), with `disableSourceOfProjectReferenceRedirect` so a dependency's source is not pulled into another package's `rootDir`.

Local verification against PostgreSQL `odin_test` and Redis on `127.0.0.1`:

- `pnpm install --frozen-lockfile` — exit 0
- `pnpm db:deploy` — 4 migrations applied
- `pnpm test` — 25 files, 73 tests passed
- `pnpm typecheck` — exit 0
- `pnpm lint` — exit 0

Remote CI on this branch is recorded after the push.

## Phase 2 — Forge execution

Completed 2026-10-28 17:13.

`loadSandboxedModule()` no longer runs a predetermined template. Generated TypeScript is checked by a static source gate (named as a static gate, not as isolation), compiled with the TypeScript compiler, and executed only in a separate bubblewrap process.

Runner configuration that was actually probed on this machine:

- Runtime: bubblewrap 0.9.0
- User namespace uid 65534
- Network namespace unshared (`ENETUNREACH` on connect)
- Root filesystem read-only, including the strategy workspace
- Host project directory and secrets are not mounted
- Environment cleared before the strategy runs
- tmpfs `/tmp` capped at 8 MiB
- `prlimit` nproc 16, nofile 32, cpu 3 seconds
- Node heap cap 64 MB
- Wall-clock kill, stdout cap 200 KB
- Dependencies allowlist is empty; the strategy receives only the harness input

The harness passes historical bars strictly before the decision bar and checks that the SHA-256 of the file it imports matches the compiled artifact hash. A logic change in `onBar` changes the returned intent. Template source is labelled `TEMPLATE`. Disabling isolation returns `ISOLATION_DISABLED` and `signalsClaimed: false`.

Runtime containment tests ran here and passed: host environment canary absent, workspace file read blocked, outbound connect blocked, infinite loop terminated, allocation terminated. CI installs `bubblewrap` so the same tests can run there. If `bwrap` is missing, execution stays disabled and those tests skip.

Local: `pnpm exec vitest run packages/evolution/src/forge.test.ts packages/evolution/src/pipeline.test.ts` — 11 passed. `pnpm typecheck` and `pnpm lint` passed after the change.
