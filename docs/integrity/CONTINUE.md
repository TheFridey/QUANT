# OPERATION INTEGRITY — continuation

Ledger: [`STATUS.md`](STATUS.md). Instructions: `AGENTS.md`, `CLAUDE.md` (protected paths are hook-guarded; never create the unlock file).

## Where things stand

- Base: `origin/main` = `6eaac8e`.
- `integrity/f02-redis-revocation`: F02 fix + docs (this branch).

## Exact next action

1. Finish F02 checkpoint: full `pnpm vitest run`, `pnpm typecheck`, `pnpm lint`; commit; push branch and open a draft PR (no merge).
2. Start F05 on a new branch from `origin/main`: `integrity/f05-restore-target`. Retire `scripts/backup-restore-nonprod.mjs` in favour of `scripts/restore-verify.mjs` (reuse its `parseConnection`).

## Environment notes

- Windows checkout with `core.autocrlf=true`: `.mjs` scripts with a shebang fail to import under Vitest (CRLF). Not a code failure; CI is Linux.
- Docker is not running; no local Postgres/Redis. DB integration tests skip.
