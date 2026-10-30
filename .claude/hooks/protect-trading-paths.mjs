// PreToolUse guard for safety-critical QUANT paths. Deterministic, works in every
// permission mode (including auto, where `ask` rules are not a reliable barrier).
//
// Locked (default): edits to protected paths are denied, whether through the edit
// tools or recognisable shell writes. Commands that turn on live money are always denied.
// Unlocked: the operator creates `.claude/protected-edits.unlock` by hand; protected
// edits then fall back to an approval prompt. Claude may never create or mention that
// file in a shell command.
//
// Fails closed: malformed input or an internal error denies the tool call.
// Limits: this is a guardrail, not a sandbox. Shell detection is pattern-based and cannot
// see writes made by a script whose source is not on the command line. Review (the
// quant-safety-reviewer agent), tests/CI and the runtime execution gate remain separate layers.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const PROTECTED = [
  /^packages\/risk-engine\//i,
  /^packages\/trading-engine\//i,
  /^packages\/shared\/src\/execution-gate\.ts$/i,
  /^packages\/shared\/src\/strategy\.ts$/i,
  /^packages\/market-data\/src\/[^/]*(venue|broker)[^/]*$/i,
  /^packages\/market-data\/src\/execution-[^/]*$/i,
  /^packages\/evolution\/src\/promotion\.ts$/i,
  /^\.github\/workflows\//i,
  /^\.claude\/(settings(\.local)?\.json|hooks\/|protected-edits\.unlock)/i,
];
// Same paths as fragments, for spotting them inside shell commands.
const PROTECTED_IN_COMMAND =
  /(packages[\\/]+risk-engine|packages[\\/]+trading-engine|execution-gate|packages[\\/]+shared[\\/]+src[\\/]+strategy|market-data[\\/]+src[\\/]+[^\s'"]*(venue|broker|execution-)|promotion\.ts|\.github[\\/]+workflows|\.claude[\\/]+(settings|hooks))/i;
// Globs or variable expansion that could reach a protected path without naming it.
const INDIRECT_TARGET =
  /((risk|trading|execution|promotion|workflow|strategy|venue|broker|protected|unlock|\.claude|\.github)[^\s'"]*[*?[$]|packages[\\/]+[*?[$])/i;
// When a command names a protected path, every segment must start with one of these.
// Only tools that cannot write files; anything else naming a protected path is denied.
const READ_ONLY_SEGMENT =
  /^(cat|head|tail|less|grep|rg|egrep|ls|dir|wc|file|stat|diff|type|findstr|Get-Content|gc|Select-String|sls|Get-ChildItem|gci|Test-Path|Measure-Object|Select-Object|echo|printf|true|cd|pwd|cut|tr|jq|git (diff|log|show|status|blame|grep|ls-files)|pnpm (test|vitest run)|pnpm exec vitest run|npx vitest run|node --check|entire (status|search|recap|why))\b/i;
// Flags that make otherwise read-only tools write (output files, snapshot updates, autofix).
const WRITE_FLAG = /(^|\s)(--fix\b|--output\b|--out-?file\b|--outDir\b|--update\b|--pre\b|-o\b|-u\b|--ext-diff\b|--textconv\b)/i;
// Ways to run more than the visible segments: subshells, substitution, backgrounding, call/dot-source operators.
const COMPOUND = /(\$\(|<\(|>\(|`|[(){}]|(^|[^&|>0-9])&(?!&)|(^|[;|\s])\.\s|\binvoke-expression\b|\biex\b)/i;
const SHELL_WRITE = new RegExp(
  [
    String.raw`\bsed\b[^|;&]*\s-[a-z]*i`, String.raw`\bperl\b[^|;&]*\s-[a-z]*i`, '>', String.raw`\btee\b`,
    String.raw`\b(Set|Add|Clear)-Content\b`, String.raw`\bOut-File\b`, String.raw`\b(New|Remove|Move|Copy|Rename)-Item\b`,
    String.raw`\b(sc|ac|clc|ni|ri|mi|cpi|rni|si|del|erase|rd|rmdir|copy|move|ren|xcopy|robocopy|mklink)\b`,
    String.raw`\b(rm|mv|cp|ln|truncate|dd|touch|patch|install|unzip|tar)\b`,
    String.raw`\bgit\s+(checkout|restore|apply|am|stash|reset|mv|rm|clean|switch|merge|pull|cherry-pick|revert)\b`,
    String.raw`write(File|AllText|AllBytes|Text)?(Sync)?\s*\(`, 'appendFile', String.raw`\[IO\.File\]`,
    String.raw`open\([^)]*['"][wax+]`, String.raw`\.(write_text|write_bytes)\(`,
    String.raw`\b(fsutil|link|copyFile|cpSync|rename(Sync)?|replace|symlink|os\.replace|shutil)\b`,
  ].join('|'),
  'i',
);
const STDERR_OR_NULL_REDIRECT = /\d?>\s*(&\d|\/dev\/null|\$null|nul\b)/gi;
const LIVE_MONEY =
  /(LIVE_MONEY_CONFIRM|I_UNDERSTAND_LIVE_RISK|LIVE_MONEY_ENABLED\s*[=:]\s*['"]?true|EXECUTION_MODE\s*[=:]\s*['"]?(LIVE|SANDBOX))/i;
const LOCKED_MSG =
  'QUANT protected path. Changes here need explicit operator approval: the operator must create .claude/protected-edits.unlock by hand (Claude must not), then re-run.';

function decide(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason },
  }));
  process.exit(0);
}

// Resolve symlinks/junctions and Windows 8.3 short names via the nearest existing ancestor,
// and strip trailing dots/spaces and NTFS stream suffixes Windows ignores.
function canonical(p) {
  let cleaned = p.replace(/::\$[a-z_]+$/i, '').replace(/:[^\\/:]*$/, (m) => (/^:[\\/]/.test(m) ? m : ''));
  cleaned = cleaned.split(/[\\/]/).map((seg, i) => (i === 0 ? seg : seg.replace(/[. ]+$/, ''))).join('/');
  let head = resolve(cleaned);
  const tail = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) break;
    tail.unshift(head.slice(parent.length).replace(/^[\\/]/, ''));
    head = parent;
  }
  try {
    head = realpathSync.native(head);
  } catch {}
  return join(head, ...tail);
}

function main() {
  const input = JSON.parse(readFileSync(0, 'utf8').replace(/^﻿/, ''));
  if (!input || typeof input !== 'object') throw new Error('bad input');
  const root = canonical(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
  const unlocked = existsSync(join(root, '.claude', 'protected-edits.unlock'));
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};

  if (input.tool_name === 'Bash' || input.tool_name === 'PowerShell') {
    if (typeof ti.command !== 'string') throw new Error('bad command');
    const cmd = ti.command;
    if (LIVE_MONEY.test(cmd)) decide('deny', 'Command touches live-money switches (LIVE_MONEY_* / EXECUTION_MODE). Operator must do this manually.');
    if (/protected-edits/i.test(cmd)) decide('deny', 'Only the operator may create, change or reference the unlock marker from a shell.');
    const unquoted = cmd.replace(/['"`^]/g, '');
    const isWrite = (s) => SHELL_WRITE.test(s.replace(STDERR_OR_NULL_REDIRECT, ''));
    const writes = isWrite(cmd) || isWrite(unquoted);
    // Guard config is never writable from a shell, unlocked or not.
    if (writes && /\.claude/i.test(unquoted)) decide('deny', 'Shell writes that mention .claude are denied in QUANT; the operator edits guard config by hand.');
    const namesProtected = PROTECTED_IN_COMMAND.test(cmd) || PROTECTED_IN_COMMAND.test(unquoted);
    const readOnly =
      !COMPOUND.test(cmd.replace(STDERR_OR_NULL_REDIRECT, '')) &&
      cmd
        .replace(STDERR_OR_NULL_REDIRECT, '')
        .split(/\|\|?|&&?|;|\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .every((s) => READ_ONLY_SEGMENT.test(s) && !WRITE_FLAG.test(s) && !isWrite(s) && !isWrite(s.replace(/['"`^]/g, '')));
    if ((namesProtected && !readOnly) || (writes && INDIRECT_TARGET.test(unquoted))) {
      decide(unlocked ? 'ask' : 'deny', unlocked ? 'Shell command that may modify a QUANT protected path (unlocked): confirm.' : LOCKED_MSG);
    }
    process.exit(0);
  }

  const filePath = ti.file_path ?? ti.notebook_path;
  if (filePath === undefined) process.exit(0);
  if (typeof filePath !== 'string') throw new Error('bad path');
  // UNC and device-namespace paths can alias local files; refuse them rather than compare strings.
  if (/^([\\/]{2}|\\\\\?\\|\\\\\.\\)/.test(filePath)) decide('deny', 'UNC/device paths are not allowed for edits in QUANT; use a normal local path.');
  const abs = canonical(isAbsolute(filePath) ? filePath : join(input.cwd || root, filePath));
  // A hard link can make a protected file reachable under another name.
  try {
    if (statSync(abs).nlink > 1) decide('deny', `Refusing to edit a hard-linked file (${filePath}); it may alias a protected path.`);
  } catch {}
  const rel = relative(root, abs).replace(/\\/g, '/');
  if (rel.startsWith('..') || isAbsolute(rel)) process.exit(0);

  const edits = Array.isArray(ti.edits) ? ti.edits : [];
  const newText = [ti.new_string, ti.content, ti.new_source, ...edits.map((e) => e && e.new_string)]
    .filter((t) => typeof t === 'string')
    .join('\n');
  if (LIVE_MONEY.test(newText) && !/\.example$|\.md$|\.test\.ts$/i.test(rel)) {
    decide('deny', 'Edit would enable or configure live money. Operator must do this manually.');
  }
  if (/^\.claude\/protected-edits\.unlock$/i.test(rel)) decide('deny', 'Only the operator may create or change the unlock marker.');
  if (PROTECTED.some((re) => re.test(rel))) {
    decide(unlocked ? 'ask' : 'deny', unlocked ? `Edit to QUANT protected path ${rel} (unlocked): confirm.` : `${LOCKED_MSG} (${rel})`);
  }
  process.exit(0);
}

try {
  main();
} catch (err) {
  decide('deny', `QUANT path guard could not evaluate this call (${err && err.message}); denied to fail closed.`);
}
