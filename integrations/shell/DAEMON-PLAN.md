# oc-editd — long-lived oc-edit daemon (handoff)

Status: **Option B (partial daemon, no FD passing) is built and shipped.**
The FD-passing path (Option A) remains design-only. Read the
"Measured: Option B saves ~10ms, not 200-400ms" section at the bottom
before deciding whether to invest in Option A.

This doc is the fresh-session entry point — read it end-to-end before
writing any code, and amend it as you learn things.

---

## What problem this solves

Every time the user presses Ctrl+Alt+S inside `oc-shell`, the tmux popup
spawns a fresh `bun` process that:

1. Loads `@opentui/core` + `@opentui/solid` (terminal renderer, ~300ms)
2. Loads `@opencues/runtime` + `@opencues/core` (~200ms)
3. Reads + parses `~/.cues/CUES.md`, `OPENCUES.md`, `USER.md`,
   and every `blanks/*/BLANK.md` (~100-200ms)
4. Builds the Resolver, blanks registry, dyn-defs, highlight state,
   span-fill state, selector-satellite state
5. Mounts the SolidJS app and renders into the popup PTY

Cold launch lands the visible UI at ~1s. The user perceives this as
sluggish. We've already eliminated the easy wins (see "What was tried
and ruled out" below). The remaining lever is keeping a process alive
that's done steps 1-4 already, and reusing it across popups.

Target: warm popup launch in ~50-150ms (socket round-trip +
file-descriptor handoff + render).

---

## Architecture

```
shell start
  ├── tmux server (vendored)
  └── oc-editd daemon (background, bun process)
        ├── all modules loaded
        ├── ConfigLoader done
        ├── Resolver built
        └── unix socket: $XDG_RUNTIME_DIR/oc-editd-$SHELLPID.sock

popup (Ctrl+Alt+S)
  └── oc-popup script
        ├── connect to $OPENCUES_OCEDITD_SOCK
        ├── SCM_RIGHTS: send stdin (fd 0) + stdout (fd 1) of the popup PTY
        ├── wait for daemon to finish render
        ├── read result buffer back over the socket
        └── paste-buffer to ORIGIN_PANE (existing behaviour, unchanged)

oc-editd accept loop
  ├── recvmsg() → receive popup's stdin/stdout fds + initial-text payload
  ├── dup2() fds onto own 0/1/2
  ├── (maybe ioctl(0, TIOCSCTTY) — see "Controlling-terminal claim")
  ├── render(<App/>)  — opentui sees a fresh TTY
  ├── on submit (Ctrl+Alt+S): write committed buffer over the socket
  ├── close popup fds, dup2 /dev/null back onto 0/1/2
  └── loop back to accept()
```

Single-popup-at-a-time is acceptable (one user, one daemon). No
multiplexing needed in v1.

---

## What was tried and ruled out

Don't repeat these — they're dead ends for this codebase:

1. **`bun --bytecode` / `bytecode: true` in `Bun.build()`** — segfaults
   on our module graph in Bun 1.3.13. Upstream bug. Disabled in
   `scripts/bundle.ts` with a comment. Re-test on every bun bump.

2. **`bun build --compile`** — produces a standalone binary, but the
   JSX runtime issue (#3 below) hits it too, AND the binary is ~50MB
   per copy. Not worth it.

3. **CLI `bun build` for the bundle** — `@opentui/solid`'s
   `jsx-runtime` export points at a `.d.ts` (no JS). The JSX runtime
   only exists at module-load time, registered globally by the
   `@opentui/solid/preload` script. CLI `bun build` doesn't pick up
   the preload's plugin registration. The fix is to use `Bun.build()`
   programmatically with `createSolidTransformPlugin()` from
   `@opentui/solid/bun-plugin` — see `scripts/bundle.ts`.

4. **Lazy-import `bootstrap.ts` in `onMount`** — works (textarea
   visible while runtime loads in background), but only saves
   perceived latency on first paint. Total time to "cues fire" is
   unchanged. Was implemented, then reverted because the user found
   the visible UI flickering through partial states distracting.
   See app.tsx git history before the revert if you want the code.

5. **OS page-cache prewarming** — tested via `oc-edit --warmup`
   background process. Caches the bun binary + module files in
   memory, but the per-popup bun startup still re-parses everything.
   Marginal speedup (~50-100ms) for substantial complexity. Not
   worth it.

6. **`fork()` for module-cache sharing** — Bun's `child_process.fork`
   is spawn-based (new VM), NOT a real Unix fork. There's no way to
   share JavaScriptCore module state between bun processes. The ONLY
   primitive that lets a warm process serve a cold popup is taking
   over the popup's TTY — hence FD passing.

7. **RPC daemon for runtime only (no FD passing)** — was on the
   table as "option B". Saves ~200-400ms by skipping ConfigLoader
   parsing per popup. Achievable but the @opentui/core load is still
   the dominant cost (~300ms by itself), so the payoff is limited.
   If FD passing turns out to be too hard, fall back to this — it's
   a partial win.

---

## What's already in place (DON'T re-do)

- **`scripts/bundle.ts`** — works. Builds `dist/app.js` via
  programmatic `Bun.build()` with the solid bun-plugin. JSX transform
  happens at build time so the bundle has no `jsx-runtime` imports.
  Not currently wired into setup.sh (because the bytecode `.jsc`
  segfault polluted dist/ during testing). Re-enable in setup.sh
  ONCE the daemon work makes the bundle relevant.

- **`bin/oc-edit`** — bash shim that `cd`s into `integrations/shell/`
  (for bunfig.toml discovery), exports `OPENCUES_USER_CWD=$PWD` so
  the runtime knows where the user actually invoked from, then
  `exec bun --preload @opentui/solid/preload src/app.tsx`. Used by
  oc-popup. Keep this for fallback.

- **`bin/oc-popup`** — invoked by the tmux popup. Today: invokes
  `oc-edit` as a subprocess, gets buffer via `--out tmpfile`, then
  `tmux send-keys -l` (typed mode, default) or `paste-buffer`
  (bracketed/raw modes) into the originating pane. Sets/clears
  `@popup-open` user-option and toggles `status off/on`.

  When daemon lands: try connecting to daemon first; fall back to
  spawning `oc-edit` if daemon unreachable. Keep the
  send-keys/paste-buffer logic unchanged — that runs after the
  daemon returns the buffer over the socket.

- **`conf/shell.tmux.conf`** — has the M-C-s / M-C-q / F2 bindings
  and the `@popup-open`-gated status-left. No change needed for
  daemon work (daemon lifecycle is in `bin/oc-shell`, not in tmux
  config).

- **`bin/oc-shell`** — launches the wrapped tmux session. This is
  where you start/kill the daemon: spawn it before `exec tmux ...`,
  trap session exit to kill it.

- **`src/bootstrap.ts`** — the runtime entry. Read `OPENCUES_USER_CWD`
  for cwd, builds the Resolver, etc. The daemon should call THIS
  module's setup code at boot, then re-use the built state across
  popup requests.

---

## Step-by-step build order

Each step gets its own commit. Test in isolation before moving on.

### Step 1 — Standalone FFI: socket open + sendmsg/recvmsg with SCM_RIGHTS

File: `src/scm-rights.ts`

This is the part with the most platform risk. Implement + test in
isolation BEFORE touching the daemon.

Why FFI: Bun's `Bun.listen({ unix })` doesn't expose the underlying
fd, and the socket data callback gives plain `Uint8Array` — no
out-of-band metadata for FDs. So we open the unix socket and do
`sendmsg/recvmsg` directly via `dlopen('libc.so.6')`.

Linux `cmsghdr` layout (glibc x86_64, 64-bit):

```c
struct msghdr {
  void         *msg_name;        // socket address (NULL for connected)
  socklen_t     msg_namelen;     // length thereof
  struct iovec *msg_iov;         // scatter/gather array
  size_t        msg_iovlen;      // # elements in msg_iov
  void         *msg_control;     // ancillary data (cmsg buffer)
  size_t        msg_controllen;  // ancillary data buffer length
  int           msg_flags;       // received-flags-only on output
};

struct cmsghdr {
  size_t cmsg_len;     // includes header + data
  int    cmsg_level;   // SOL_SOCKET
  int    cmsg_type;    // SCM_RIGHTS
  // followed by ALIGN(N * sizeof(int)) bytes of fds
};
```

Constants you'll need (Linux):
- `SOL_SOCKET = 1`
- `SCM_RIGHTS = 0x01`
- `AF_UNIX = 1`
- `SOCK_STREAM = 1`
- `CMSG_ALIGN(len) = (len + sizeof(size_t) - 1) & ~(sizeof(size_t) - 1)`
- `CMSG_SPACE(len) = CMSG_ALIGN(len) + CMSG_ALIGN(sizeof(cmsghdr))`
- `CMSG_LEN(len) = CMSG_ALIGN(sizeof(cmsghdr)) + len`

Bun FFI declaration sketch:

```ts
import { dlopen, FFIType, ptr } from "bun:ffi";

const libc = dlopen("libc.so.6", {
  socket:  { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  bind:    { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  listen:  { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  accept:  { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  connect: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  sendmsg: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i64 },
  recvmsg: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i64 },
  close:   { args: [FFIType.i32], returns: FFIType.i32 },
  dup2:    { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});
```

**Test harness for step 1:** write `scripts/scm-test.ts` that:
- spawns a child process (e.g. `Bun.spawn(['cat'], { stdin: 'pipe' })`)
- sends the child's stdin fd over a unix socket to a listener
- listener reads the fd, writes "hello\n" to it
- child sees "hello\n" on its stdin

If that works, scm-rights.ts is solid.

### Step 2 — Daemon main loop

File: `src/daemon.ts`

```ts
import * as path from "node:path";
import * as os from "node:os";
import { setupSocket, acceptOnce, recvFds, dup2 } from "./scm-rights";
// Import bootstrap eagerly — point is to do it once at startup
import { setupRuntime } from "./bootstrap";  // refactor bootstrap to export setup

const sockPath = process.env.OPENCUES_OCEDITD_SOCK
  ?? path.join(os.tmpdir(), `oc-editd-${process.pid}.sock`);

// Preload everything that's heavy
const runtimeState = await setupRuntime({ cwd: process.cwd() });

const listenerFd = setupSocket(sockPath);

for (;;) {
  const conn = acceptOnce(listenerFd);
  // Receive fds + initial-text JSON
  const { fds, initialText } = recvFds(conn);
  dup2(fds.stdin, 0);
  dup2(fds.stdout, 1);
  dup2(fds.stdout, 2);
  // Maybe: ioctl(0, TIOCSCTTY, 1) — see "Controlling-terminal claim"

  // Render — the existing app code
  const buffer = await renderTUI(runtimeState, initialText);

  // Send buffer back over the connection (use a length-prefixed framing)
  await sendMessage(conn, JSON.stringify({ buffer }));

  // Close the popup fds
  await close(fds.stdin); await close(fds.stdout);
  // Restore our own stdio to /dev/null so the next iteration doesn't write garbage
  await dup2(devNullFd, 0); await dup2(devNullFd, 1); await dup2(devNullFd, 2);
}
```

### Step 3 — Refactor `bootstrap.ts`

Current bootstrap.ts wires runtime into a SPECIFIC TextareaRenderable
+ Renderer. We need to split it:

- `setupRuntime({ cwd })` → returns a "warm" state: ConfigLoader,
  Resolver, blanks registry, source classifications. NO TUI hooks.
- `attachRuntime(state, { renderer, textarea, syntax, onTipChange })` →
  binds the warm state to the current TUI session.

Daemon calls `setupRuntime` at startup. Each render-loop iteration
calls `attachRuntime` with the fresh OpenTUI renderer.

**Watch out**: ConfigLoader has a file-watcher that hot-reloads on
~/.cues/ changes. Single-instance is fine; just keep it alive across
popups. DynDefs / HighlightState / SpanFillState / SelectorSatelliteState
are per-buffer — must reset on each new popup (the `resetSharedBufferState`
helper from boot-common is the right primitive — same one the
`fix(chrome): wipe per-buffer state on undo/redo/paste/IME` commit
added).

### Step 4 — Update `bin/oc-popup`

```bash
if [ -n "${OPENCUES_OCEDITD_SOCK:-}" ] && [ -S "$OPENCUES_OCEDITD_SOCK" ]; then
  exec oc-popup-client "$OPENCUES_OCEDITD_SOCK"  # new binary
else
  # Fallback to direct invocation (existing path)
  "$OC_EDIT" --out "$TMPFILE" || true
  ...
fi
```

`oc-popup-client` is a tiny bun script that:
- Connects to the daemon socket
- Sends its stdin/stdout fds via SCM_RIGHTS (using `scm-rights.ts`)
- Reads the result buffer
- (no need to spawn oc-edit — the daemon does the render)
- Hands off to the existing send-keys/paste-buffer logic with the
  result text

### Step 5 — Update `bin/oc-shell`

```bash
# After tmux session setup but before exec:
SOCK_PATH="${XDG_RUNTIME_DIR:-/tmp}/oc-editd-$$.sock"
export OPENCUES_OCEDITD_SOCK="$SOCK_PATH"
"$HERE/oc-editd" --socket "$SOCK_PATH" &
DAEMON_PID=$!
trap "kill $DAEMON_PID 2>/dev/null; rm -f $SOCK_PATH" EXIT
exec "$OC_TMUX" ...
```

### Step 6 — Lifecycle + crash recovery

- Daemon crash → next popup falls back to direct invocation (no
  user-visible breakage, just slower). Optionally restart the daemon.
- `oc-shell` exit → trap kills daemon, removes socket.
- Stale socket file (e.g. previous `oc-shell` killed -9) → daemon
  startup checks + unlinks the path before binding.

### Step 7 — Bundle the daemon

Update `scripts/bundle.ts` to also build `dist/daemon.js` alongside
`dist/app.js`. Both use `Bun.build()` with the solid plugin.

Update `bin/oc-editd` (the shell shim) to prefer `dist/daemon.js`
when present, fall back to `src/daemon.ts` otherwise. Same shape as
`bin/oc-edit`.

Re-wire setup.sh to run the bundle (currently disabled because of
the .jsc-segfault hangover).

---

## Controlling-terminal claim

Open question: after `dup2`-ing the popup's stdin/stdout onto the
daemon's fd 0/1/2, does opentui's terminal-mode setup work without
also claiming the new TTY as the controlling terminal?

Hypothesis: probably yes, because opentui only reads/writes — it
doesn't use job-control signals (SIGTSTP / SIGTTOU) that need a
controlling tty. Test this before adding `ioctl(0, TIOCSCTTY, 1)`,
which is fiddly (the process needs to be a session leader, or it
needs to NOT have a controlling terminal already — the daemon's
parent tty would be a problem).

Workaround if needed: daemon calls `setsid()` at startup to detach
from `oc-shell`'s session, then can `TIOCSCTTY` freely. Side effect:
daemon survives `oc-shell` crash — would need explicit lifecycle wiring.

---

## Things that will probably bite

- **glibc vs musl `cmsghdr` layout** — same struct shape on Linux
  AFAIK, but worth noting if anyone runs this on Alpine.
- **macOS `sendmsg` / `recvmsg`** — different libc; the FFI bindings
  need a macOS variant. Out of scope for v1 (shell integration is
  Linux/WSL only today), but document the assumption.
- **opentui re-init across iterations** — opentui's renderer may
  cache terminal state (alt-screen, cursor pos, etc.) at module
  load. Restoring between iterations might need explicit
  `renderer.destroy()` + a fresh `useRenderer()`. The current
  finish() already calls renderer.destroy() — re-use that.
- **SolidJS root re-mounting** — calling `render(<App/>)` twice may
  leak signals/effects. Use `render(...).dispose()` or manage roots
  manually.
- **Bun socket accept() in FFI mode** — bun's event loop won't see
  the libc-opened fd as a Bun socket. We'd need to call accept() in
  a blocking loop on a worker thread, OR poll() the fd. Worker thread
  is simpler if Bun supports it cleanly.

---

## Testing plan

- **Step 1 in isolation** — `scripts/scm-test.ts` sends a pipe fd
  over a unix socket, target writes through it. Smallest possible
  test of the FFI plumbing.
- **Step 2 + daemon stub** — daemon prints "rendered\n" instead of
  doing actual opentui render. Verifies the dup2 + write back loop
  without dragging opentui in.
- **Step 3 — bootstrap split** — write a unit test that calls
  setupRuntime + attachRuntime separately, verifies the runtime
  still resolves correctly.
- **End-to-end** — `oc-shell` + Ctrl+Alt+S; measure first-log time.
  Target: <200ms.

---

## Files you'll touch

```
integrations/shell/
├── DAEMON-PLAN.md                  (this doc)
├── bin/
│   ├── `oc-shell`                    (modify: spawn/kill daemon)
│   ├── oc-popup                    (modify: try daemon, fall back)
│   ├── oc-popup-client (NEW)       (talks to daemon via SCM_RIGHTS)
│   └── oc-editd (NEW)              (daemon shim, like bin/oc-edit)
├── conf/shell.tmux.conf         (no change expected)
├── patches/setup.sh                (modify: re-enable bundle, ship daemon)
├── scripts/
│   ├── bundle.ts                   (modify: also build daemon)
│   └── scm-test.ts (NEW)           (isolated test harness)
└── src/
    ├── app.tsx                     (minor: split render entry from main())
    ├── bootstrap.ts                (refactor: setupRuntime + attachRuntime)
    ├── daemon.ts (NEW)             (daemon main + accept loop)
    └── scm-rights.ts (NEW)         (FFI wrapper)
```

Plus `packages/opencues-runtime/src/boot-common.ts` if the bootstrap
refactor needs the shared `resetSharedBufferState` helper exposed
differently. Probably not — it's already exported.

---

## Estimated effort

- Step 1 (FFI + isolated test): 2-3 hours
- Step 2 (daemon main loop): 2 hours
- Step 3 (bootstrap refactor): 1-2 hours, plus running the existing
  tests to make sure nothing broke
- Step 4-5 (popup + shell wiring): 1 hour
- Step 6 (lifecycle + recovery): 1 hour
- Step 7 (bundle): 30 min
- Testing + iteration: 2-3 hours

Total: ~10-12 hours of focused work. Most of the risk is in step 1.
If FFI gets stuck, fall back to "option B" (RPC daemon for runtime
only, ~30-50% of the speedup but no FD-passing).

---

## When you start

1. Re-read this doc end-to-end.
2. Check `git log --oneline` for `DAEMON-PLAN.md` to see if it was
   amended since the original write — those edits will be the
   freshest learning.
3. Start with step 1's isolated test harness. Don't touch any
   user-facing file until SCM_RIGHTS round-trip works.
4. Amend this doc as you discover things. The next handoff will
   thank you.

---

## Measured: Option B saves ~10ms, not 200-400ms

Option B (RPC daemon for raw config files, no FD passing) is built and
running. Files in the tree today:

- `src/daemon.ts` — daemon main loop, unix-socket server, hot-reload
- `src/daemon-client.ts` — popup-side fetch + `SnapshotCache`
- `bin/oc-editd` — bash shim (mirrors `bin/oc-edit`)
- `bin/oc-shell` — spawns/kills daemon, sets `OPENCUES_OCEDITD_SOCK`
- `src/bootstrap.ts` — top-level `await fetchSnapshot()`; wraps the
  adapter's `readFile`/`readDir` to consult the snapshot first

**Measured benchmark (29 files / 79KB of `~/.cues/`, OS cache warm):**

| Path                     | Cold run | Warm run |
|---|---|---|
| Direct `fs.readFile`     | 12 ms    | 19-22 ms |
| Daemon fetch + cache hit | 14 ms    | 9-10 ms  |

The daemon saves **~5-15 ms** per popup launch, not the 200-400 ms the
plan optimistically predicted. The bulk of cold-start time is bun
process startup + `@opentui/core` + `@opentui/runtime` module loading,
all of which the daemon does **not** address (each popup is a separate
bun process; modules re-parse from disk).

The plan's estimate assumed parsing was the dominant cost; in practice
parsing is fast and module-load dominates. Module-load can only be
shared via the FD-passing path (Option A) — the warm daemon serves the
popup directly, no second module load.

### What Option B *does* give us

- **Foundation for Option A**: socket protocol, daemon lifecycle,
  `oc-shell` wiring, snapshot framing. The FD-passing path can reuse all
  of it.
- **Hot-reload coalescing**: daemon's `fs.watch(recursive:true)` + 150ms
  debounce + 250ms min-interval cleanly collapses bursty inotify events
  (sed-style "rename over original" produces 3 events; daemon does one
  refresh). Without this, every popup would race the kernel.
- **A correct fallback path**: `bootstrap.ts` silently falls through to
  direct fs reads when the socket is missing/unreachable, so a daemon
  crash never breaks a popup — just slows it ~10ms.

### Quirks discovered during the build

- **bun forks a launcher + child** for `bun script.ts`. `kill $!`
  signals the launcher and orphans the child. Use `pkill -P $LAUNCHER`
  followed by `kill $LAUNCHER` in trap handlers. Already wired in
  `bin/oc-shell`'s `cleanup_daemon`.
- **fs.watch on Linux fires events in batches after async work
  completes** — the debounce alone wasn't enough; we needed a
  hard `minInterval` since `lastRefreshAt` as well. See `scheduleRefresh`
  in `src/daemon.ts`.
- **Zombie daemons share log files**: during early dev, leftover
  daemons from earlier test runs (orphaned by the bun-launcher bug
  above) all kept writing to `/tmp/oc-editd.log` and watching
  `~/.cues/`. The "10 builds per file mod" mystery was 5 zombies each
  incrementing their own `snapshotVersion` into a shared log.

### Recommendation for next session

If the user reports popup latency as still painful, **don't iterate on
Option B** — it's structurally bounded by what's left to save (~10ms).
Either ship Option A (FD passing, ~600-800 ms saving, ~10 hours) or
declare 600-700 ms warm popups as the steady state and move on.
