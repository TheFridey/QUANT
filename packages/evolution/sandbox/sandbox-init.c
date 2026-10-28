#define _GNU_SOURCE
#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

/*
 * prlimit executes this helper. The helper then execs Node with LD_PRELOAD set,
 * so the seccomp constructor runs inside Node. The filter is not installed on
 * prlimit, which still needs execve to start this process.
 */
int main(void) {
  const char *heap = getenv("ODIN_NODE_HEAP");
  char flag[64];
  char *argv[] = {"/node", flag, "/work/harness.mjs", NULL};
  char *envp[] = {"LD_PRELOAD=/seccomp.so", "PATH=/usr/bin", NULL};
  size_t i;

  if (heap == NULL || heap[0] == '\0') heap = "64";
  for (i = 0; heap[i] != '\0'; i++) {
    if (!isdigit((unsigned char)heap[i]) || i > 3) return 126;
  }
  if (snprintf(flag, sizeof(flag), "--max-old-space-size=%s", heap) < 0) return 126;
  execve("/node", argv, envp);
  return 127;
}
