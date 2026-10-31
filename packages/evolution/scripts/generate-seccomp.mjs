#!/usr/bin/env node
// Rewrites the generated BPF block in sandbox/seccomp-preload.c from src/seccomp-profile.ts.
// Run through `pnpm --filter @odin/evolution seccomp:generate` (builds dist first).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { renderSeccompBpfC } from "../dist/seccomp-profile.js";

const file = join(dirname(fileURLToPath(import.meta.url)), "..", "sandbox", "seccomp-preload.c");
const source = readFileSync(file, "utf8");
const begin = "/* BEGIN GENERATED: src/seccomp-profile.ts */";
const end = "/* END GENERATED */";
const start = source.indexOf(begin);
const stop = source.indexOf(end);
if (start < 0 || stop < start) throw new Error("generated markers not found in seccomp-preload.c");
writeFileSync(file, `${source.slice(0, start + begin.length)}\n${renderSeccompBpfC()}\n${source.slice(stop)}`);
process.stdout.write("seccomp-preload.c regenerated\n");
