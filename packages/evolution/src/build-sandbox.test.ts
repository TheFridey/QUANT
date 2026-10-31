import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** The root postinstall runs this script, so it must never fail `pnpm install` (CI jobs without gcc). */
const script = fileURLToPath(new URL("../scripts/build-sandbox.mjs", import.meta.url));

describe("seccomp build script", () => {
  it("exits 0 with a clear message when gcc is not on PATH", () => {
    const emptyPath = mkdtempSync(join(tmpdir(), "odin-no-gcc-"));
    try {
      const result = spawnSync(process.execPath, [script], {
        encoding: "utf8",
        env: { PATH: emptyPath, Path: emptyPath },
        timeout: 30_000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/seccomp sandbox not built: (gcc is not installed|the committed profile is x86_64 Linux only)/);
    } finally {
      rmSync(emptyPath, { recursive: true, force: true });
    }
  });
});
