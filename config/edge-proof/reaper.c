/* Linux-only, non-root namespace PID1. No shell, threads, deadlines or logs.
 * EDR1: magic[4], op[1], zero[3], sequenceBE[4], coordinatorPIDBE[4],
 * nonce[32], context[32]. Replies echo the request with op | 0x80.
 * A DRAIN reply means one completed waitpid pass, never an empty workload.
 */
#define _GNU_SOURCE
#include <sys/socket.h>
#include <sys/select.h>
#include <sys/wait.h>
#include <sys/types.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

enum { FRAME = 80, HELLO = 1, DRAIN = 2, FINISH = 3, FAILURE = 125 };
static volatile sig_atomic_t child_signal, interrupt_signal, terminate_signal;
static void latch(int signal) {
  if (signal == SIGCHLD) child_signal = 1;
  if (signal == SIGINT) interrupt_signal = 1;
  if (signal == SIGTERM) terminate_signal = 1;
}
static uint32_t u32(const unsigned char *p) {
  return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) |
         ((uint32_t)p[2] << 8) | p[3];
}
static int hex32(const char *text, unsigned char *out) {
  if (strlen(text) != 64) return -1;
  for (int i = 0; i < 32; i++) {
    unsigned value = 0;
    for (int j = 0; j < 2; j++) {
      unsigned char c = (unsigned char)text[2 * i + j];
      if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return -1;
      value = value * 16 + (c <= '9' ? c - '0' : c - 'a' + 10);
    }
    out[i] = (unsigned char)value;
  }
  return 0;
}
/* Only this function waits. Reaping coordinator revokes active RPC authority. */
static int drain(pid_t coordinator, int *exited, int *status) {
  for (;;) {
    int value;
    pid_t pid = waitpid(-1, &value, WNOHANG);
    if (pid > 0) {
      if (pid == coordinator) { *exited = 1; *status = value; }
      continue;
    }
    if (pid == 0) return 0;
    if (errno == EINTR) continue;
    if (errno == ECHILD && *exited) return 1;
    return -1;
  }
}
/* Ancillary storage is fresh for EACH fragment. Close any received rights even
 * on a rejected frame; the kernel closes rights lost to ancillary truncation. */
static ssize_t receive(int fd, unsigned char *bytes, size_t available, pid_t pid) {
  union { struct cmsghdr align; unsigned char bytes[CMSG_SPACE(sizeof(struct ucred)) + CMSG_SPACE(16 * sizeof(int))]; } ancillary;
  struct iovec iov = { bytes, available };
  struct msghdr message;
  memset(&message, 0, sizeof(message));
  memset(&ancillary, 0, sizeof(ancillary));
  message.msg_iov = &iov; message.msg_iovlen = 1;
  message.msg_control = ancillary.bytes; message.msg_controllen = sizeof(ancillary);
  ssize_t n = recvmsg(fd, &message, MSG_CMSG_CLOEXEC);
  if (n <= 0) return n;
  int credentials = 0, invalid = message.msg_flags & (MSG_CTRUNC | MSG_TRUNC);
  for (struct cmsghdr *c = CMSG_FIRSTHDR(&message); c; c = CMSG_NXTHDR(&message, c)) {
    if (c->cmsg_level == SOL_SOCKET && c->cmsg_type == SCM_CREDENTIALS && c->cmsg_len == CMSG_LEN(sizeof(struct ucred))) {
      struct ucred sender; memcpy(&sender, CMSG_DATA(c), sizeof(sender));
      credentials++;
      if (sender.pid != pid || sender.uid != getuid() || sender.gid != getgid()) invalid = 1;
    } else {
      invalid = 1;
      if (c->cmsg_level == SOL_SOCKET && c->cmsg_type == SCM_RIGHTS && c->cmsg_len >= CMSG_LEN(0)) {
        size_t count = (c->cmsg_len - CMSG_LEN(0)) / sizeof(int);
        for (size_t i = 0; i < count; i++) { int received; memcpy(&received, (unsigned char *)CMSG_DATA(c) + i * sizeof(int), sizeof(int)); close(received); }
      }
    }
  }
  if (invalid || credentials != 1) { errno = EPROTO; return -1; }
  return n;
}
static int valid_frame(const unsigned char *frame, pid_t pid, const unsigned char *identity, uint32_t next, int hello) {
  return !memcmp(frame, "EDR1", 4) && frame[5] == 0 && frame[6] == 0 && frame[7] == 0 &&
    u32(frame + 8) == next && next != UINT32_MAX && u32(frame + 12) == (uint32_t)pid &&
    !memcmp(frame + 16, identity, 64) &&
    (hello ? frame[4] == DRAIN || frame[4] == FINISH : frame[4] == HELLO);
}
static int nonblocking(int fd) {
  int flags = fcntl(fd, F_GETFL);
  return flags < 0 ? -1 : fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}
static int fd_fixture(void) {
  errno = 0;
  return fcntl(3, F_GETFD) == -1 && errno == EBADF ? 0 : FAILURE;
}
/* FD2 is the original Docker stderr channel, owned only by this executable.
 * Before exec the child replaces FD2 with stdout; it never inherits this writer.
 * This record is private, and is accepted only with the independently admitted
 * PID1 executable/CID and exact complete original attach-channel capture. */
static int terminal(const char *nonce, const char *context, pid_t coordinator,
                    uint32_t sequence, int status, unsigned faults, int finishing) {
  unsigned kind = WIFEXITED(status) ? 1 : WIFSIGNALED(status) ? 2 : 0;
  unsigned value = kind == 1 ? (unsigned)WEXITSTATUS(status) : kind == 2 ? (unsigned)WTERMSIG(status) : 0;
  char record[256];
  int n = snprintf(record, sizeof(record), "EDT1:%s:%s:%08x:%08x:%u:%08x:%08x:%u:1\n",
                   nonce, context, (unsigned)coordinator, sequence, kind, value, faults, finishing ? 1u : 0u);
  if (n <= 0 || (size_t)n >= sizeof(record)) return -1;
  size_t sent = 0;
  while (sent < (size_t)n) {
    ssize_t count = write(STDERR_FILENO, record + sent, (size_t)n - sent);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return -1;
    sent += (size_t)count;
  }
  return close(STDERR_FILENO);
}
/* No RPC/HELLO or product permit exists in this mode. The original coordinator
 * holds a real child live, then waitable-Z, while sampling through its unchanged
 * privateProcesses. Every child is joined before this fixture can exit zero. */
static int census_fixture(void) {
  if (getpid() == 1) return FAILURE;
  int release[2]; if (pipe2(release, O_CLOEXEC)) return FAILURE;
  pid_t child = fork(); if (child < 0) return FAILURE;
  if (!child) {
    close(release[1]); char byte; ssize_t n;
    do { n = read(release[0], &byte, 1); } while (n < 0 && errno == EINTR);
    close(release[0]); _exit(n == 1 ? 0 : FAILURE);
  }
  close(release[0]); int failed = 0; char byte; char line[32];
  int size = snprintf(line, sizeof(line), "LIVE:%u\n", (unsigned)child);
  if (size <= 0 || (size_t)size >= sizeof(line) || write(STDOUT_FILENO, line, (size_t)size) != size) failed = 1;
  ssize_t n; do { n = read(STDIN_FILENO, &byte, 1); } while (n < 0 && errno == EINTR);
  if (n != 1 || byte != 'L') failed = 1;
  if (write(release[1], "x", 1) != 1) failed = 1;
  close(release[1]);
  siginfo_t info; memset(&info, 0, sizeof(info)); int rc;
  do { rc = waitid(P_PID, (id_t)child, &info, WEXITED | WNOWAIT); } while (rc < 0 && errno == EINTR);
  if (rc || info.si_pid != child || info.si_code != CLD_EXITED || info.si_status != 0) failed = 1;
  size = snprintf(line, sizeof(line), "ZOMBIE:%u\n", (unsigned)child);
  if (size <= 0 || (size_t)size >= sizeof(line) || write(STDOUT_FILENO, line, (size_t)size) != size) failed = 1;
  do { n = read(STDIN_FILENO, &byte, 1); } while (n < 0 && errno == EINTR);
  if (n != 1 || byte != 'Z') failed = 1;
  int status; pid_t waited; do { waited = waitpid(child, &status, 0); } while (waited < 0 && errno == EINTR);
  if (waited != child || !WIFEXITED(status) || WEXITSTATUS(status)) failed = 1;
  return failed ? FAILURE : 0;
}
/* Hosted-only startup fixture: PID1 must adopt a genuinely waitable orphan.
 * One blocking WNOWAIT observation establishes Z; it is not a completion loop.
 * The same production drain function must actually reap it and its parent.
 */
static int orphan_fixture(void) {
  int pipefd[2], release[2]; if (pipe2(pipefd, O_CLOEXEC) < 0 || pipe2(release, O_CLOEXEC) < 0) return -1;
  pid_t intermediate = fork();
  if (intermediate == -1) { close(pipefd[0]); close(pipefd[1]); return -1; }
  if (intermediate == 0) {
    close(pipefd[0]); pid_t orphan = fork();
    if (orphan < 0) _exit(FAILURE);
    if (orphan == 0) {
      close(pipefd[1]); close(release[1]); char byte; ssize_t n;
      do { n = read(release[0], &byte, 1); } while (n < 0 && errno == EINTR);
      close(release[0]); _exit(n == 1 ? 0 : FAILURE);
    }
    close(release[0]); close(release[1]);
    ssize_t n; do { n = write(pipefd[1], &orphan, sizeof(orphan)); } while (n < 0 && errno == EINTR);
    close(pipefd[1]); _exit(n == (ssize_t)sizeof(orphan) ? 0 : FAILURE);
  }
  close(pipefd[1]); close(release[0]); pid_t orphan = 0; size_t have = 0;
  while (have < sizeof(orphan)) {
    ssize_t n = read(pipefd[0], (unsigned char *)&orphan + have, sizeof(orphan) - have);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) { close(pipefd[0]); return -1; } have += (size_t)n;
  }
  close(pipefd[0]);
  siginfo_t info; memset(&info, 0, sizeof(info));
  int rc; do { rc = waitid(P_PID, (id_t)intermediate, &info, WEXITED | WNOWAIT); } while (rc < 0 && errno == EINTR);
  if (rc < 0 || info.si_pid != intermediate || info.si_code != CLD_EXITED || info.si_status != 0) return -1;
  // A completed pass with a held live orphan MUST return zero, not ECHILD.
  int exited = 0, status = 0;
  if (drain(intermediate, &exited, &status) != 0 || !exited || !WIFEXITED(status) || WEXITSTATUS(status) != 0) return -1;
  ssize_t written; do { written = write(release[1], "x", 1); } while (written < 0 && errno == EINTR);
  close(release[1]); if (written != 1) return -1;
  memset(&info, 0, sizeof(info));
  do { rc = waitid(P_PID, (id_t)orphan, &info, WEXITED | WNOWAIT); } while (rc < 0 && errno == EINTR);
  if (rc < 0 || info.si_pid != orphan || info.si_code != CLD_EXITED || info.si_status != 0) return -1;
  return drain(intermediate, &exited, &status) == 1 && exited && WIFEXITED(status) && WEXITSTATUS(status) == 0 ? 0 : -1;
}
static int credential_fixture(void) {
  int pair[2], enabled = 1; unsigned char frame[FRAME] = {0}, received[FRAME];
  if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, pair) || setsockopt(pair[0], SOL_SOCKET, SO_PASSCRED, &enabled, sizeof(enabled))) return -1;
  if (send(pair[1], frame, FRAME, MSG_NOSIGNAL) != FRAME || receive(pair[0], received, FRAME, getpid()) != FRAME) return -1;
  if (send(pair[1], frame, FRAME, MSG_NOSIGNAL) != FRAME) return -1;
  errno = 0;
  if (receive(pair[0], received, FRAME, getpid() + 1) != -1 || errno != EPROTO) return -1;
  int a = close(pair[0]), b = close(pair[1]); return a || b ? -1 : 0;
}
int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "--check-fd")) return fd_fixture();
  if (argc == 2 && !strcmp(argv[1], "--fixture-census")) return census_fixture();
  /* Held-ACK fixture uses the same server and original owned-process deadline.
   * It is run only by the admitted coordinator before the product pipeline. */
  int hold = argc > 1 && !strcmp(argv[1], "--fixture-hold");
  if (hold) { argc--; argv++; }
  if (argc != 8 || (!hold && getpid() != 1) || getuid() == 0 || getgid() == 0 ||
      strcmp(argv[1], "/usr/local/bin/node") || strcmp(argv[2], "/opt/edge-input/scripts/edge-proof.mjs") ||
      strcmp(argv[3], hold ? "container-reaper-probe" : "container-init")) return FAILURE;
  unsigned char identity[64];
  if (hex32(argv[4], identity) || hex32(argv[5], identity + 32)) return FAILURE;
  sigset_t blocked, original, waiting;
  sigemptyset(&blocked); sigaddset(&blocked, SIGCHLD); sigaddset(&blocked, SIGINT); sigaddset(&blocked, SIGTERM); sigaddset(&blocked, SIGPIPE);
  if (sigprocmask(SIG_BLOCK, &blocked, &original)) return FAILURE;
  struct sigaction action; memset(&action, 0, sizeof(action)); action.sa_handler = latch; sigemptyset(&action.sa_mask);
  if (sigaction(SIGCHLD, &action, NULL) || sigaction(SIGINT, &action, NULL) || sigaction(SIGTERM, &action, NULL)) return FAILURE;
  waiting = original; sigdelset(&waiting, SIGCHLD); sigdelset(&waiting, SIGINT); sigdelset(&waiting, SIGTERM); sigaddset(&waiting, SIGPIPE);
  if (!hold && (orphan_fixture() || credential_fixture())) return FAILURE;
  int pair[2], enabled = 1;
  if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, pair)) return FAILURE;
  if (setsockopt(pair[0], SOL_SOCKET, SO_PASSCRED, &enabled, sizeof(enabled)) || nonblocking(pair[0])) return FAILURE;
  pid_t coordinator = fork();
  if (coordinator == -1) return FAILURE;
  if (coordinator == 0) {
    close(pair[0]);
    if (dup2(STDOUT_FILENO, STDERR_FILENO) < 0) _exit(FAILURE);
    if (pair[1] != 3) { if (dup2(pair[1], 3) < 0) _exit(FAILURE); close(pair[1]); }
    if (fcntl(3, F_SETFD, 0) || sigprocmask(SIG_SETMASK, &original, NULL)) _exit(FAILURE);
    execv(argv[1], argv + 1); _exit(FAILURE);
  }
  close(pair[1]); int fd = pair[0];
  int fault = 0, exited = 0, status = 0, hello = 0, finishing = 0, eof = 0, stopped = 0;
  uint32_t next = 1; unsigned char frame[FRAME]; size_t received = 0, sent = 0; int reply = 0;
  for (;;) {
    if (interrupt_signal || terminate_signal) {
      int signal = terminate_signal ? SIGTERM : SIGINT; interrupt_signal = terminate_signal = 0;
      fault |= 1;
      if (!exited && kill(coordinator, signal) && errno != ESRCH) fault |= 2;
      stopped = 1;
    }
    child_signal = 0;
    int empty = drain(coordinator, &exited, &status);
    if (empty < 0) fault |= 4;
    if (exited && !finishing) fault |= 8;
    if (exited && empty == 1 && (fault || eof)) {
      if (fd >= 0 && close(fd)) fault |= 16;
      if (!hold && terminal(argv[4], argv[5], coordinator, next - 1, status, (unsigned)fault, finishing)) return FAILURE;
      if (fault || !finishing || !eof || !WIFEXITED(status)) return FAILURE;
      return WEXITSTATUS(status);
    }
    if (fault) {
      if (fd >= 0) { if (close(fd)) fault |= 16; fd = -1; }
      if (!exited && !stopped) { if (kill(coordinator, SIGTERM) && errno != ESRCH) fault |= 2; stopped = 1; }
    }
    fd_set reads, writes; FD_ZERO(&reads); FD_ZERO(&writes);
    if (fd >= FD_SETSIZE) { fault |= 32; continue; }
    if (fd >= 0) { FD_SET(fd, &reads); if (reply && !(hold && frame[4] == (DRAIN | 0x80))) FD_SET(fd, &writes); }
    int ready = pselect(fd + 1, &reads, &writes, NULL, NULL, &waiting);
    if (ready < 0) { if (errno != EINTR) fault |= 32; continue; }
    if (fd >= 0 && FD_ISSET(fd, &reads)) {
      unsigned char extra;
      ssize_t n = receive(fd, reply || finishing ? &extra : frame + received, reply || finishing ? 1 : FRAME - received, coordinator);
      if (n == 0) {
        eof = 1; if (!finishing || reply) fault |= 64; if (close(fd)) fault |= 16; fd = -1;
      } else if (n < 0) { if (errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK) fault |= 64; }
      else if (reply || finishing) fault |= 128;
      else {
        received += (size_t)n;
        if (received == FRAME) {
          if (!valid_frame(frame, coordinator, identity, next, hello)) { fault |= 128; continue; }
          int drained = drain(coordinator, &exited, &status);
          if (drained != 0 || exited) { fault |= 4; continue; }
          hello = 1; if (frame[4] == FINISH) finishing = 1;
          frame[4] |= 0x80; reply = 1; sent = 0; next++;
        }
      }
    }
    if (fd >= 0 && FD_ISSET(fd, &writes) && reply && !fault) {
      ssize_t n = send(fd, frame + sent, FRAME - sent, MSG_NOSIGNAL);
      if (n < 0) { if (errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK) fault |= 256; }
      else if (n == 0) fault |= 256;
      else { sent += (size_t)n; if (sent == FRAME) { reply = 0; received = 0; } }
    }
  }
}
