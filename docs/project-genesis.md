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
