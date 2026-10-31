/**
 * Source of truth for the sandbox seccomp allowlist (x86_64 only).
 *
 * `generateSeccompBpf()` emits the same program shape libseccomp produced for the
 * original hand-written array: check the audit arch, reject the x32 ABI, compare
 * the syscall number against each allowed entry, and return EPERM otherwise.
 * `sandbox/seccomp-preload.c` embeds the rendered bytes; `seccomp-profile.test.ts`
 * fails if the committed array drifts from this generator.
 *
 * Regenerate after changing the list: `pnpm --filter @odin/evolution seccomp:generate`.
 */

/** Allowed x86_64 syscalls observed for the Node harness under bubblewrap, plus libc fallbacks. */
export const SECCOMP_ALLOWED_SYSCALLS_X86_64: ReadonlyArray<readonly [name: string, nr: number]> = [
  ["read", 0],
  ["write", 1],
  ["close", 3],
  ["fstat", 5],
  ["lseek", 8],
  ["mmap", 9],
  ["mprotect", 10],
  ["munmap", 11],
  ["brk", 12],
  ["rt_sigaction", 13],
  ["rt_sigprocmask", 14],
  ["rt_sigreturn", 15],
  ["ioctl", 16],
  ["pread64", 17],
  ["readv", 19],
  ["writev", 20],
  ["access", 21],
  ["sched_yield", 24],
  ["mremap", 25],
  ["madvise", 28],
  ["dup", 32],
  ["nanosleep", 35],
  ["getpid", 39],
  ["getsockname", 51],
  ["getsockopt", 55],
  ["clone", 56],
  ["exit", 60],
  ["wait4", 61],
  ["uname", 63],
  ["fcntl", 72],
  ["getcwd", 79],
  ["readlink", 89],
  ["getrlimit", 97],
  ["getuid", 102],
  ["getgid", 104],
  ["geteuid", 107],
  ["getegid", 108],
  ["capget", 125],
  ["sigaltstack", 131],
  ["prctl", 157],
  ["arch_prctl", 158],
  ["gettid", 186],
  ["futex", 202],
  ["sched_getaffinity", 204],
  ["getdents64", 217],
  ["set_tid_address", 218],
  ["fadvise64", 221],
  ["clock_gettime", 228],
  ["clock_nanosleep", 230],
  ["exit_group", 231],
  ["epoll_ctl", 233],
  ["openat", 257],
  ["newfstatat", 262],
  ["pselect6", 270],
  ["ppoll", 271],
  ["set_robust_list", 273],
  ["epoll_pwait", 281],
  ["eventfd2", 290],
  ["epoll_create1", 291],
  ["dup3", 292],
  ["pipe2", 293],
  ["prlimit64", 302],
  ["getcpu", 309],
  ["getrandom", 318],
  ["memfd_create", 319],
  ["copy_file_range", 326],
  ["statx", 332],
  ["rseq", 334],
  ["clone3", 435],
];

const BPF_LD_W_ABS = 0x20;
const BPF_JEQ_K = 0x15;
const BPF_JGE_K = 0x35;
const BPF_RET_K = 0x06;
const AUDIT_ARCH_X86_64 = 0xc000003e;
const X32_SYSCALL_BIT = 0x40000000;
const SECCOMP_RET_KILL = 0x00000000;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_ERRNO_EPERM = 0x00050000 | 1;

type Instruction = { code: number; jt: number; jf: number; k: number };

export function generateSeccompBpf(
  allowed: ReadonlyArray<readonly [string, number]> = SECCOMP_ALLOWED_SYSCALLS_X86_64,
): Uint8Array {
  const numbers = allowed.map(([, nr]) => nr);
  if (numbers.some((nr, index) => index > 0 && nr <= numbers[index - 1]!)) {
    throw new Error("Seccomp allowlist must be sorted by syscall number with no duplicates");
  }
  const count = numbers.length;
  if (count === 0 || count > 250) throw new Error("Seccomp allowlist size is out of range for 8-bit jumps");
  // Layout: 5 header instructions, `count` comparisons, then ERRNO, ALLOW, KILL.
  const errnoAt = 5 + count;
  const allowAt = errnoAt + 1;
  const killAt = errnoAt + 2;
  const program: Instruction[] = [
    { code: BPF_LD_W_ABS, jt: 0, jf: 0, k: 4 },
    { code: BPF_JEQ_K, jt: 0, jf: killAt - 2, k: AUDIT_ARCH_X86_64 },
    { code: BPF_LD_W_ABS, jt: 0, jf: 0, k: 0 },
    { code: BPF_JGE_K, jt: 0, jf: 1, k: X32_SYSCALL_BIT },
    { code: BPF_JEQ_K, jt: 0, jf: killAt - 5, k: 0xffffffff },
    ...numbers.map((nr, index) => ({ code: BPF_JEQ_K, jt: allowAt - (5 + index) - 1, jf: 0, k: nr })),
    { code: BPF_RET_K, jt: 0, jf: 0, k: SECCOMP_RET_ERRNO_EPERM },
    { code: BPF_RET_K, jt: 0, jf: 0, k: SECCOMP_RET_ALLOW },
    { code: BPF_RET_K, jt: 0, jf: 0, k: SECCOMP_RET_KILL },
  ];
  const bytes = new Uint8Array(program.length * 8);
  const view = new DataView(bytes.buffer);
  program.forEach((insn, index) => {
    view.setUint16(index * 8, insn.code, true);
    view.setUint8(index * 8 + 2, insn.jt);
    view.setUint8(index * 8 + 3, insn.jf);
    view.setUint32(index * 8 + 4, insn.k, true);
  });
  return bytes;
}

/** Render the C array block embedded between the GENERATED markers in seccomp-preload.c. */
export function renderSeccompBpfC(bytes: Uint8Array = generateSeccompBpf()): string {
  const rows: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 12) {
    rows.push(`  ${Array.from(bytes.subarray(offset, offset + 12)).join(", ")},`);
  }
  return [
    "unsigned char odin_seccomp_bpf[] = {",
    ...rows,
    "};",
    `unsigned int odin_seccomp_bpf_len = ${bytes.length};`,
  ].join("\n");
}

/** Parse the byte array committed in seccomp-preload.c. */
export function parseCommittedSeccompBpf(cSource: string): Uint8Array {
  const start = cSource.indexOf("odin_seccomp_bpf[] = {");
  const end = cSource.indexOf("};", start);
  if (start < 0 || end < 0) throw new Error("odin_seccomp_bpf array not found");
  const body = cSource.slice(cSource.indexOf("{", start) + 1, end);
  return Uint8Array.from(
    body
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map(Number),
  );
}
