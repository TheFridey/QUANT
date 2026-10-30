// PreToolUse guard for safety-critical QUANT paths. Deterministic, works in every
// permission mode (including auto, where `ask` rules are not a reliable barrier).
//
// Locked (default): edits to protected paths are denied, whether through the edit
// tools or recognisable shell writes. Commands that turn on live money are always denied.
// Unlocked: the operator creates `.claude/protected-edits.unlock` by hand; protected
// edits then fall back to an approval prompt. Claude may never create that file.
//
// Limits: shell detection is pattern-based and cannot see writes made by a script whose
// source is not on the command line. CI, tests and the quant-safety-reviewer remain the
// other layers.
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

const PROTECTED = [
  /^packages\/risk-engine\//,
  /^packages\/trading-engine\//,
  /^packages\/shared\/src\/execution-gate\.ts$/,
  /^packages\/shared\/src\/strategy\.ts$/,
  /^packages\/market-data\/src\/[^/]*(venue|broker)[^/]*$/,
  /^packages\/market-data\/src\/execution-[^/]*$/,
  /^packages\/evolution\/src\/promotion\.ts$/,
  /^\.github\/workflows\//,
  /^\.claude\/(settings(\.local)?\.json|hooks\/|protected-edits\.unlock)/,
];
// Same paths as fragments, for spotting them inside shell commands.
const PROTECTED_IN_COMMAND =
  /(packages[\\/]+risk-engine[\\/]|packages[\\/]+trading-engine[\\/]|execution-gate\.ts|packages[\\/]+shared[\\/]+src[\\/]+strategy\.ts|market-data[\\/]+src[\\/]+[^\s'"]*(venue|broker|execution-)|evolution[\\/]+src[\\/]+promotion\.ts|\.github[\\/]+workflows|\.claude[\\/]+(settings|hooks|protected-edits))/i;
const SHELL_WRITE =
  /(\bsed\b[^|;&]*\s-[a-z]*i|\bperl\b[^|;&]*\s-[a-z]*i|>|\btee\b|\b(Set|Add|Clear)-Content\b|\bOut-File\b|\b(New|Remove|Move|Copy|Rename)-Item\b|\b(rm|mv|cp|truncate|dd|touch|patch|install)\b|\bgit\s+(checkout|restore|apply|am|stash|reset|mv|rm|clean)\b|write(File|AllText|AllBytes)?(Sync)?\s*\(|appendFile|\[IO\.File\]|open\([^)]*['"][wa+])/i;
const STDERR_OR_NULL_REDIRECT = /\d?>\s*(&\d|\/dev\/null|\$null|nul\b)/gi;
const LIVE_MONEY =
  /(LIVE_MONEY_CONFIRM|I_UNDERSTAND_LIVE_RISK|LIVE_MONEY_ENABLED\s*[=:]\s*['"]?true|EXECUTION_MODE\s*[=:]\s*['"]?(LIVE|SANDBOX))/i;

function decide(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason },
  }));
  process.exit(0);
}

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const unlocked = existsSync(join(root, '.claude', 'protected-edits.unlock'));
const ti = input.tool_input || {};
const lockedMsg =
  'QUANT protected path. Changes here need explicit operator approval: the operator must create .claude/protected-edits.unlock by hand (Claude must not), then re-run.';

if (input.tool_name === 'Bash' || input.tool_name === 'PowerShell') {
  const cmd = String(ti.command || '');
  if (LIVE_MONEY.test(cmd)) decide('deny', 'Command touches live-money switches (LIVE_MONEY_* / EXECUTION_MODE). Operator must do this manually.');
  if (/protected-edits\.unlock/i.test(cmd) && SHELL_WRITE.test(cmd)) decide('deny', 'Only the operator may create or change the unlock marker.');
  if (PROTECTED_IN_COMMAND.test(cmd) && SHELL_WRITE.test(cmd.replace(STDERR_OR_NULL_REDIRECT, ''))) {
    decide(unlocked ? 'ask' : 'deny', unlocked ? 'Shell write to a QUANT protected path (unlocked): confirm.' : lockedMsg);
  }
  process.exit(0);
}

const filePath = ti.file_path || ti.notebook_path;
if (!filePath) process.exit(0);
const abs = isAbsolute(filePath) ? filePath : join(input.cwd || root, filePath);
const rel = relative(root, abs).replace(/\\/g, '/');
if (rel.startsWith('..')) process.exit(0);

const newText = [ti.new_string, ti.content, ti.new_source, ...(ti.edits || []).map((e) => e.new_string)].filter(Boolean).join('\n');
if (LIVE_MONEY.test(newText) && !/\.example$|\.md$|\.test\.ts$/.test(rel)) {
  decide('deny', 'Edit would enable or configure live money. Operator must do this manually.');
}
if (/^\.claude\/protected-edits\.unlock$/.test(rel)) decide('deny', 'Only the operator may create or change the unlock marker.');
if (PROTECTED.some((re) => re.test(rel))) {
  decide(unlocked ? 'ask' : 'deny', unlocked ? `Edit to QUANT protected path ${rel} (unlocked): confirm.` : `${lockedMsg} (${rel})`);
}
process.exit(0);
