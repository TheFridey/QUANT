#define _GNU_SOURCE
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <sys/prctl.h>
#include <unistd.h>

/* x86_64 libseccomp BPF. Default action is EPERM.
 * Allowed: Node harness syscalls observed under bubblewrap, plus libc fallbacks.
 * getsockname and getsockopt stay allowed so Node can identify its stdio sockets.
 * Not allowed: execve, execveat, socket, connect, bind, listen, accept,
 * sendto, sendmsg, recvfrom, recvmsg, io_uring_setup, io_uring_enter,
 * ptrace, process_vm_readv, process_vm_writev, mount, unshare.
 * This is a seccomp filter, not a virtual machine. */
unsigned char odin_seccomp_bpf[] = {
  32, 0, 0, 0, 4, 0, 0, 0, 21, 0, 0, 74,
  62, 0, 0, 192, 32, 0, 0, 0, 0, 0, 0, 0,
  53, 0, 0, 1, 0, 0, 0, 64, 21, 0, 0, 71,
  255, 255, 255, 255, 21, 0, 69, 0, 0, 0, 0, 0,
  21, 0, 68, 0, 1, 0, 0, 0, 21, 0, 67, 0,
  3, 0, 0, 0, 21, 0, 66, 0, 5, 0, 0, 0,
  21, 0, 65, 0, 8, 0, 0, 0, 21, 0, 64, 0,
  9, 0, 0, 0, 21, 0, 63, 0, 10, 0, 0, 0,
  21, 0, 62, 0, 11, 0, 0, 0, 21, 0, 61, 0,
  12, 0, 0, 0, 21, 0, 60, 0, 13, 0, 0, 0,
  21, 0, 59, 0, 14, 0, 0, 0, 21, 0, 58, 0,
  15, 0, 0, 0, 21, 0, 57, 0, 16, 0, 0, 0,
  21, 0, 56, 0, 17, 0, 0, 0, 21, 0, 55, 0,
  19, 0, 0, 0, 21, 0, 54, 0, 20, 0, 0, 0,
  21, 0, 53, 0, 21, 0, 0, 0, 21, 0, 52, 0,
  24, 0, 0, 0, 21, 0, 51, 0, 25, 0, 0, 0,
  21, 0, 50, 0, 28, 0, 0, 0, 21, 0, 49, 0,
  32, 0, 0, 0, 21, 0, 48, 0, 35, 0, 0, 0,
  21, 0, 47, 0, 39, 0, 0, 0, 21, 0, 46, 0,
  51, 0, 0, 0, 21, 0, 45, 0, 55, 0, 0, 0,
  21, 0, 44, 0, 56, 0, 0, 0, 21, 0, 43, 0,
  60, 0, 0, 0, 21, 0, 42, 0, 61, 0, 0, 0,
  21, 0, 41, 0, 63, 0, 0, 0, 21, 0, 40, 0,
  72, 0, 0, 0, 21, 0, 39, 0, 79, 0, 0, 0,
  21, 0, 38, 0, 89, 0, 0, 0, 21, 0, 37, 0,
  97, 0, 0, 0, 21, 0, 36, 0, 102, 0, 0, 0,
  21, 0, 35, 0, 104, 0, 0, 0, 21, 0, 34, 0,
  107, 0, 0, 0, 21, 0, 33, 0, 108, 0, 0, 0,
  21, 0, 32, 0, 125, 0, 0, 0, 21, 0, 31, 0,
  131, 0, 0, 0, 21, 0, 30, 0, 157, 0, 0, 0,
  21, 0, 29, 0, 158, 0, 0, 0, 21, 0, 28, 0,
  186, 0, 0, 0, 21, 0, 27, 0, 202, 0, 0, 0,
  21, 0, 26, 0, 204, 0, 0, 0, 21, 0, 25, 0,
  217, 0, 0, 0, 21, 0, 24, 0, 218, 0, 0, 0,
  21, 0, 23, 0, 221, 0, 0, 0, 21, 0, 22, 0,
  228, 0, 0, 0, 21, 0, 21, 0, 230, 0, 0, 0,
  21, 0, 20, 0, 231, 0, 0, 0, 21, 0, 19, 0,
  233, 0, 0, 0, 21, 0, 18, 0, 1, 1, 0, 0,
  21, 0, 17, 0, 6, 1, 0, 0, 21, 0, 16, 0,
  14, 1, 0, 0, 21, 0, 15, 0, 15, 1, 0, 0,
  21, 0, 14, 0, 17, 1, 0, 0, 21, 0, 13, 0,
  25, 1, 0, 0, 21, 0, 12, 0, 34, 1, 0, 0,
  21, 0, 11, 0, 35, 1, 0, 0, 21, 0, 10, 0,
  36, 1, 0, 0, 21, 0, 9, 0, 37, 1, 0, 0,
  21, 0, 8, 0, 46, 1, 0, 0, 21, 0, 7, 0,
  53, 1, 0, 0, 21, 0, 6, 0, 62, 1, 0, 0,
  21, 0, 5, 0, 63, 1, 0, 0, 21, 0, 4, 0,
  70, 1, 0, 0, 21, 0, 3, 0, 76, 1, 0, 0,
  21, 0, 2, 0, 78, 1, 0, 0, 21, 0, 1, 0,
  179, 1, 0, 0, 6, 0, 0, 0, 1, 0, 5, 0,
  6, 0, 0, 0, 0, 0, 255, 127, 6, 0, 0, 0,
  0, 0, 0, 0,
};
unsigned int odin_seccomp_bpf_len = 616;

__attribute__((constructor)) static void odin_install_seccomp(void) {
  struct sock_fprog prog;
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) _exit(71);
  prog.len = (unsigned short)(odin_seccomp_bpf_len / 8);
  prog.filter = (struct sock_filter *)odin_seccomp_bpf;
  if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog) != 0) _exit(72);
}
