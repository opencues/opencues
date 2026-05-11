# Scripted-blank Sandbox

OS-level isolation for the scripts that fire when a blank's `_`
auto-populates. Wraps `bash <script>` with the platform-appropriate
sandbox mechanism so a malicious `~/.cues/blanks/foo/script.sh` can't
reach beyond the blank's own folder, can't open network sockets, and
can't see other processes on the system.

Per-platform mechanism:

| Platform | Mechanism | Notes |
|---|---|---|
| Linux / WSL2 | **bubblewrap (bwrap)** | unprivileged user namespaces; needs `apt install bubblewrap` (or distro equivalent) |
| macOS | **sandbox-exec** (Apple seatbelt) | ships in the base OS; no install required |
| Windows native | (none yet) | falls through unwrapped; emits one-time warn per blank |

The runtime picks the right mechanism via `wrapForPlatform()` in
`packages/opencues-runtime/src/security/sandbox-runner.ts`. Hosts
that spawn subprocesses call that dispatcher, never the per-platform
wrappers directly.

## Scope — what the sandbox DOES and DOESN'T affect

The sandbox wraps **`blankScript:` invocations only** — shell scripts
the runtime spawns via `child_process.spawn`. Other blank profiles
are untouched:

| Blank profile | Sandboxed? | Why |
|---|---|---|
| **`blankScript:`** (volume, brightness, custom .sh) | ✓ Yes | Spawns a subprocess; that's what the sandbox wraps |
| **`impl:`** (HackerNews, Stocks, Weather, Crypto, Dictionary, Countries, Answer, PromptImprover) | ✗ No | Runs as a TS class in the runtime process; no subprocess to wrap |
| **`stepValues:`** (affirmations, static lists) | ✗ No | No code execution at all |

**This is why network-default-deny doesn't break HackerNews.** HN is
an `impl:` class that calls `fetch('https://hnrss.org/...')` directly
from the runtime, which has network access independent of any
sandbox. Same for Stocks (finnhub.io), Weather (open-meteo.com),
Dictionary, etc. — they all live in `packages/opencues-runtime/src/
blanks/` as TS classes and use the runtime's HTTP adapter.

The sandbox config (`sandbox: strict`, `sandbox-net: ...`) lives on
the BLANK.md frontmatter, so the runtime only ever interprets it for
spawn-based blanks. If you add it to an `impl:`-only blank it's a
no-op (no warning today; could be flagged by `opencues validate`).

**Status**: shipped May 2026, **opt-in** per blank via frontmatter.
Existing blanks (volume, brightness, etc.) keep running unsandboxed
because they have legitimate filesystem / system-call needs (volume
talks to `VolCtl.exe` under `/mnt/c/`, brightness similar). New
blanks or anything authored without those requirements should
declare `sandbox: strict`.

## Frontmatter

```yaml
---
name: clipboard
type: blank
blankKeywords: clipboard
blankScript: ./clip.sh
sandbox: strict          # opt-in. Default is 'off' (unsandboxed).
sandbox-net: deny        # 'allow' | 'deny'. Default: 'deny'.
sandbox-fs: ro           # 'ro' | 'rw'. Default: 'ro'.
---
```

When `sandbox: strict`, the runtime sets a `sandbox: SandboxConfig`
field on the `ProcessSpec` it hands to the host's `spawnProcess`.
Each host's spawn wrapper imports `wrapForPlatform` from
`@opencues/runtime/dist/src/security/sandbox-runner.js` and wraps the
spec before calling `child_process.spawn`. The dispatcher picks
bwrap on Linux, sandbox-exec on macOS, or returns `null` on any
other platform. When the wrapper returns null the spec runs
unwrapped — the **path sandbox + audit log still apply**, just not
OS-level confinement. `BlankFill` emits a one-time-per-blank warn
when strict is requested on a platform without a wrapper (currently
Windows native + Linux without bwrap installed).

## What the sandbox does — Linux (bwrap)

When `sandbox: strict` resolves through bwrap, the script sees:

| Aspect | Default | Override |
|---|---|---|
| **System dirs** (`/usr`, `/bin`, `/lib`, `/etc`, `/sbin`) | Read-only bind | — |
| **The blank's own folder** | Read-only bind | `sandbox-fs: rw` |
| **All CUES roots** (`$OPENCUES_HOME`, `<cwd>/.cues`, `~/.cues`) | Read-only bind | — |
| **`/tmp`** | Fresh tmpfs (dies with script) | — |
| **`/dev`** | Minimal (`/dev/null`, `/dev/zero`, `/dev/random`, `/dev/tty`) | — |
| **`/proc`** | New procfs inside the sandbox | — |
| **HOME, `/mnt/*`, anything else** | Not mounted (invisible) | — |
| **Network** | `--unshare-net` (no sockets, no DNS) | `sandbox-net: allow` |
| **PID namespace** | `--unshare-pid` (script sees ~5 processes) | — |
| **IPC namespace** | `--unshare-ipc` | — |
| **UTS namespace** | `--unshare-uts` (own hostname) | — |
| **User namespace** | `--unshare-user-try` (best-effort) | — |
| **Parent-die** | `--die-with-parent` (no orphans) | — |

The sandbox is **shape-shaped, not behaviour-shaped**: a script
running inside it has the user's permissions over the mounted
filesystem. It just can't see / modify anything that wasn't
explicitly bound.

## What the sandbox does — macOS (sandbox-exec)

When `sandbox: strict` resolves through `sandbox-exec`, the script
runs under a deny-by-default TinyScheme policy. Re-allowed:

| Aspect | Policy | Override |
|---|---|---|
| Process exec | `(allow process-fork) (allow process-exec)` | always-on (script itself needs it) |
| File reads | `(allow file-read*)` over the whole FS | always-on (path sandbox already gated before this layer) |
| File writes to workdir | `(allow file-write* (subpath "<workdir>"))` | `sandbox-fs: rw` |
| File writes to `/tmp`, `/private/tmp`, `/private/var/folders` | always allowed | — |
| Network | `(deny network*)` by default | `sandbox-net: allow` |
| sysctl / mach-lookup / signals to self | allowed (linker + locale need these) | — |

macOS-specific gaps (vs Linux):

- **No PID/IPC namespacing.** The script can `ps` and see other
  processes on the host; it can't signal them across uid boundaries
  (kernel-enforced) but the visibility is wider than the Linux
  story.
- **No tmpfs equivalent for `/tmp`.** Files the script writes to
  `/tmp` persist across the sandbox boundary (just like on the
  host). The path sandbox + audit log catch escape attempts that
  re-use those files, but don't prevent the write itself.
- **Mechanism deprecated by Apple.** `sandbox-exec` still ships and
  works on macOS 14/15 but Apple's man page warns it'll be replaced
  by System Integrity Protection eventually. If/when it disappears
  we'll need a replacement (likely the App Sandbox API via a
  signed helper binary).

## What it does NOT do

- **Block syscalls.** No seccomp filter. A script can call any
  syscall available to the user — it just operates on a confined
  filesystem view. If you need syscall-level confinement (e.g. block
  `ptrace`, `chroot`, `mount`), add a seccomp profile via
  `--seccomp <fd>` in a future revision.
- **Sandbox cycling (`set` calls).** Today only the blank-fill
  `get` path applies the sandbox. Cycling Up/Down on a sandboxed
  blank fires `set <value>` UNSANDBOXED. Closing this gap requires
  plumbing the blank config through cycling.ts's `invokeOrSpawn`
  helper — tracked as follow-up.
- **Hide /etc/passwd or similar world-readable files.** They're
  inside `/etc`, which is mounted read-only. The script can read
  them. The kernel's standard file permissions still apply (so
  `/etc/shadow` remains unreadable to the non-root user).
- **Constrain memory or CPU.** Use `ulimit` / cgroups separately if
  you need that.

## Wire-up

```
BLANK.md frontmatter
   ↓ parsed by @opencues/core/src/cues-md.ts
BlankConfig { sandbox, sandboxNet, sandboxFs, ... }
   ↓ consumed by @opencues/runtime/src/modules/blank-fill.ts
ProcessSpec { command: 'bash', args: [scriptPath, 'get', ...],
              sandbox: { mode: 'strict', net, fs, workdir } }
   ↓ spawnProcess (host-specific)
each host's spawn wrapper:
   ↓ calls wrapWithBwrap(command, args, spec.sandbox, cuesRoots)
   ↓ if returned: child_process.spawn(bwrap, [...flags..., '--', bash, scriptPath, ...])
   ↓ if null (sandbox off OR bwrap unavailable): child_process.spawn(bash, [scriptPath, ...])
appendAuditLog after exit
```

The runtime is host-agnostic — it never imports `node:fs` or detects
bwrap. Each host's spawn implementation does the wrap. This keeps
the chrome runtime (no Node primitives) clean while still letting
the chrome host (native-messaging process) apply the same sandbox.

## Cross-host status

| Host | Sandbox wired | Notes |
|---|---|---|
| **claude-code** | ✓ | CC patch (string-template) `require()`s `sandbox-runner.js` at spawn time |
| **opencode** | ✓ | TS patch imports `wrapWithBwrap` directly |
| **gemini-cli** | ✓ | Same shape as OC |
| **chrome** | ✓ | Chrome host (host.cjs) requires `sandbox-runner.js` from the bundled runtime under `node_modules/@opencues/runtime/` |
| **macOS** | ✓ (sandbox-exec) | `wrapForPlatform` dispatches to `wrapWithSandboxExec`; built into base OS |
| **Windows native** | falls back to unwrapped | Future: AppContainer / Job Objects |

## Verified behaviour

Manually proven via a `sandbox-test` blank that ran `touch
$CUE_ROOT/leak.txt`, `curl http://example.com`, and `ls /proc | wc
-l` from inside the sandbox:

| Test | Unsandboxed | Sandboxed |
|---|---|---|
| `touch` outside `/tmp` | LEAKED | blocked (read-only FS) |
| `touch /tmp/foo` | ok | ok (tmpfs) |
| `curl example.com` | (depends on network) | blocked (`--unshare-net`) |
| `ls /proc \| wc -l` (other processes visible?) | ~60 | 5 (just the sandbox) |

End-to-end smoke-tested through the chrome native-messaging host as
well: same results.

Unit tests pin both wrappers' arg/policy construction:
`packages/opencues-runtime/src/security/sandbox-runner.test.ts` (21
tests for bwrap) + `sandbox-exec.test.ts` (14 tests for
sandbox-exec + dispatcher). Linux integration tests at
`sandbox-runner.integration.test.ts` actually exec bwrap with real
scripts (9 tests).

## Authoring a sandboxed blank

For new blanks that DON'T need filesystem writes or network:

```yaml
---
name: prime-factors
type: blank
blankKeywords: factors
blankScript: ./factor.sh
sandbox: strict
---
```

Script can `echo`, `bc`, `awk`, etc. — anything that doesn't write
to disk or open sockets. The user's draft is passed as args, the
result comes back via stdout.

For blanks that need to read/write their own state:

```yaml
sandbox: strict
sandbox-fs: rw   # the blank's folder is writable; CUES_ROOT stays ro
```

For blanks that need network access (HTTP API calls):

```yaml
sandbox: strict
sandbox-net: allow
```

(Most HTTP-backed blanks are better implemented as `impl:` classes
that use the runtime's HTTP adapter — no spawn at all, host-portable
to Chrome.)

For blanks that need full system access (volume, brightness, system
commands): **don't** declare `sandbox`. Leave the default `off`. The
path sandbox + audit log still apply.

## Migration plan (future)

1. Audit existing `defaults/blanks/*` for sandbox-compatibility.
2. Add `sandbox: strict` (or `sandbox: off` with rationale) to each.
3. Flip the default once every shipped blank has an explicit value.
4. Add `opencues validate` warning for `sandbox: off` blanks that
   only do trivial things (a heuristic — could miss complex cases).

## Why bwrap, not Docker / Podman / firejail / nsjail

- **No daemon, no root, no installation prerequisite beyond the
  bwrap binary itself.** WSL2 ships a kernel that supports
  unprivileged user namespaces; bwrap leverages that. Docker would
  require docker-engine running.
- **Per-script invocation overhead is ~5ms.** Negligible alongside
  the 80ms a typical blank script takes.
- **Composable.** Each invocation is a fresh sandbox; no shared
  state between blanks. Reset on each spawn.
- **Used in production by Flatpak.** Battle-tested for exactly this
  use case (untrusted code, minimal capability).

firejail is a heavier wrapper with policy files; we want
minimal-config inline flags. nsjail is similar to bwrap but less
widely packaged. Docker/Podman are overkill for per-script execution.
