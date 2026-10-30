import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Regression table for the Claude Code PreToolUse guard. It runs the hook as Claude Code
// does (JSON on stdin) against a synthetic project root, so it never touches real files.
const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), "protect-trading-paths.mjs");

type Decision = "allow" | "ask" | "deny";
type ToolCall = { tool_name: string; tool_input: Record<string, unknown> };

let root: string;

function run(call: ToolCall, cwd = root): Decision {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd, ...call }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    encoding: "utf8",
  });
  expect(r.status).toBe(0);
  if (!r.stdout) return "allow";
  return JSON.parse(r.stdout).hookSpecificOutput.permissionDecision as Decision;
}

const E = (p: string, extra: Record<string, unknown> = {}): ToolCall => ({
  tool_name: "Edit",
  tool_input: { file_path: p, old_string: "a", new_string: "b", ...extra },
});
const B = (command: string, tool = "Bash"): ToolCall => ({ tool_name: tool, tool_input: { command } });

const lockedCases: [Decision, string, () => ToolCall][] = [
  // Edit tools on protected paths
  ["deny", "risk-engine (absolute)", () => E(`${root}/packages/risk-engine/src/index.ts`)],
  ["deny", "trading-engine (backslashes)", () => E(`${root}\\packages\\trading-engine\\src\\exit-rules.ts`)],
  ["deny", "execution gate", () => E("packages/shared/src/execution-gate.ts")],
  ["deny", "strategy defaults", () => E("packages/shared/src/strategy.ts")],
  ["deny", "practice venue", () => E("packages/market-data/src/alpaca-practice-venue.ts")],
  ["deny", "execution gateway", () => E("packages/market-data/src/execution-gateway.ts")],
  ["deny", "promotion", () => E("packages/evolution/src/promotion.ts")],
  ["deny", "CI workflow", () => E(".github/workflows/ci.yml")],
  ["deny", "guard settings", () => E(".claude/settings.json")],
  ["deny", "unlock marker", () => E(".claude/protected-edits.unlock")],
  ["deny", "Write new file in risk-engine", () => ({ tool_name: "Write", tool_input: { file_path: `${root}/packages/risk-engine/src/new.ts`, content: "x" } })],
  ["deny", "live-money flag in code", () => E("apps/api/src/x.ts", { new_string: "LIVE_MONEY_ENABLED=true" })],
  ["deny", "mixed case path", () => E(`${root}/Packages/Risk-Engine/src/index.ts`)],
  ["deny", "upper case path", () => E("PACKAGES\\SHARED\\SRC\\EXECUTION-GATE.TS")],
  ["deny", "trailing dot segment", () => E("packages/risk-engine./src/index.ts")],
  ["deny", "NTFS stream suffix", () => E("packages/shared/src/strategy.ts::$DATA")],
  ["deny", "trailing dot and space", () => E("packages/shared/src/strategy.ts. ")],
  ["deny", "unlock marker, mixed case", () => E(".Claude/Protected-Edits.Unlock")],
  ["deny", "UNC path", () => E("\\\\localhost\\D$\\Projects\\QUANT\\packages\\risk-engine\\src\\index.ts")],
  ["deny", "device path", () => E("\\\\?\\D:\\Projects\\QUANT\\packages\\risk-engine\\src\\index.ts")],
  ["deny", "forward-slash UNC", () => E("//localhost/D$/Projects/QUANT/packages/risk-engine/src/index.ts")],
  ["deny", "malformed file_path fails closed", () => ({ tool_name: "Edit", tool_input: { file_path: 42 } })],
  ["deny", "missing command fails closed", () => ({ tool_name: "Bash", tool_input: {} })],
  ["deny", "bad edits type still checks text", () => ({ tool_name: "Edit", tool_input: { file_path: "apps/x.ts", edits: "nope", new_string: "LIVE_MONEY_ENABLED=true" } })],
  // Edit tools on routine paths
  ["allow", "shared clock", () => E("packages/shared/src/clock.ts")],
  ["allow", "web page", () => E("apps/web/app/page.tsx")],
  ["allow", "non-execution market data", () => E("packages/market-data/src/dexscreener.ts")],
  ["allow", "live-money text in docs", () => E("docs/launch/RUNBOOKS.md", { new_string: "LIVE_MONEY_CONFIRM=I_UNDERSTAND_LIVE_RISK" })],
  ["allow", "path outside project", () => E("C:/elsewhere/packages/risk-engine/x.ts")],
  // Shell writes to protected paths
  ["deny", "sed -i", () => B("sed -i 's/0.5/5/' packages/risk-engine/src/evaluate.ts")],
  ["deny", "redirect", () => B("echo x > packages/trading-engine/src/a.ts")],
  ["deny", "Set-Content", () => B("Set-Content packages\\risk-engine\\src\\evaluate.ts 'x'", "PowerShell")],
  ["deny", "git checkout --", () => B("git checkout -- packages/risk-engine/src/evaluate.ts")],
  ["deny", "node writeFileSync", () => B("node -e \"require('fs').writeFileSync('packages/shared/src/execution-gate.ts','')\"")],
  ["deny", "export LIVE_MONEY_ENABLED", () => B("export LIVE_MONEY_ENABLED=true && pnpm dev")],
  ["deny", "PowerShell EXECUTION_MODE=LIVE", () => B('$env:EXECUTION_MODE="LIVE"; pnpm dev', "PowerShell")],
  ["deny", "touch unlock marker", () => B("touch .claude/protected-edits.unlock")],
  ["deny", "read unlock marker", () => B("cat .claude/protected-edits.unlock")],
  ["deny", "sc alias", () => B("sc packages/risk-engine/src/evaluate.ts x", "PowerShell")],
  ["deny", "ni into hooks", () => B("ni .claude/hooks/x.mjs", "PowerShell")],
  ["deny", "copy", () => B("copy evil.ts packages\\trading-engine\\src\\a.ts")],
  ["deny", "glob to marker", () => B("cp x .claude/prot*")],
  ["deny", "glob to risk-*", () => B("sed -i 's/a/b/' packages/risk-*/src/evaluate.ts")],
  ["deny", "glob packages/*", () => B("cp x packages/*/src/execution-gate.ts")],
  ["deny", "variable prefix", () => B('cp x "$P/packages/risk-engine/src/a.ts"')],
  ["deny", "cd into .claude", () => B("cd .claude && echo x > hooks/a.mjs")],
  ["deny", "quoted .claude", () => B('cd ".cla"ude; Remove-Item hooks', "PowerShell")],
  ["deny", "fsutil hardlink", () => B("fsutil hardlink create x.ts packages\\risk-engine\\src\\evaluate.ts")],
  ["deny", "copyFileSync", () => B("node -e \"require('fs').copyFileSync('x','packages/risk-engine/src/a.ts')\"")],
  ["deny", "unknown tool on protected path", () => B("python script.py packages/risk-engine/src/evaluate.ts")],
  ["deny", "unknown tool in pipe", () => B("cat x | some-tool packages/trading-engine/src/a.ts")],
  ["deny", "background &", () => B("cat packages/risk-engine/src/a.ts & python w.py")],
  ["deny", "command substitution", () => B("cat $(python w.py packages/risk-engine/src/a.ts)")],
  ["deny", "backticks", () => B("cat `node w.js` packages/risk-engine/src/a.ts")],
  ["deny", "subshell", () => B("(cat x; node w.js) packages/risk-engine/src/a.ts")],
  ["deny", "PowerShell call operator", () => B("& ./w.ps1 packages/risk-engine/src/a.ts", "PowerShell")],
  ["deny", "PowerShell dot-source", () => B(". ./w.ps1 packages\\risk-engine\\src\\a.ts", "PowerShell")],
  ["deny", "python open w", () => B("python -c \"open('packages/risk-engine/src/a.ts','w')\"")],
  ["deny", "sort -o", () => B("sort -o packages/risk-engine/src/a.ts x")],
  ["deny", "uniq output", () => B("uniq x packages/risk-engine/src/a.ts")],
  ["deny", "eslint --fix", () => B("npx eslint --fix packages/risk-engine/src")],
  ["deny", "git diff --output", () => B("git diff --output=packages/risk-engine/src/a.ts")],
  ["deny", "vitest -u", () => B("pnpm vitest run -u packages/risk-engine/src/evaluate.test.ts")],
  ["deny", "sed -n w", () => B("sed -n 'w packages/risk-engine/src/a.ts' x")],
  ["deny", "quoted -u", () => B('pnpm vitest run "-u" packages/risk-engine/src/evaluate.test.ts')],
  ["deny", "quoted --update", () => B("pnpm vitest run '--update' packages/risk-engine/src/evaluate.test.ts")],
  ["deny", "--outputFile", () => B("pnpm vitest run --outputFile=packages/risk-engine/src/a.ts")],
  ["deny", "--coverage", () => B("pnpm vitest run --coverage packages/risk-engine")],
  ["deny", "combined -uU", () => B("pnpm vitest run -uU packages/risk-engine/src/x.test.ts")],
  ["deny", "--config", () => B("pnpm test --config evil.ts packages/risk-engine")],
  ["deny", "less (shell escape)", () => B("less packages/risk-engine/src/evaluate.ts")],
  ["deny", "git log --output", () => B("git log --output=packages/risk-engine/src/a.ts")],
  ["deny", "ANSI-C quoted flag", () => B("pnpm vitest run $'\\x2du' packages/risk-engine/src/x.test.ts")],
  ["deny", "variable flag", () => B("pnpm vitest run $FLAG packages/risk-engine/src/x.test.ts")],
  // Routine shell work stays unblocked
  ["allow", "cat", () => B("cat packages/risk-engine/src/evaluate.ts")],
  ["allow", "grep with stderr to null", () => B("grep -n maxRisk packages/risk-engine/src/evaluate.ts 2>/dev/null")],
  ["allow", "targeted vitest", () => B("pnpm vitest run packages/risk-engine/src/evaluate.test.ts 2>&1 | tail -20")],
  ["allow", "git diff", () => B("git diff packages/risk-engine")],
  ["allow", "redirect elsewhere", () => B("echo hi > /tmp/x.txt")],
  ["allow", "pnpm test", () => B("pnpm test")],
  ["allow", "head | grep", () => B("head -20 packages/risk-engine/src/evaluate.ts | grep max")],
  ["allow", "git log && git diff", () => B("git log --oneline -5 -- packages/risk-engine && git diff packages/trading-engine")],
  ["allow", "plain vitest", () => B("pnpm vitest run packages/risk-engine/src/evaluate.test.ts")],
  ["allow", "Get-Content | Select-Object", () => B("Get-Content packages\\risk-engine\\src\\evaluate.ts | Select-Object -First 5", "PowerShell")],
  ["allow", "Get-Content 2>$null", () => B("Get-Content packages\\risk-engine\\src\\evaluate.ts 2>$null | Select-Object -First 5", "PowerShell")],
  ["allow", "grep -rn 2>&1 | head", () => B("grep -rn maxRisk packages/risk-engine/src 2>&1 | head -5")],
  ["allow", "git log --oneline", () => B("git log --oneline -5 -- packages/risk-engine")],
  ["allow", "ls glob", () => B("ls packages/*/src")],
  ["allow", "rm build output", () => B("rm -rf apps/web/.next")],
];

describe("protect-trading-paths hook", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "quant-guard-"));
    mkdirSync(join(root, ".claude"), { recursive: true });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  describe("locked (default)", () => {
    it.each(lockedCases)("%s: %s", (want, _label, call) => {
      expect(run(call())).toBe(want);
    });
  });

  describe("unlocked by operator marker", () => {
    beforeAll(() => writeFileSync(join(root, ".claude", "protected-edits.unlock"), ""));
    afterAll(() => rmSync(join(root, ".claude", "protected-edits.unlock"), { force: true }));

    it("protected edit falls back to ask", () => {
      expect(run(E("packages/risk-engine/src/a.ts"))).toBe("ask");
    });
    it("protected shell write falls back to ask", () => {
      expect(run(B("sed -i s/a/b/ packages/risk-engine/src/a.ts"))).toBe("ask");
    });
    it("live-money command is still denied", () => {
      expect(run(B("export LIVE_MONEY_ENABLED=true"))).toBe("deny");
    });
    it("guard config is still not writable from a shell", () => {
      expect(run(B("echo x > .claude/settings.json"))).toBe("deny");
    });
  });

  it("malformed stdin fails closed", () => {
    const r = spawnSync(process.execPath, [HOOK], { input: "not json", env: { ...process.env, CLAUDE_PROJECT_DIR: root }, encoding: "utf8" });
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("tolerates a UTF-8 BOM on stdin", () => {
    const r = spawnSync(process.execPath, [HOOK], {
      input: "\uFEFF" + JSON.stringify({ cwd: root, ...E("apps/web/x.ts") }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      encoding: "utf8",
    });
    expect(r.stdout).toBe("");
  });
});
