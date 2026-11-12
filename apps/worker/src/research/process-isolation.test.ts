import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { runCampaignTick } from "../campaign-job.js";
import { EvaluatorFailure, makeChildProcessEvaluator } from "./campaign-runner.js";
import { detectOsMemoryLimit, EXIT_RSS_LIMIT, osIsolationRefusal, rssLimitForHeap, SUPERVISOR_PIPE_ENV } from "./process-guards.js";

/**
 * OPERATION INTEGRITY F10 with REAL child processes. Scripts are written to a temp directory and load the
 * dependency-free guard module directly (`--experimental-strip-types`), so the same code the evaluator and CLI
 * run is what is exercised here. No production load or exhaustion testing: memory tests stay under ~300 MB.
 */
const GUARDS = pathToFileURL(join(__dirname, "process-guards.ts")).href;
const STRIP = ["--experimental-strip-types", "--no-warnings"];
const dir = mkdtempSync(join(tmpdir(), "odin-f10-"));
const script = (name: string, body: string) => {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(fn: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}
const readPid = (file: string) => until(() => {
  try {
    return Number(readFileSync(file, "utf8")) > 0;
  } catch {
    return false;
  }
}, 15_000).then(() => Number(readFileSync(file, "utf8")));

// Leaf: installs liveness, records its pid, then runs forever.
const leaf = script("leaf.mjs", `import { installSupervisorLiveness } from ${JSON.stringify(GUARDS)};\nimport { writeFileSync } from "node:fs";\ninstallSupervisorLiveness();\nwriteFileSync(process.argv[2], String(process.pid));\nsetInterval(() => {}, 1000);\n`);
// Middle: like the CLI. Installs liveness, starts the leaf with a pipe and the flag, then runs forever.
const middle = script(
  "middle.mjs",
  `import { installSupervisorLiveness } from ${JSON.stringify(GUARDS)};\nimport { spawn } from "node:child_process";\nimport { writeFileSync } from "node:fs";\ninstallSupervisorLiveness();\nwriteFileSync(process.argv[2], String(process.pid));\nconst c = spawn(process.execPath, [...${JSON.stringify(STRIP)}, ${JSON.stringify(leaf)}, process.argv[3]], { stdio: ["pipe", "ignore", "inherit"], env: { ...process.env, ${SUPERVISOR_PIPE_ENV}: "1" } });\nc.stdin.on("error", () => {});\nsetInterval(() => {}, 1000);\n`,
);
const start = (file: string, args: string[], withPipe = true): ChildProcess =>
  spawn(process.execPath, [...STRIP, file, ...args], { stdio: [withPipe ? "pipe" : "ignore", "ignore", "inherit"], env: { ...process.env, ...(withPipe ? { [SUPERVISOR_PIPE_ENV]: "1" } : {}) } });

describe("research process isolation (F10, real processes)", () => {
  it("supervisor death: when the parent pipe closes (as the OS does on any parent exit) the child exits at once", async () => {
    const pidFile = join(dir, "leaf1.pid");
    const parent = start(leaf, [pidFile]);
    const pid = await readPid(pidFile);
    expect(pid).toBe(parent.pid);
    // Here the test process is the supervisor: kill the pipe holder by closing it as the OS would on death.
    parent.stdin!.destroy();
    expect(await until(() => !alive(pid), 10_000)).toBe(true);
    expect(parent.exitCode ?? (await new Promise((r) => parent.once("exit", r)))).toBe(137);
  }, 30_000);

  it("descendant cleanup: killing the middle (CLI) process with SIGKILL stops the leaf (evaluator)", async () => {
    const [midPid, leafPid] = [join(dir, "mid2.pid"), join(dir, "leaf2.pid")];
    const mid = start(middle, [midPid, leafPid]);
    const leafProcess = await readPid(leafPid);
    expect(alive(leafProcess)).toBe(true);
    mid.kill("SIGKILL");
    expect(await until(() => !alive(leafProcess), 10_000)).toBe(true);
  }, 30_000);

  it("cancellation or timeout at the top (worker tick) removes the whole tree", async () => {
    const [midPid, leafPid] = [join(dir, "mid3.pid"), join(dir, "leaf3.pid")];
    const tickCli = script("tick-cli.mjs", `process.argv.splice(2, 3, ${JSON.stringify(midPid)}, ${JSON.stringify(leafPid)});\nawait import(${JSON.stringify(pathToFileURL(middle).href)});\n`);
    const ran = runCampaignTick({ ...process.env, RESEARCH_CAMPAIGN_WORKER_ENABLED: "true" }, { cliPath: tickCli, ceilingMs: 4_000, execArgv: STRIP });
    const [m, l] = [await readPid(midPid), await readPid(leafPid)];
    const result = await ran;
    expect(result).toMatchObject({ status: "RAN", timedOut: true });
    expect(await until(() => !alive(m) && !alive(l), 10_000)).toBe(true);
  }, 60_000);

  it("without the supervisor flag (an operator at a terminal) an ignored stdin does not stop the process", async () => {
    const pidFile = join(dir, "leaf4.pid");
    const p = start(leaf, [pidFile], false);
    const pid = await readPid(pidFile);
    await new Promise((r) => setTimeout(r, 1_000));
    expect(alive(pid)).toBe(true);
    p.kill("SIGKILL");
  }, 30_000);

  it("memory naming: the V8 heap limit does not bound off-heap memory; the sampled RSS watchdog does", async () => {
    const grow = script("grow.mjs", `import { installRssWatchdog } from ${JSON.stringify(GUARDS)};\nconst limit = Number(process.argv[2]);\nif (limit > 0) installRssWatchdog(limit, 50);\nconst keep = [];\nconst t = setInterval(() => { keep.push(Buffer.alloc(16 * 1048576, 1)); if (keep.length * 16 > 300) { clearInterval(t); process.stdout.write("REACHED"); process.exit(0); } }, 20);\n`);
    const run = (limit: number) =>
      new Promise<{ code: number | null; out: string }>((resolveRun) => {
        const c = spawn(process.execPath, [...STRIP, "--max-old-space-size=64", grow, String(limit)], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        c.stdout.on("data", (b: Buffer) => (out += b.toString()));
        c.on("exit", (code) => resolveRun({ code, out }));
      });
    // Heap limit 64 MB, yet 300 MB of Buffers are reached: "memory limit" must not be claimed for the heap flag.
    expect(await run(0)).toEqual({ code: 0, out: "REACHED" });
    // With a 200 MB RSS watchdog the same process is stopped.
    expect((await run(200)).code).toBe(EXIT_RSS_LIMIT);
  }, 60_000);

  describe("evaluator process contract (makeChildProcessEvaluator)", () => {
    const job = { unit: "test" } as never;
    const limits = (maxRuntimeMs: number) => ({ maxRuntimeMs, maxMemoryMb: 128 }) as never;
    const stub = (name: string, body: string) => makeChildProcessEvaluator(script(name, body), STRIP);

    it("normal completion returns the evaluation", async () => {
      const ev = stub("ok.mjs", `import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[3], JSON.stringify({ ok: true, evaluation: { done: true }, runtimeMs: 1, peakRssMb: 1 }));\n`);
      await expect(ev(job, limits(10_000), new AbortController().signal)).resolves.toMatchObject({ evaluation: { done: true } });
    }, 30_000);

    it("passes the heap limit, an RSS watchdog limit and the supervisor flag", async () => {
      const ev = stub("args.mjs", `import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[3], JSON.stringify({ ok: true, evaluation: { argv: process.argv.slice(4), flag: process.env.${SUPERVISOR_PIPE_ENV}, execArgv: process.execArgv }, runtimeMs: 1, peakRssMb: 1 }));\n`);
      const out = (await ev(job, limits(10_000), new AbortController().signal)).evaluation as unknown as { argv: string[]; flag: string; execArgv: string[] };
      expect(out.argv).toEqual(["10000", "128", String(rssLimitForHeap(128))]);
      expect(out.flag).toBe("1");
      expect(out.execArgv).toContain("--max-old-space-size=128");
    }, 30_000);

    it("runtime timeout kills a hung evaluator", async () => {
      const ev = stub("hang.mjs", `setInterval(() => {}, 1000);\n`);
      const started = Date.now();
      await expect(ev(job, limits(1_500), new AbortController().signal)).rejects.toMatchObject({ kind: "RUNTIME_LIMIT" });
      expect(Date.now() - started).toBeLessThan(20_000);
    }, 30_000);

    it("cancellation during evaluation kills it", async () => {
      const ev = stub("hang2.mjs", `setInterval(() => {}, 1000);\n`);
      const abort = new AbortController();
      setTimeout(() => abort.abort("cancel requested"), 500);
      const err = await ev(job, limits(60_000), abort.signal).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EvaluatorFailure);
      expect(err).toMatchObject({ kind: "KILLED" });
    }, 30_000);

    it("the RSS watchdog is reported as a memory stop, not a generic crash", async () => {
      const ev = stub("rss.mjs", `import { installRssWatchdog } from ${JSON.stringify(GUARDS)};\ninstallRssWatchdog(1, 20);\nsetInterval(() => {}, 1000);\n`);
      await expect(ev(job, limits(30_000), new AbortController().signal)).rejects.toThrow(/total-memory watchdog/);
    }, 30_000);
  });

  it("the trading worker's event loop stays responsive while a CPU-bound research tick runs", async () => {
    const burn = script("burn.mjs", `const end = Date.now() + 3000; let x = 0; while (Date.now() < end) x += Math.sqrt(x + 1); console.log(x > 0);\n`);
    let maxLag = 0;
    let last = performance.now();
    const probe = setInterval(() => {
      const now = performance.now();
      maxLag = Math.max(maxLag, now - last - 10);
      last = now;
    }, 10);
    const result = await runCampaignTick({ ...process.env, RESEARCH_CAMPAIGN_WORKER_ENABLED: "true" }, { cliPath: burn, ceilingMs: 30_000 });
    clearInterval(probe);
    expect(result).toMatchObject({ status: "RAN", exitCode: 0 });
    // The burn runs in another process; this loop only waits on its pipes.
    expect(maxLag).toBeLessThan(250);
  }, 60_000);

  it("detects (and, when required, insists on) an OS memory limit", () => {
    const files: Record<string, string> = { "/proc/self/cgroup": "0::/system.slice/odin-research.service\n", "/sys/fs/cgroup/system.slice/odin-research.service/memory.max": "2147483648\n" };
    const read = (p: string) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p]!;
    };
    const detected = detectOsMemoryLimit(read);
    if (process.platform === "linux") expect(detected).toMatchObject({ kind: "CGROUP_V2", maxBytes: 2_147_483_648 });
    else expect(detected.kind).toBe("NONE_DETECTED");
    expect(osIsolationRefusal({ kind: "NONE_DETECTED", reason: "x" }, {})).toBeNull();
    expect(osIsolationRefusal({ kind: "NONE_DETECTED", reason: "x" }, { RESEARCH_CAMPAIGN_REQUIRE_OS_ISOLATION: "true" })).toMatch(/^REFUSED/);
    expect(osIsolationRefusal({ kind: "CGROUP_V2_UNLIMITED", path: "p" }, { RESEARCH_CAMPAIGN_REQUIRE_OS_ISOLATION: "true" })).toMatch(/^REFUSED/);
    expect(osIsolationRefusal({ kind: "CGROUP_V2", maxBytes: 1, path: "p" }, { RESEARCH_CAMPAIGN_REQUIRE_OS_ISOLATION: "true" })).toBeNull();
  });

  it("the real evaluator, CLI and tick install the guards (wiring)", () => {
    const src = (f: string) => readFileSync(join(__dirname, f), "utf8");
    expect(src("campaign-evaluator.ts")).toMatch(/installSupervisorLiveness\(\);\n\s+installRssWatchdog\(Number\(rssArg\)\);/);
    expect(src("campaign-cli.ts")).toMatch(/async function main\(\): Promise<void> \{[\s\S]{0,400}installSupervisorLiveness\(\);/);
    expect(src("campaign-runner.ts")).toContain('stdio: ["pipe", "ignore", "pipe"], env: { NODE_ENV: process.env.NODE_ENV ?? "production", PATH: process.env.PATH ?? "", [SUPERVISOR_PIPE_ENV]: "1" }');
    expect(src("../campaign-job.ts")).toContain('stdio: ["pipe", "pipe", "pipe"]');
    expect(src("../campaign-job.ts")).toContain('[SUPERVISOR_PIPE_ENV]: "1"');
  });
});
