import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  STRATEGY_CONTRACT_VERSION,
  strategySignalSchema,
  type StrategyBar,
  type StrategySignal,
} from "./strategy-interface.js";
import { sha256 } from "./compile-strategy.js";
import { generateSeccompBpf } from "./seccomp-profile.js";

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
  /** Enforced address-space limit in MiB (RLIMIT_AS), or 0 when no limit was measured. */
  memoryMb: number;
  /** How memory is bounded. "heap-flag-only" means only --max-old-space-size, which is not a hard limit. */
  memoryEnforcement: "rlimit-as" | "heap-flag-only";
  addressSpaceBytes: number | null;
  /** V8 old-space flag passed to Node. Advisory; RLIMIT_AS is the enforced bound. */
  heapMb: number;
  cpuSeconds: number;
  timeoutMs: number;
  perBarTimeoutMs: number;
  nproc: number;
  outputLimitBytes: number;
  dependencies: readonly string[];
  nodePath: string;
  seccomp: "default-deny-errno" | "unavailable";
  seccompDetail: string;
  /** Results travel on a host-opened pipe (fd 3), one frame per delivered bar. */
  protocol: "streaming-fd3";
};

export type IsolationProbe = RunnerConfiguration;

const TMPFS_BYTES = 8_388_608;
const HEAP_MB = 64;
/** Address space allowed above the measured Node baseline. Kept under 512 MiB so a 512 MiB buffer fails. */
const ADDRESS_SPACE_HEADROOM_BYTES = 256 * 1024 * 1024;
const CPU_SECONDS = 3;
const TIMEOUT_MS = 4_000;
const PER_BAR_TIMEOUT_MS = 1_000;
const NPROC = 16;
const OUTPUT_LIMIT = 200_000;
const DIAGNOSTIC_LIMIT = 2_000;
const RESULT_FD = 3;
/** Opt-in for hosts that cannot load the seccomp preload (non-x86_64, no gcc). */
const ALLOW_NO_SECCOMP_ENV = "ODIN_SANDBOX_ALLOW_NO_SECCOMP";

let cachedProbe: IsolationProbe | null = null;

/**
 * Harness protocol (one JSON object per line):
 *   host → stdin : header, then exactly one bar after each signal frame
 *   harness → fd 3: ready, then one signal (or error) frame per bar, each echoing the nonce
 * The harness never holds a bar the strategy has not been shown, so scanning process
 * memory cannot reveal future bars. stdout and stderr are diagnostics only. The host
 * re-validates every frame, so a strategy that writes its own frames can at most emit
 * a contract-valid signal for the bar it was given — which it could do anyway.
 */
const HARNESS = `import { createHash } from "node:crypto";
import { readFileSync, writeSync } from "node:fs";

const writeResult = writeSync;
const encode = JSON.stringify;
const RESULT_FD = ${RESULT_FD};
const INTENTS = new Set(["ENTER_LONG", "EXIT_LONG", "HOLD", "RESEARCH_NOTE"]);

const pending = [];
let buffered = "";
let ended = false;
let wake = null;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  let index;
  while ((index = buffered.indexOf("\\n")) >= 0) {
    pending.push(buffered.slice(0, index));
    buffered = buffered.slice(index + 1);
  }
  if (wake) { const resume = wake; wake = null; resume(); }
});
process.stdin.on("end", () => {
  ended = true;
  if (wake) { const resume = wake; wake = null; resume(); }
});

function nextLine() {
  return new Promise((resolve) => {
    const take = () => {
      if (pending.length > 0) return resolve(pending.shift());
      if (ended) return resolve(null);
      wake = take;
    };
    take();
  });
}

const header = JSON.parse(await nextLine());
const nonce = String(header.nonce);
function send(frame) {
  const line = encode({ ...frame, nonce }) + "\\n";
  writeResult(RESULT_FD, line);
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

const strategyUrl = new URL("./strategy.js", import.meta.url);
const artifact = readFileSync(strategyUrl);
const executedHash = createHash("sha256").update(artifact).digest("hex");
if (executedHash !== header.artifactHash) {
  send({ type: "error", code: "HASH_MISMATCH", executedHash });
  process.exit(2);
}
// The strategy is imported only after the harness captured writeSync, JSON.stringify and the nonce.
const mod = await import(strategyUrl.href);
if (typeof mod.onBar !== "function") {
  send({ type: "error", code: "CONTRACT", error: "onBar missing", executedHash });
  process.exit(2);
}
send({ type: "ready", executedHash });

const history = [];
let state = sanitizeState(header.initialState);
let seq = 0;
try {
  for (;;) {
    const line = await nextLine();
    if (line === null || line === "") break;
    const delivery = JSON.parse(line);
    const bar = delivery.bar;
    const token = String(delivery.token);
    const raw = await mod.onBar({
      contractVersion: header.contractVersion,
      bar,
      history: history.slice(-header.historyLimit),
      state,
      metadata: header.metadata,
    });
    const signal = normalize(raw, bar);
    if (signal.state) state = signal.state;
    const { state: _state, ...emitted } = signal;
    send({ type: "signal", seq, token, signal: emitted });
    history.push(bar);
    seq += 1;
  }
} catch (error) {
  const code = error && error.message ? String(error.message).slice(0, 64) : "SANDBOX";
  send({ type: "error", seq, code, executedHash });
  process.exit(2);
}
process.exit(0);
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
    memoryMb: 0,
    memoryEnforcement: "heap-flag-only",
    addressSpaceBytes: null,
    heapMb: HEAP_MB,
    cpuSeconds: CPU_SECONDS,
    timeoutMs: TIMEOUT_MS,
    perBarTimeoutMs: PER_BAR_TIMEOUT_MS,
    nproc: NPROC,
    outputLimitBytes: OUTPUT_LIMIT,
    dependencies: [],
    nodePath: process.execPath,
    seccomp: "unavailable",
    seccompDetail: "bubblewrap is not available, so the seccomp preload was not installed",
    protocol: "streaming-fd3",
  };
  const version = spawnSyncCapture("bwrap", ["--version"]);
  if (version.code !== 0) {
    cachedProbe = { ...disabled, reason: version.stderr || "bubblewrap is not installed" };
    return cachedProbe;
  }
  const bwrapVersion = version.stdout.trim() || null;
  const uidProbe = runBubblewrap("process.stdout.write(String(process.getuid()))");
  if (uidProbe.code !== 0 || !/^\d+$/.test(uidProbe.stdout.trim())) {
    cachedProbe = {
      ...disabled,
      bwrapVersion,
      reason: `bubblewrap probe failed: ${uidProbe.stderr || uidProbe.stdout || "no uid"}`,
    };
    return cachedProbe;
  }
  const uid = Number(uidProbe.stdout.trim());
  const memory = measureAddressSpaceLimit();
  if ("error" in memory) {
    cachedProbe = { ...disabled, bwrapVersion, uid, reason: memory.error };
    return cachedProbe;
  }
  const seccomp = seccompProbeFields();
  const allowNoSeccomp = process.env[ALLOW_NO_SECCOMP_ENV] === "true";
  if (seccomp.seccomp === "unavailable" && !allowNoSeccomp) {
    cachedProbe = {
      ...disabled,
      bwrapVersion,
      uid,
      ...seccomp,
      reason: `seccomp: unavailable (${seccomp.seccompDetail}). Set ${ALLOW_NO_SECCOMP_ENV}=true to run without it.`,
    };
    return cachedProbe;
  }
  cachedProbe = {
    ...disabled,
    runtime: "bubblewrap",
    available: true,
    reason:
      seccomp.seccomp === "unavailable"
        ? `bubblewrap user namespace with unshared network and a read-only root. seccomp: unavailable (allowed by ${ALLOW_NO_SECCOMP_ENV})`
        : "bubblewrap user namespace with unshared network and a read-only root",
    bwrapVersion,
    uid,
    memoryMb: Math.floor(memory.bytes / (1024 * 1024)),
    memoryEnforcement: "rlimit-as",
    addressSpaceBytes: memory.bytes,
    ...seccomp,
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

/** Harness error codes that mean the strategy broke the signal contract. */
const CONTRACT_CODES = new Set([
  "CONTRACT",
  "SIGNAL_SHAPE",
  "SIGNAL_INTENT",
  "SIGNAL_REASONS",
  "SIGNAL_CONFIDENCE",
  "NONDETERMINISTIC",
  "STATE_LIMIT",
]);

export async function executeCompiledStrategy(input: {
  javascript: string;
  artifactHash: string;
  bars: StrategyBar[];
  metadata: { strategyId: string; version: string; hypothesisId: string };
  timeoutMs?: number;
  perBarTimeoutMs?: number;
  /**
   * Test-only: mount /proc inside the sandbox. Strategy runs have no /proc (CI showed Node does not
   * need it). The look-ahead test sets this to prove the streaming protocol alone defeats a memory scan.
   */
  mountProcForTest?: boolean;
}): Promise<SandboxExecution> {
  const runner = probeIsolation();
  const fail = (patch: Partial<SandboxExecution> & { code: string; error: string }): SandboxExecution => ({
    ok: false,
    contained: true,
    signalsClaimed: false,
    exitStatus: null,
    timedOut: false,
    executedHash: null,
    signals: [],
    runner,
    ...patch,
  });
  if (!runner.available) {
    return fail({ contained: false, error: runner.reason, code: "ISOLATION_DISABLED" });
  }
  const seccomp = seccompBinaries();
  if (runner.seccomp === "default-deny-errno") {
    // Re-hash the prebuilt binaries before every bind mount; refuse if they changed.
    const integrity = seccomp === null ? "seccomp binaries are missing" : verifySeccompBinaries(seccomp);
    if (integrity !== null) {
      return fail({ contained: false, error: integrity, code: "SECCOMP_INTEGRITY" });
    }
  }
  const work = mkdtempSync(join(tmpdir(), "odin-forge-run-"));
  try {
    writeFileSync(join(work, "strategy.js"), input.javascript);
    writeFileSync(join(work, "harness.mjs"), HARNESS);
    writeFileSync(join(work, "package.json"), "{\"type\":\"module\"}\n");
    const onDisk = sha256(readFileSync(join(work, "strategy.js")));
    if (onDisk !== input.artifactHash) {
      return fail({
        executedHash: onDisk,
        error: "Artifact hash does not match the bytes written for execution",
        code: "HASH_MISMATCH",
      });
    }
    const nonce = randomBytes(16).toString("hex");
    const header = {
      nonce,
      artifactHash: input.artifactHash,
      contractVersion: STRATEGY_CONTRACT_VERSION,
      metadata: input.metadata,
      initialState: {},
      historyLimit: 256,
    };
    const args = bwrapArgs(work, runner, runner.seccomp === "default-deny-errno" ? seccomp : null, input.mountProcForTest === true);
    const outcome = await runStreaming({
      command: "bwrap",
      args,
      header,
      bars: input.bars,
      timeoutMs: input.timeoutMs ?? runner.timeoutMs,
      perBarTimeoutMs: input.perBarTimeoutMs ?? runner.perBarTimeoutMs,
    });
    const base = { exitStatus: outcome.exitStatus, executedHash: outcome.executedHash };
    switch (outcome.kind) {
      case "timeout":
        return fail({
          ...base,
          timedOut: true,
          error: outcome.error,
          code: "SANDBOX_TIMEOUT",
        });
      case "failed":
        return fail({ ...base, error: outcome.error, code: outcome.code });
      case "completed": {
        if (outcome.executedHash !== input.artifactHash) {
          return fail({ ...base, error: "Executed artifact hash differs from the compiled artifact", code: "HASH_MISMATCH" });
        }
        return {
          ok: true,
          contained: true,
          signalsClaimed: true,
          exitStatus: outcome.exitStatus,
          timedOut: false,
          executedHash: outcome.executedHash,
          signals: outcome.signals,
          error: null,
          code: "EXECUTED",
          runner,
        };
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

type StreamOutcome =
  | { kind: "completed"; signals: StrategySignal[]; executedHash: string; exitStatus: number | null }
  | { kind: "failed"; code: string; error: string; executedHash: string | null; exitStatus: number | null }
  | { kind: "timeout"; error: string; executedHash: string | null; exitStatus: number | null };

type Frame = { nonce?: unknown; type?: unknown; seq?: unknown; token?: unknown; signal?: unknown; code?: unknown; error?: unknown; executedHash?: unknown };

/**
 * Lock-step driver: write the header, wait for `ready`, then write one bar and wait for
 * exactly one frame before writing the next. Every frame must echo the nonce and its
 * signal is re-validated here, so no caller can receive an unchecked signal.
 */
async function runStreaming(input: {
  command: string;
  args: string[];
  header: { nonce: string } & Record<string, unknown>;
  bars: StrategyBar[];
  timeoutMs: number;
  perBarTimeoutMs: number;
}): Promise<StreamOutcome> {
  const child = spawn(input.command, input.args, { stdio: ["pipe", "pipe", "pipe", "pipe"], env: {} });
  const stdin = child.stdin as Writable;
  const results = child.stdio[RESULT_FD] as Readable;
  let diagnostics = "";
  let resultBytes = 0;
  let resultBuffer = "";
  let overflow = false;
  let exitStatus: number | null = null;
  let closed = false;
  const frames: string[] = [];
  let notify: (() => void) | null = null;
  const poke = () => {
    const resume = notify;
    notify = null;
    resume?.();
  };
  const collectDiagnostics = (chunk: Buffer) => {
    if (diagnostics.length < DIAGNOSTIC_LIMIT) diagnostics += chunk.toString("utf8");
  };
  child.stdout?.on("data", collectDiagnostics);
  child.stderr?.on("data", collectDiagnostics);
  results.on("data", (chunk: Buffer) => {
    resultBytes += chunk.length;
    if (resultBytes > OUTPUT_LIMIT) {
      overflow = true;
      child.kill("SIGKILL");
      poke();
      return;
    }
    resultBuffer += chunk.toString("utf8");
    let index: number;
    while ((index = resultBuffer.indexOf("\n")) >= 0) {
      frames.push(resultBuffer.slice(0, index));
      resultBuffer = resultBuffer.slice(index + 1);
    }
    poke();
  });
  results.on("error", () => undefined);
  stdin.on("error", () => undefined);
  const exited = new Promise<void>((resolve) => {
    child.on("error", () => {
      closed = true;
      poke();
      resolve();
    });
    child.on("close", (code) => {
      exitStatus = code;
      closed = true;
      poke();
      resolve();
    });
  });

  const deadline = Date.now() + input.timeoutMs;
  let executedHash: string | null = null;

  const nextFrame = (stepMs: number): Promise<Frame | "timeout" | "closed" | "overflow" | "malformed"> =>
    new Promise((resolve) => {
      const limit = Math.min(stepMs, Math.max(0, deadline - Date.now()));
      const timer = setTimeout(() => {
        notify = null;
        resolve("timeout");
      }, limit);
      const take = () => {
        if (overflow) {
          clearTimeout(timer);
          return resolve("overflow");
        }
        const line = frames.shift();
        if (line !== undefined) {
          clearTimeout(timer);
          try {
            const value = JSON.parse(line) as unknown;
            return resolve(value && typeof value === "object" && !Array.isArray(value) ? (value as Frame) : "malformed");
          } catch {
            return resolve("malformed");
          }
        }
        if (closed) {
          clearTimeout(timer);
          return resolve("closed");
        }
        notify = take;
      };
      take();
    });

  const stop = async (): Promise<void> => {
    if (!closed) child.kill("SIGKILL");
    await exited;
  };
  const failed = async (code: string, error: string): Promise<StreamOutcome> => {
    await stop();
    return { kind: "failed", code, error, executedHash, exitStatus };
  };
  const timedOut = async (error: string): Promise<StreamOutcome> => {
    await stop();
    return { kind: "timeout", error, executedHash, exitStatus };
  };
  const unexpected = async (
    frame: "closed" | "overflow" | "malformed" | "timeout",
    phase: string,
  ): Promise<StreamOutcome> => {
    if (frame === "timeout") return timedOut(`Sandbox did not answer within the time limit during ${phase}`);
    if (frame === "overflow") return failed("SANDBOX_OUTPUT", "Sandbox result channel exceeded the output limit");
    if (frame === "malformed") return failed("SANDBOX_PROTOCOL", `Malformed result frame during ${phase}`);
    await exited;
    return {
      kind: "failed",
      code: "SANDBOX_EXIT",
      error: trimOutput(diagnostics || `Sandbox exited during ${phase} without a result`),
      executedHash,
      exitStatus,
    };
  };
  const reportedError = (frame: Frame): Promise<StreamOutcome> => {
    const code = typeof frame.code === "string" ? frame.code : "SANDBOX";
    if (typeof frame.executedHash === "string") executedHash = frame.executedHash;
    const mapped = CONTRACT_CODES.has(code) ? "CONTRACT_FAIL" : code === "HASH_MISMATCH" ? "HASH_MISMATCH" : "SANDBOX_EXIT";
    const detail = typeof frame.error === "string" ? frame.error : code;
    return failed(mapped, trimOutput(detail));
  };

  stdin.write(`${JSON.stringify(input.header)}\n`);
  const ready = await nextFrame(input.timeoutMs);
  if (typeof ready === "string") return unexpected(ready, "startup");
  if (ready.nonce !== input.header.nonce) return failed("SANDBOX_PROTOCOL", "Result frame did not carry the run nonce");
  if (ready.type === "error") return reportedError(ready);
  if (ready.type !== "ready" || typeof ready.executedHash !== "string") {
    return failed("SANDBOX_PROTOCOL", "Sandbox did not report ready");
  }
  executedHash = ready.executedHash;

  const signals: StrategySignal[] = [];
  for (const [index, bar] of input.bars.entries()) {
    if (frames.length > 0) return failed("SANDBOX_PROTOCOL", "Sandbox sent a frame before the bar was delivered");
    // A fresh token per bar: a frame written before this bar was sent cannot carry it,
    // so it is rejected rather than buffered and accepted as this bar's answer.
    const token = randomBytes(12).toString("hex");
    stdin.write(`${JSON.stringify({ token, bar })}\n`);
    const frame = await nextFrame(input.perBarTimeoutMs);
    if (typeof frame === "string") return unexpected(frame, `bar ${index}`);
    if (frame.nonce !== input.header.nonce) return failed("SANDBOX_PROTOCOL", "Result frame did not carry the run nonce");
    if (frame.type === "error") return reportedError(frame);
    if (frame.type !== "signal" || frame.seq !== index || frame.token !== token) {
      return failed("SANDBOX_PROTOCOL", `Expected the signal for bar ${index}`);
    }
    const checked = validateSignal(frame.signal, bar);
    if (!checked.ok) return failed("CONTRACT_FAIL", checked.error);
    signals.push(checked.signal);
  }
  stdin.end();
  // Give the harness a moment to exit cleanly so the exit status is real, then make sure it is gone.
  const grace = Math.min(500, Math.max(0, deadline - Date.now()));
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, grace))]);
  await stop();
  // Anything on the result pipe after the last signal is a second frame for a bar.
  if (frames.length > 0 || resultBuffer.length > 0) {
    return { kind: "failed", code: "SANDBOX_PROTOCOL", error: "Sandbox sent more than one frame for a bar", executedHash, exitStatus };
  }
  if (signals.length !== input.bars.length) {
    return { kind: "failed", code: "CONTRACT_FAIL", error: "Signal count does not match delivered bars", executedHash, exitStatus };
  }
  return { kind: "completed", signals, executedHash: executedHash ?? "", exitStatus };
}

const NONDETERMINISTIC_CODE = /^\d{12,}$/;

/** Host-side contract check. The harness runs in the strategy's process, so its checks are advisory. */
export function validateSignal(
  raw: unknown,
  bar: StrategyBar,
): { ok: true; signal: StrategySignal } | { ok: false; error: string } {
  const parsed = strategySignalSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: `Strategy signal failed the contract schema: ${parsed.error.issues[0]?.message ?? "invalid"}` };
  }
  const signal = parsed.data;
  if (signal.instrumentId !== bar.instrumentId) return { ok: false, error: "Signal instrument does not match the delivered bar" };
  if ((signal.pairAddress ?? null) !== (bar.pairAddress ?? null)) {
    return { ok: false, error: "Signal pair address does not match the delivered bar" };
  }
  if (signal.reasonCodes.some((code) => code.includes(".") || NONDETERMINISTIC_CODE.test(code))) {
    return { ok: false, error: "Signal reason codes look nondeterministic" };
  }
  return { ok: true, signal };
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

function bwrapArgs(work: string, runner: RunnerConfiguration, seccomp: SeccompBinaries | null, mountProc = false): string[] {
  const mounts =
    seccomp === null
      ? []
      : ["--ro-bind", seccomp.so, "/seccomp.so", "--ro-bind", seccomp.init, "/sandbox-init"];
  const command = seccomp === null ? ["/node", `--max-old-space-size=${HEAP_MB}`, "/work/harness.mjs"] : ["/sandbox-init"];
  const addressSpace = runner.addressSpaceBytes === null ? [] : [`--as=${runner.addressSpaceBytes}`];
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
    ...(mountProc ? ["--proc", "/proc"] : []),
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
    String(HEAP_MB),
    "--",
    "/usr/bin/prlimit",
    `--nproc=${NPROC}`,
    "--nofile=32",
    `--cpu=${CPU_SECONDS}`,
    ...addressSpace,
    "--",
    ...command,
  ];
}

/**
 * Measure Node's peak virtual size inside bubblewrap, then allow a fixed headroom above it.
 * The result is verified by booting Node under the limit and allocating 8 MiB.
 */
function measureAddressSpaceLimit(): { bytes: number } | { error: string } {
  const peak = runBubblewrap(
    "const m=require('fs').readFileSync('/proc/self/status','utf8').match(/VmPeak:\\s+(\\d+)/);process.stdout.write(m?m[1]:'')",
  );
  const kib = Number(peak.stdout.trim());
  if (peak.code !== 0 || !Number.isFinite(kib) || kib <= 0) {
    return { error: `could not measure Node address space inside bubblewrap: ${peak.stderr || peak.stdout || "no VmPeak"}` };
  }
  const bytes = Math.ceil((kib * 1024 + ADDRESS_SPACE_HEADROOM_BYTES) / (1024 * 1024)) * 1024 * 1024;
  const check = runBubblewrap(
    "const b=new ArrayBuffer(8*1024*1024);new Uint8Array(b).fill(1);process.stdout.write('ok')",
    ["/usr/bin/prlimit", `--as=${bytes}`, "--"],
  );
  if (check.code !== 0 || check.stdout.trim() !== "ok") {
    return { error: `Node did not start under the measured address-space limit (${bytes} bytes): ${check.stderr || check.stdout}` };
  }
  return { bytes };
}

type SeccompBinaries = { so: string; init: string; manifest: SeccompManifest };
type SeccompManifest = { sourceHash: string; files: { "seccomp.so": string; "sandbox-init": string } };

let seccompCache: SeccompBinaries | { error: string } | null = null;

function seccompProbeFields(): { seccomp: IsolationProbe["seccomp"]; seccompDetail: string } {
  const built = seccompBinaries();
  if (built) {
    const integrity = verifySeccompBinaries(built);
    if (integrity !== null) return { seccomp: "unavailable", seccompDetail: integrity };
    return {
      seccomp: "default-deny-errno",
      seccompDetail:
        "x86_64 seccomp-bpf default EPERM. Node starts under the preload after prlimit. execve, socket, and connect are not on the allowlist. This is not a virtual machine.",
    };
  }
  const detail = seccompCache && "error" in seccompCache ? seccompCache.error : "seccomp preload was not built";
  return { seccomp: "unavailable", seccompDetail: detail };
}

export function sandboxSourceDir(): string {
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

/**
 * Locate the binaries built by `scripts/build-sandbox.mjs` (run on install and build).
 * Nothing is compiled at runtime and nothing is read from shared /tmp.
 */
function seccompBinaries(): SeccompBinaries | null {
  if (seccompCache && !("error" in seccompCache)) return seccompCache;
  if (seccompCache && "error" in seccompCache) return null;
  if (process.platform !== "linux" || process.arch !== "x64") {
    seccompCache = { error: "the committed seccomp profile is x86_64 Linux only" };
    return null;
  }
  const dir = sandboxSourceDir();
  const buildDir = join(dir, "build");
  const manifestPath = join(buildDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    seccompCache = {
      error: "seccomp binaries were not built; run `pnpm --filter @odin/evolution sandbox:build` (needs gcc)",
    };
    return null;
  }
  let manifest: SeccompManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as SeccompManifest;
  } catch {
    seccompCache = { error: "seccomp build manifest is unreadable" };
    return null;
  }
  const sourceHash = seccompSourceHash(dir);
  if (manifest.sourceHash !== sourceHash) {
    seccompCache = { error: "seccomp binaries are stale against the committed sources; rebuild them" };
    return null;
  }
  const expectedBpf = join(dir, "seccomp-bpf.sha256");
  if (!existsSync(expectedBpf) || sha256(Buffer.from(generateSeccompBpf())) !== readFileSync(expectedBpf, "utf8").trim()) {
    seccompCache = { error: "generated seccomp program does not match the committed seccomp-bpf.sha256" };
    return null;
  }
  // Manifest hashes are read once per process and pinned; later runs compare files against them.
  seccompCache = { so: join(buildDir, "seccomp.so"), init: join(buildDir, "sandbox-init"), manifest };
  return seccompCache;
}

/** Must match `sourceHash` in scripts/build-sandbox.mjs. */
function seccompSourceHash(dir: string): string {
  return sha256(
    readFileSync(join(dir, "seccomp-preload.c"), "utf8") + "\n" + readFileSync(join(dir, "sandbox-init.c"), "utf8"),
  );
}

function verifySeccompBinaries(binaries: SeccompBinaries): string | null {
  for (const [name, path] of [
    ["seccomp.so", binaries.so],
    ["sandbox-init", binaries.init],
  ] as const) {
    if (!existsSync(path)) return `seccomp binary ${name} is missing`;
    if (sha256(readFileSync(path)) !== binaries.manifest.files[name]) {
      return `seccomp binary ${name} does not match its recorded SHA-256; refusing to run`;
    }
  }
  // The committed BPF program is deterministic, so the preload must embed exactly those bytes.
  if (!readFileSync(binaries.so).includes(Buffer.from(generateSeccompBpf()))) {
    return "seccomp.so does not embed the committed BPF program; refusing to run";
  }
  return null;
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

function runBubblewrap(expression: string, prefix: string[] = []): { code: number | null; stdout: string; stderr: string } {
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
    ...prefix,
    "/node",
    "-e",
    expression,
  ]);
}

/**
 * Test seam: drives the harness protocol with any command (e.g. plain Node, no isolation)
 * so protocol checks run on hosts without bubblewrap. Never use it to execute strategies.
 */
export const sandboxProtocolForTests = { harnessSource: HARNESS, runStreaming };
