import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { bubblewrapCiProbeArgs, sandboxLibraryMounts } from "./sandbox-runner.js";

describe("bubblewrap CI probe", () => {
  it("uses the runner library mounts and the workflow runs that command", () => {
    const mounts = sandboxLibraryMounts();
    const probe = bubblewrapCiProbeArgs();
    expect(probe.join(" ")).toContain(mounts.join(" "));
    expect(probe).toEqual(expect.arrayContaining(["--unshare-net", "--clearenv", "--uid", "65534", "--gid", "65534"]));
    expect(mounts).toEqual(["--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64"]);
    const workflow = readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8");
    expect(workflow).toContain(`bwrap ${probe.join(" ")}`);
    expect(workflow).not.toContain("bwrap --unshare-user --die-with-parent --ro-bind /usr /usr --tmpfs /tmp -- /usr/bin/true");
    const runner = readFileSync(new URL("./sandbox-runner.ts", import.meta.url), "utf8");
    expect(runner).toContain("...sandboxLibraryMounts()");
  });

  it("executes the same probe command the workflow runs", () => {
    const version = spawnSync("bwrap", ["--version"], { encoding: "utf8" });
    expect(version.status, version.stderr || version.error?.message).toBe(0);
    const probe = spawnSync("bwrap", bubblewrapCiProbeArgs(), { encoding: "utf8" });
    expect(probe.status, probe.stderr || probe.error?.message).toBe(0);
    expect(probe.stdout).toBe("");
  });
});
