import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STRATEGY_CONTRACT_VERSION, type StrategyBar, type StrategySignal } from "./strategy-interface.js";
import { sha256 } from "./compile-strategy.js";

export type RunnerConfiguration = {
  runtime: "bubblewrap" | "disabled";
  available: boolean;
  reason: string;
  bwrapVersion: string | null;
  uid: number | null;
  network: "none";
  rootFilesystem: "read-only";
  secretsMounted: false;
  tmpfsBytes: number;
  memoryMb: number;
  cpuSeconds: number;
  timeoutMs: number;
  nproc: number;
  outputLimitBytes: number;
  dependencies: readonly string[];
  nodePath: string;
  seccomp: "default-deny-errno" | "unavailable";
  seccompDetail: string;
};

export type IsolationProbe = RunnerConfiguration;

const TMPFS_BYTES = 8_388_608;
const MEMORY_MB = 64;
const CPU_SECONDS = 3;
const TIMEOUT_MS = 4_000;
const NPROC = 16;
const OUTPUT_LIMIT = 200_000;

let cachedProbe: IsolationProbe | null = null;

const HARNESS = `import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const INTENTS = new Set(["ENTER_LONG", "EXIT_LONG", "HOLD", "RESEARCH_NOTE"]);

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

function sanitizeState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return {};
  const keys = Object.keys(state);
  if (keys.length > 32) throw new Error("STATE_LIMIT");
  const encoded = JSON.stringify(state);
  if (encoded.length > 4096) throw new Error("STATE_LIMIT");
  return JSON.parse(encoded);
}

function normalize(raw, bar) {
  if (!raw || typeof raw !== "object") throw new Error("SIGNAL_SHAPE");
  if (!INTENTS.has(raw.intent)) throw new Error("SIGNAL_INTENT");
  if (!Array.isArray(raw.reasonCodes) || raw.reasonCodes.some((code) => typeof code !== "string") || raw.reasonCodes.length > 32) {
    throw new Error("SIGNAL_REASONS");
  }
  if (raw.reasonCodes.some((code) => code.includes(".") || /^\\d{12,}$/.test(code))) {
    throw new Error("NONDETERMINISTIC");
  }
  let confidence;
  if (raw.confidence !== undefined) {
    confidence = Number(raw.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("SIGNAL_CONFIDENCE");
  }
  return {
    instrumentId: String(bar.instrumentId),
    pairAddress: bar.pairAddress ? String(bar.pairAddress) : undefined,
    intent: raw.intent,
    reasonCodes: raw.reasonCodes.slice(0, 32),
    ...(confidence === undefined ? {} : { confidence }),
    state: sanitizeState(raw.state),
  };
}

const requestText = await readStdin();
const request = JSON.parse(requestText);
const artifact = readFileSync("/work/strategy.js");
const executedHash = createHash("sha256").update(artifact).digest("hex");
if (executedHash !== request.artifactHash) {
  console.log(JSON.stringify({ ok: false, code: "HASH_MISMATCH", executedHash }));
  process.exit(2);
}
const mod = await import(pathToFileURL("/work/strategy.js").href);
if (typeof mod.onBar !== "function") {
  console.log(JSON.stringify({ ok: false, code: "CONTRACT", error: "onBar missing", executedHash }));
  process.exit(2);
}
const history = [];
const signals = [];
let state = sanitizeState(request.initialState);
try {
  for (const bar of request.bars) {
    const past = history.slice(-request.historyLimit);
    const raw = await mod.onBar({
      contractVersion: request.contractVersion,
      bar,
      history: past,
      state,
      metadata: request.metadata,
    });
    const signal = normalize(raw, bar);
    if (signal.state) state = signal.state;
    const { state: _state, ...emitted } = signal;
    signals.push(emitted);
    history.push(bar);
  }
} catch (error) {
  const code = error && error.message ? String(error.message) : "SANDBOX";
  console.log(JSON.stringify({ ok: false, code, executedHash }));
  process.exit(2);
}
const body = JSON.stringify({ ok: true, executedHash, signals });
if (body.length > request.maxOutputBytes) {
  console.log(JSON.stringify({ ok: false, code: "OUTPUT_LIMIT", executedHash }));
  process.exit(3);
}
console.log(body);
`;

export function probeIsolation(force = false): IsolationProbe {
  if (cachedProbe && !force) return cachedProbe;
  const disabled: IsolationProbe = {
    runtime: "disabled",
    available: false,
    reason: "bubblewrap is not installed",
    bwrapVersion: null,
    uid: null,
    network: "none",
    rootFilesystem: "read-only",
    secretsMounted: false,
    tmpfsBytes: TMPFS_BYTES,
    memoryMb: MEMORY_MB,
    cpuSeconds: CPU_SECONDS,
    timeoutMs: TIMEOUT_MS,
    nproc: NPROC,
    outputLimitBytes: OUTPUT_LIMIT,
    dependencies: [],
    nodePath: process.execPath,
    seccomp: "unavailable",
    seccompDetail: "bubblewrap is not available, so the seccomp preload was not installed",
  };
  const version = spawnSyncCapture("bwrap", ["--version"]);
  if (version.code !== 0) {
    cachedProbe = { ...disabled, reason: version.stderr || "bubblewrap is not installed" };
    return cachedProbe;
  }
  const uidProbe = runBubblewrap("process.stdout.write(String(process.getuid()))");
  if (uidProbe.code !== 0 || !/^\d+$/.test(uidProbe.stdout.trim())) {
    cachedProbe = {
      ...disabled,
      bwrapVersion: version.stdout.trim() || null,
      reason: `bubblewrap probe failed: ${uidProbe.stderr || uidProbe.stdout || "no uid"}`,
    };
    return cachedProbe;
  }
  const uid = Number(uidProbe.stdout.trim());
  cachedProbe = {
    ...disabled,
    runtime: "bubblewrap",
    available: true,
    reason: "bubblewrap user namespace with unshared network and a read-only root",
    bwrapVersion: version.stdout.trim() || null,
    uid,
    ...seccompProbeFields(),
  };
  return cachedProbe;
}

export function isolationAvailable(): boolean {
  return probeIsolation().available;
}

export type SandboxExecution = {
  ok: boolean;
  contained: boolean;
  signalsClaimed: boolean;
  exitStatus: number | null;
  timedOut: boolean;
  executedHash: string | null;
  signals: StrategySignal[];
  error: string | null;
  code: string;
  runner: RunnerConfiguration;
};

export async function executeCompiledStrategy(input: {
  javascript: string;
  artifactHash: string;
  bars: StrategyBar[];
  metadata: { strategyId: string; version: string; hypothesisId: string };
  timeoutMs?: number;
}): Promise<SandboxExecution> {
  const runner = probeIsolation();
  if (!runner.available) {
    return {
      ok: false,
      contained: false,
      signalsClaimed: false,
      exitStatus: null,
      timedOut: false,
      executedHash: null,
      signals: [],
      error: runner.reason,
      code: "ISOLATION_DISABLED",
      runner,
    };
  }
  const work = join(tmpdir(), `odin-forge-run-${sha256(input.artifactHash).slice(0, 12)}-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  try {
    writeFileSync(join(work, "strategy.js"), input.javascript);
    writeFileSync(join(work, "harness.mjs"), HARNESS);
    writeFileSync(join(work, "package.json"), "{\"type\":\"module\"}\n");
    const onDisk = sha256(readFileSync(join(work, "strategy.js")));
    if (onDisk !== input.artifactHash) {
      return {
        ok: false,
        contained: true,
        signalsClaimed: false,
        exitStatus: null,
        timedOut: false,
        executedHash: onDisk,
        signals: [],
        error: "Artifact hash does not match the bytes written for execution",
        code: "HASH_MISMATCH",
        runner,
      };
    }
    const request = {
      artifactHash: input.artifactHash,
      contractVersion: STRATEGY_CONTRACT_VERSION,
      bars: input.bars,
      metadata: input.metadata,
      initialState: {},
      historyLimit: 256,
      maxOutputBytes: OUTPUT_LIMIT,
    };
    const args = bwrapArgs(work);
    const result = await spawnCaptured("bwrap", args, JSON.stringify(request), input.timeoutMs ?? runner.timeoutMs);
    if (result.timedOut) {
      return {
        ok: false,
        contained: true,
        signalsClaimed: false,
        exitStatus: result.code,
        timedOut: true,
        executedHash: null,
        signals: [],
        error: "Sandbox process exceeded the time limit and was terminated",
        code: "SANDBOX_TIMEOUT",
        runner,
      };
    }
    const parsed = parseSandboxStdout(result.stdout);
    if (!parsed) {
      return {
        ok: false,
        contained: true,
        signalsClaimed: false,
        exitStatus: result.code,
        timedOut: false,
        executedHash: null,
        signals: [],
        error: trimOutput(result.stderr || result.stdout || "Sandbox produced no result"),
        code: result.code === 0 ? "SANDBOX_OUTPUT" : "SANDBOX_EXIT",
        runner,
      };
    }
    if (!parsed.ok) {
      return {
        ok: false,
        contained: true,
        signalsClaimed: false,
        exitStatus: result.code,
        timedOut: false,
        executedHash: parsed.executedHash,
        signals: [],
        error: parsed.error ?? parsed.code,
        code: parsed.code,
        runner,
      };
    }
    if (parsed.executedHash !== input.artifactHash) {
      return {
        ok: false,
        contained: true,
        signalsClaimed: false,
        exitStatus: result.code,
        timedOut: false,
        executedHash: parsed.executedHash,
        signals: [],
        error: "Executed artifact hash differs from the compiled artifact",
        code: "HASH_MISMATCH",
        runner,
      };
    }
    return {
      ok: true,
      contained: true,
      signalsClaimed: true,
      exitStatus: result.code,
      timedOut: false,
      executedHash: parsed.executedHash,
      signals: parsed.signals,
      error: null,
      code: "EXECUTED",
      runner,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Library mounts shared by strategy execution and the CI availability probe. */
export function sandboxLibraryMounts(): string[] {
  return ["--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64"];
}

/**
 * Availability probe. It uses the runner's library mounts so `/usr/bin/true` can
 * load the dynamic linker. It does not open a network namespace to the host,
 * does not mount secrets, and does not make the root writable.
 */
export function bubblewrapCiProbeArgs(): string[] {
  return [
    "--unshare-user",
    "--unshare-net",
    "--die-with-parent",
    "--uid",
    "65534",
    "--gid",
    "65534",
    ...sandboxLibraryMounts(),
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--clearenv",
    "--",
    "/usr/bin/true",
  ];
}

function bwrapArgs(work: string): string[] {
  const seccomp = seccompBinaries();
  const mounts =
    seccomp === null
      ? []
      : ["--ro-bind", seccomp.so, "/seccomp.so", "--ro-bind", seccomp.init, "/sandbox-init"];
  const command = seccomp === null ? ["/node", `--max-old-space-size=${MEMORY_MB}`, "/work/harness.mjs"] : ["/sandbox-init"];
  return [
    "--unshare-user",
    "--unshare-net",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--die-with-parent",
    "--uid",
    "65534",
    "--gid",
    "65534",
    ...sandboxLibraryMounts(),
    "--ro-bind",
    process.execPath,
    "/node",
    "--ro-bind",
    work,
    "/work",
    ...mounts,
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--size",
    String(TMPFS_BYTES),
    "--tmpfs",
    "/tmp",
    "--chdir",
    "/work",
    "--clearenv",
    "--setenv",
    "PATH",
    "/usr/bin",
    "--setenv",
    "ODIN_NODE_HEAP",
    String(MEMORY_MB),
    "--",
    "/usr/bin/prlimit",
    `--nproc=${NPROC}`,
    "--nofile=32",
    `--cpu=${CPU_SECONDS}`,
    "--",
    ...command,
  ];
}

type SeccompBinaries = { so: string; init: string };

let seccompCache: SeccompBinaries | { error: string } | null = null;

function seccompProbeFields(): { seccomp: IsolationProbe["seccomp"]; seccompDetail: string } {
  const built = seccompBinaries();
  if (built) {
    return {
      seccomp: "default-deny-errno",
      seccompDetail:
        "x86_64 seccomp-bpf default EPERM. Node starts under the preload after prlimit. execve, socket, and connect are not on the allowlist. This is not a virtual machine.",
    };
  }
  const detail = seccompCache && "error" in seccompCache ? seccompCache.error : "seccomp preload was not built";
  return { seccomp: "unavailable", seccompDetail: detail };
}

function sandboxSourceDir(): string {
  const starts = [process.cwd(), join(process.cwd(), "packages/evolution")];
  for (const start of starts) {
    let dir = start;
    for (let depth = 0; depth < 6; depth += 1) {
      const nested = join(dir, "packages/evolution/sandbox");
      if (existsSync(join(nested, "seccomp-preload.c"))) return nested;
      const local = join(dir, "sandbox");
      if (existsSync(join(local, "seccomp-preload.c"))) return local;
      const parent = join(dir, "..");
      if (parent === dir) break;
      dir = parent;
    }
  }
  return join(process.cwd(), "packages/evolution/sandbox");
}

function seccompBinaries(): SeccompBinaries | null {
  if (seccompCache && !("error" in seccompCache)) return seccompCache;
  if (seccompCache && "error" in seccompCache) return null;
  if (process.arch !== "x64") {
    seccompCache = { error: "the committed seccomp profile is x86_64 only" };
    return null;
  }
  const dir = sandboxSourceDir();
  const preload = join(dir, "seccomp-preload.c");
  const initSource = join(dir, "sandbox-init.c");
  if (!existsSync(preload) || !existsSync(initSource)) {
    seccompCache = { error: "seccomp sources are not present beside the evolution package" };
    return null;
  }
  const gcc = spawnSync("gcc", ["--version"], { encoding: "utf8" });
  if (gcc.status !== 0) {
    seccompCache = { error: "gcc is not installed, so the seccomp preload was not built" };
    return null;
  }
  const stamp = sha256(readFileSync(preload, "utf8") + "\n" + readFileSync(initSource, "utf8")).slice(0, 16);
  const outDir = join(tmpdir(), `odin-seccomp-${stamp}`);
  const so = join(outDir, "seccomp.so");
  const init = join(outDir, "sandbox-init");
  if (!existsSync(so) || !existsSync(init)) {
    mkdirSync(outDir, { recursive: true });
    const soBuild = spawnSync("gcc", ["-shared", "-fPIC", "-O2", "-o", so, preload], { encoding: "utf8" });
    if (soBuild.status !== 0) {
      seccompCache = { error: trimOutput(soBuild.stderr || "seccomp preload compile failed") };
      return null;
    }
    const initBuild = spawnSync("gcc", ["-O2", "-o", init, initSource], { encoding: "utf8" });
    if (initBuild.status !== 0) {
      seccompCache = { error: trimOutput(initBuild.stderr || "sandbox init compile failed") };
      return null;
    }
  }
  seccompCache = { so, init };
  return seccompCache;
}

function parseSandboxStdout(stdout: string):
  | { ok: true; executedHash: string; signals: StrategySignal[] }
  | { ok: false; code: string; error?: string; executedHash: string | null }
  | null {
  const line = stdout.trim().split("\n").filter(Boolean).at(-1);
  if (!line) return null;
  try {
    const value = JSON.parse(line) as {
      ok?: boolean;
      code?: string;
      error?: string;
      executedHash?: string;
      signals?: StrategySignal[];
    };
    if (value.ok === true && typeof value.executedHash === "string" && Array.isArray(value.signals)) {
      return { ok: true, executedHash: value.executedHash, signals: value.signals };
    }
    if (value.ok === false) {
      return {
        ok: false,
        code: value.code ?? "SANDBOX_OUTPUT",
        error: value.error,
        executedHash: value.executedHash ?? null,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function trimOutput(value: string): string {
  return value.split("\u0000").join("").slice(0, 500);
}

function spawnSyncCapture(command: string, args: string[]): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: "utf8", env: {}, timeout: 5_000 });
  return {
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function runBubblewrap(expression: string): { code: number | null; stdout: string; stderr: string } {
  return spawnSyncCapture("bwrap", [
    "--unshare-user",
    "--unshare-net",
    "--die-with-parent",
    "--uid",
    "65534",
    "--gid",
    "65534",
    ...sandboxLibraryMounts(),
    "--ro-bind",
    process.execPath,
    "/node",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--clearenv",
    "--",
    "/node",
    "-e",
    expression,
  ]);
}

function spawnCaptured(
  command: string,
  args: string[],
  stdin: string,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: {} });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr: trimOutput(stderr), timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > OUTPUT_LIMIT) {
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 2_000) stderr += chunk.toString("utf8");
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
    child.stdin?.write(stdin);
    child.stdin?.end();
  });
}
