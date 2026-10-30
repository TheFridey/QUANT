#!/usr/bin/env node
// Builds the seccomp preload and sandbox-init into packages/evolution/sandbox/build
// and records their SHA-256 in manifest.json. The runner verifies those hashes before
// every bind mount and never compiles at runtime. On hosts without x86_64 Linux or gcc
// this prints why and exits 0; the runner then reports "seccomp: unavailable".
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const sandboxDir = join(dirname(fileURLToPath(import.meta.url)), "..", "sandbox");
const buildDir = join(sandboxDir, "build");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function skip(reason) {
  process.stdout.write(`[evolution] seccomp sandbox not built: ${reason}\n`);
  process.exit(0);
}

if (process.platform !== "linux" || process.arch !== "x64") skip("the committed profile is x86_64 Linux only");
const gcc = spawnSync("gcc", ["--version"], { encoding: "utf8" });
if (gcc.status !== 0) skip("gcc is not installed");

const preload = join(sandboxDir, "seccomp-preload.c");
const init = join(sandboxDir, "sandbox-init.c");
// Must match seccompSourceHash() in src/sandbox-runner.ts.
const sourceHash = sha256(readFileSync(preload, "utf8") + "\n" + readFileSync(init, "utf8"));

const staging = `${buildDir}.tmp-${process.pid}`;
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true, mode: 0o755 });
const steps = [
  ["-shared", "-fPIC", "-O2", "-o", join(staging, "seccomp.so"), preload],
  ["-O2", "-o", join(staging, "sandbox-init"), init],
];
for (const args of steps) {
  const result = spawnSync("gcc", args, { encoding: "utf8" });
  if (result.status !== 0) {
    rmSync(staging, { recursive: true, force: true });
    process.stderr.write(result.stderr);
    process.exit(1);
  }
}
const manifest = {
  sourceHash,
  files: {
    "seccomp.so": sha256(readFileSync(join(staging, "seccomp.so"))),
    "sandbox-init": sha256(readFileSync(join(staging, "sandbox-init"))),
  },
};
writeFileSync(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
if (existsSync(buildDir)) rmSync(buildDir, { recursive: true, force: true });
renameSync(staging, buildDir);
process.stdout.write(`[evolution] seccomp sandbox built in ${buildDir}\n`);
