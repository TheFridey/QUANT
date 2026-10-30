@AGENTS.md

## Claude Code specifics

- Edits to the high-risk paths listed in AGENTS.md prompt for approval (`.claude/settings.json` ask rules). Do not work around that prompt with shell edits (sed, Set-Content, scripts).
- Before reporting any high-risk change done, run the `quant-safety-reviewer` agent on the diff and include its verdict.
