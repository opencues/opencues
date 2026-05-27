// scm-rights.ts — FFI for passing file descriptors over a unix socket.
//
// Used by the oc-editd daemon's FD-passing path (Option A in
// DAEMON-PLAN.md). The popup is a thin shim: it connects to the
// daemon, hands its stdin/stdout PTY fds over via SCM_RIGHTS, then
// waits for the result buffer on the same socket. The daemon dup2's
// the received fds onto its own 0/1/2 and renders directly into the
// popup PTY — the warm @opentui/core + @opencues/runtime state is
// reused across popups, saving the ~600-800ms cold-start budget.
//
// Why FFI: `Bun.listen({unix})` and Node's `net.createServer` give us
// the connection but not the ancillary-data channel (cmsg). FD passing
// requires sendmsg(2) / recvmsg(2) with SOL_SOCKET / SCM_RIGHTS — only
// reachable via libc. We use Bun's net layer for accept() (so the
// event loop sees connections) and FFI only for the cmsg work on the
// already-accepted fd.
//
// Platform: Linux glibc x86_64. macOS would need a separate variant
// (different struct layouts). musl untested.
//
// Linux glibc 64-bit struct layouts (from /usr/include/bits/socket.h):
//
//   struct msghdr {        // 56 bytes total
//     void         *msg_name;        // 8
//     socklen_t     msg_namelen;     // 4 + 4 pad
//     struct iovec *msg_iov;         // 8
//     size_t        msg_iovlen;      // 8
//     void         *msg_control;     // 8
//     size_t        msg_controllen;  // 8
//     int           msg_flags;       // 4 + 4 pad
//   };
//
//   struct iovec {         // 16 bytes total
//     void  *iov_base;     // 8
//     size_t iov_len;      // 8
//   };
//
//   struct cmsghdr {       // 16 bytes total (glibc: cmsg_len is size_t)
//     size_t cmsg_len;     // 8 — length of cmsghdr + data
//     int    cmsg_level;   // 4
//     int    cmsg_type;    // 4
//     // followed by ALIGN(N*sizeof(int)) bytes of fds
//   };
//
// CMSG_ALIGN(len) = (len + 7) & ~7     (8-byte alignment on x86_64)
// CMSG_LEN(len)   = 16 + len
// CMSG_SPACE(len) = 16 + CMSG_ALIGN(len)

import { dlopen, FFIType, ptr, read, suffix } from 'bun:ffi';

// ─── libc bindings ────────────────────────────────────────────────────

const libc = dlopen(`libc.${suffix}.6`, {
  socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  bind: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  listen: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  accept: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  connect: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  sendmsg: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i64 },
  recvmsg: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i64 },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
  dup2: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  __errno_location: { args: [], returns: FFIType.ptr },
}).symbols;

// fcntl commands
const F_GETFL = 3;
const F_SETFL = 4;
const O_NONBLOCK = 0o4000;  // Linux

/**
 * Flip a fd to blocking mode. Returns the previous flags so the
 * caller can restore them. Bun's net sockets are O_NONBLOCK, which
 * makes recvmsg return EAGAIN immediately — we need to block for
 * the FD-passing round-trip.
 */
export function setBlocking(fd: number): number {
  const flags = libc.fcntl(fd, F_GETFL, 0);
  if (flags < 0) throw new Error(`fcntl(F_GETFL) failed: errno=${errno()}`);
  const next = flags & ~O_NONBLOCK;
  if (next !== flags) {
    const r = libc.fcntl(fd, F_SETFL, next);
    if (r < 0) throw new Error(`fcntl(F_SETFL, blocking) failed: errno=${errno()}`);
  }
  return flags;
}

/** Restore the flags returned by setBlocking(). */
export function restoreFlags(fd: number, flags: number): void {
  libc.fcntl(fd, F_SETFL, flags);
}

function errno(): number {
  const p = libc.__errno_location();
  if (!p) return 0;
  // errno is a 32-bit int
  return read.i32(p, 0);
}

// ─── Constants ────────────────────────────────────────────────────────

const SOL_SOCKET = 1;
const SCM_RIGHTS = 0x01;

const CMSGHDR_SIZE = 16;
const MSGHDR_SIZE = 56;
const IOVEC_SIZE = 16;

function cmsgAlign(n: number): number { return (n + 7) & ~7; }
function cmsgLen(dataLen: number): number { return CMSGHDR_SIZE + dataLen; }
function cmsgSpace(dataLen: number): number { return CMSGHDR_SIZE + cmsgAlign(dataLen); }

// ─── Send: pack and send fds with a payload ──────────────────────────

/**
 * Send file descriptors plus a payload over a connected unix socket fd.
 * Returns number of bytes of payload sent, or -1 on error.
 *
 * payload may be empty (a single 0-byte iov is sent — SCM_RIGHTS
 * requires at least one byte of "real" data on the wire).
 */
export function sendFds(sockFd: number, fds: ReadonlyArray<number>, payload: Uint8Array): number {
  // Need at least 1 byte of "real" data — Linux silently drops cmsg
  // when iov_len is 0. Use a single space if caller passed empty.
  const iovData = payload.length > 0 ? payload : new Uint8Array([0x20]);

  // Build cmsg buffer: header + ALIGN(fd_data)
  const fdsBytes = fds.length * 4;
  const cmsgTotal = cmsgSpace(fdsBytes);
  const cmsgBuf = new Uint8Array(cmsgTotal);
  const cmsgView = new DataView(cmsgBuf.buffer, cmsgBuf.byteOffset, cmsgBuf.byteLength);
  cmsgView.setBigUint64(0, BigInt(cmsgLen(fdsBytes)), true);  // cmsg_len = size_t LE
  cmsgView.setInt32(8, SOL_SOCKET, true);
  cmsgView.setInt32(12, SCM_RIGHTS, true);
  for (let i = 0; i < fds.length; i++) {
    cmsgView.setInt32(CMSGHDR_SIZE + i * 4, fds[i]!, true);
  }

  // Build iovec[1]
  const iovec = new Uint8Array(IOVEC_SIZE);
  const iovView = new DataView(iovec.buffer, iovec.byteOffset, iovec.byteLength);
  iovView.setBigUint64(0, BigInt(ptr(iovData)), true);
  iovView.setBigUint64(8, BigInt(iovData.length), true);

  // Build msghdr
  const msg = new Uint8Array(MSGHDR_SIZE);
  const mv = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  // msg_name = NULL (already zero)
  // msg_namelen = 0 (already zero)
  mv.setBigUint64(16, BigInt(ptr(iovec)), true);  // msg_iov
  mv.setBigUint64(24, 1n, true);                  // msg_iovlen
  mv.setBigUint64(32, BigInt(ptr(cmsgBuf)), true); // msg_control
  mv.setBigUint64(40, BigInt(cmsgTotal), true);   // msg_controllen
  // msg_flags = 0

  const n = Number(libc.sendmsg(sockFd, ptr(msg), 0));
  if (n < 0) {
    throw new Error(`sendmsg failed: errno=${errno()}`);
  }
  return n;
}

// ─── Receive: read payload and extract fds ───────────────────────────

export interface RecvResult {
  fds: number[];
  payload: Uint8Array;
  /** Number of payload bytes actually written by recvmsg. */
  bytes: number;
}

/**
 * Block on recvmsg until a frame arrives, return the fds + payload
 * bytes. payloadMax is the upper bound on the in-band data we'll read
 * in one call (4 KiB is plenty for our protocol).
 *
 * Returns null if the peer closed before sending anything (n === 0).
 * Throws on any other error.
 */
export function recvFds(sockFd: number, maxFds = 4, payloadMax = 4096): RecvResult | null {
  const iovData = new Uint8Array(payloadMax);

  const cmsgTotal = cmsgSpace(maxFds * 4);
  const cmsgBuf = new Uint8Array(cmsgTotal);

  const iovec = new Uint8Array(IOVEC_SIZE);
  const iovView = new DataView(iovec.buffer, iovec.byteOffset, iovec.byteLength);
  iovView.setBigUint64(0, BigInt(ptr(iovData)), true);
  iovView.setBigUint64(8, BigInt(iovData.length), true);

  const msg = new Uint8Array(MSGHDR_SIZE);
  const mv = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  mv.setBigUint64(16, BigInt(ptr(iovec)), true);
  mv.setBigUint64(24, 1n, true);
  mv.setBigUint64(32, BigInt(ptr(cmsgBuf)), true);
  mv.setBigUint64(40, BigInt(cmsgTotal), true);

  const n = Number(libc.recvmsg(sockFd, ptr(msg), 0));
  if (n < 0) {
    throw new Error(`recvmsg failed: errno=${errno()}`);
  }
  if (n === 0) return null;

  // Walk the cmsg buffer. The kernel writes the actual size into
  // msg_controllen — read it back.
  const actualCmsgLen = Number(mv.getBigUint64(40, true));
  const cmsgView = new DataView(cmsgBuf.buffer, cmsgBuf.byteOffset, cmsgBuf.byteLength);
  const fds: number[] = [];
  let off = 0;
  while (off + CMSGHDR_SIZE <= actualCmsgLen) {
    const len = Number(cmsgView.getBigUint64(off, true));
    if (len < CMSGHDR_SIZE) break;
    const level = cmsgView.getInt32(off + 8, true);
    const type = cmsgView.getInt32(off + 12, true);
    if (level === SOL_SOCKET && type === SCM_RIGHTS) {
      const dataLen = len - CMSGHDR_SIZE;
      const dataStart = off + CMSGHDR_SIZE;
      for (let i = 0; i < dataLen; i += 4) {
        fds.push(cmsgView.getInt32(dataStart + i, true));
      }
    }
    // Advance to next cmsg, aligning length to 8.
    off += cmsgSpace(len - CMSGHDR_SIZE);
  }

  return { fds, payload: iovData.subarray(0, n), bytes: n };
}

// ─── dup2 / close ────────────────────────────────────────────────────

export function dup2(oldFd: number, newFd: number): void {
  const r = libc.dup2(oldFd, newFd);
  if (r < 0) throw new Error(`dup2(${oldFd}→${newFd}) failed: errno=${errno()}`);
}

export function closeFd(fd: number): void {
  libc.close(fd);
}
