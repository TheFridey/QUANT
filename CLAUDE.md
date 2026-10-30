@AGENTS.md

## Claude Code specifics

- Edits to the high-risk paths listed in AGENTS.md are denied by `.claude/hooks/protect-trading-paths.mjs` (edit tools and shell writes, in every permission mode) until the operator creates `.claude/protected-edits.unlock` by hand; they then require approval. Never create that file, edit the hook or settings, or work around the guard with scripts. If blocked, stop and tell the operator what change you need and why.
- Before reporting any high-risk change done, run the `quant-safety-reviewer` agent on the diff and include its verdict.
