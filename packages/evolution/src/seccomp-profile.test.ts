import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SECCOMP_ALLOWED_SYSCALLS_X86_64,
  generateSeccompBpf,
  parseCommittedSeccompBpf,
  renderSeccompBpfC,
} from "./seccomp-profile.js";

const committed = readFileSync(new URL("../sandbox/seccomp-preload.c", import.meta.url), "utf8");

describe("seccomp profile generator", () => {
  it("reproduces the committed BPF array byte for byte", () => {
    const generated = generateSeccompBpf();
    expect(Array.from(parseCommittedSeccompBpf(committed))).toEqual(Array.from(generated));
    expect(committed).toContain(`odin_seccomp_bpf_len = ${generated.length};`);
    expect(committed.replace(/\r\n/g, "\n")).toContain(renderSeccompBpfC(generated));
  });

  it("matches the committed SHA-256 of the generated BPF program", () => {
    const expected = readFileSync(new URL("../sandbox/seccomp-bpf.sha256", import.meta.url), "utf8").trim();
    expect(createHash("sha256").update(generateSeccompBpf()).digest("hex")).toBe(expected);
  });

  it("keeps process, network and tracing syscalls off the allowlist", () => {
    const names = new Set(SECCOMP_ALLOWED_SYSCALLS_X86_64.map(([name]) => name));
    for (const forbidden of [
      "execve",
      "execveat",
      "socket",
      "connect",
      "bind",
      "listen",
      "accept",
      "sendto",
      "sendmsg",
      "recvfrom",
      "recvmsg",
      "io_uring_setup",
      "io_uring_enter",
      "ptrace",
      "process_vm_readv",
      "process_vm_writev",
      "mount",
      "unshare",
    ]) {
      expect(names.has(forbidden), forbidden).toBe(false);
    }
  });

  it("defaults to EPERM and kills foreign architectures", () => {
    const bytes = generateSeccompBpf();
    const view = new DataView(bytes.buffer);
    const k = (index: number) => view.getUint32(index * 8 + 4, true);
    const count = bytes.length / 8;
    expect(k(1)).toBe(0xc000003e);
    expect(k(count - 3)).toBe(0x00050001);
    expect(k(count - 2)).toBe(0x7fff0000);
    expect(k(count - 1)).toBe(0);
  });

  it("rejects an unsorted allowlist", () => {
    expect(() => generateSeccompBpf([["write", 1], ["read", 0]])).toThrow(/sorted/);
  });
});
