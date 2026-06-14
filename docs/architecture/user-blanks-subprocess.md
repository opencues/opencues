# User-pack JS subprocess loader (Bun-host fallback)

User-pack JS blanks (`impl: ./blank.js` in BLANK.md) run in an `isolated-vm`
V8 isolate on every host that can load the native binding. On Bun-based
hosts (opencode, shell), the binding can't load — Bun ships JavaScriptCore,
not V8, so `require('isolated-vm')` fails at module-import time with
`undefined symbol: _ZN2v8...`.

This document describes the subprocess fallback that closes that gap.

## The two loaders

| Loader | File | When it runs |
|---|---|---|
| **In-process** | `packages/opencues-runtime/src/user-blanks/node-loader.ts` | Every host where `require('isolated-vm')` succeeds (CC, Gemini-CLI, chrome-host). The user-pack JS runs in a V8 isolate in the same Node process. |
| **Subprocess** | `packages/opencues-runtime/src/user-blanks/subprocess-loader.ts` + `subprocess-runner.cjs` | Bun hosts (opencode, shell). The runtime spawns a long-lived Node helper at `~/.opencues/vendor/user-blank-runner.cjs` that owns the isolates and IPCs over JSON. |

`registry.ts` picks between them: tries the in-process loader first, falls
back to the subprocess loader if the error message contains
`"isolated-vm unavailable"` AND the runner script is present.

## Architecture

```
opencode (Bun)                       ┌── Node subprocess ───────────┐
│                                    │                              │
├── @opencues/runtime                │  isolated-vm V8 sandboxes    │
│   └── registry.ts:loadUserBlank    │  one per loaded user blank   │
│       ├── try loadUserBlank ──┐    │                              │
│       │   (in-process — fails │    │  reads JSON ops from stdin   │
│       │    on Bun)            │    │  writes JSON results +       │
│       └── fall back to subproc│    │   cap-* requests to stdout   │
│                               │    │                              │
└── SubprocessIsolateRunner ────┼───►│ ←── ~/.opencues/vendor/      │
    (subprocess-loader.ts)      │    │       user-blank-runner.cjs  │
                                │    └──────────────────────────────┘
                                │
                                └── ~/.opencues/vendor/
                                      node_modules/isolated-vm/
```

## Security boundary

The same as the in-process loader. The user blank still runs in a real
isolated-vm sandbox — just in a different process. The only references
the user code holds back to the host realm are the `ctx.fetch` /
`ctx.llm` / `ctx.storage` shims, and each of those serializes through
JSON before crossing the subprocess boundary.

Capability gating + secret-binding enforcement (INFOSEC F4 deny-by-default
destination allow-list) run on the **main side** of the IPC, identical to
the in-process path — the `buildCapabilityHandler` in
`subprocess-loader.ts` reuses `enforceSecretBindings` from
`secret-leak-guard.ts`. The subprocess never sees raw secret values
being smuggled to attacker hosts; the check runs before main forwards
the fetch.

Threat model row #2 in `security-audit.md` (vm-sandbox escape — INFOSEC
F1) is unchanged: an isolated-vm escape still requires a CVE in the
native binding, regardless of whether the binding runs in-process or in
the spawned helper.

## Lifecycle

- **Lazy spawn.** No subprocess is created until the first user-pack JS
  dispatch. Sessions that never hit a JS blank pay zero overhead.
- **One subprocess per session**, multiplexed across every JS blank.
- **Idle reap** at 5 min of inactivity; respawn on next dispatch
  (~50ms cold start).
- **Crash recovery.** If the subprocess dies (OOM, kill, segfault),
  every in-flight promise rejects with a clear error; the next invoke
  spawns a fresh subprocess and proceeds.

## IPC protocol

Newline-delimited JSON over stdin/stdout. See `subprocess-loader.ts` for
the typed shapes. Summary:

| Direction | Ops |
|---|---|
| main → runner | `load`, `get`, `set`, `shutdown`, `cap-result` |
| runner → main | `ready`, `load-result`, `get-result`, `set-result`, `log`, `cap-fetch`, `cap-storage-get`, `cap-storage-set`, `cap-llm` |

Capability calls round-trip via `cap-*` requests with a per-call
`callbackId`. Main correlates the cap call to its originating
`get`/`set` invocation via the embedded `id` field (used for
per-blank quota tracking on the main side).

## Install path

The runner script + a fresh `node_modules/isolated-vm/` are installed
into `~/.opencues/vendor/` by:

- `integrations/opencode/patches/setup.sh:install_user_blank_runner`
- `integrations/shell/patches/setup.sh` (inline section)

Both copy the same source files from the source workspace's
already-installed `isolated-vm` (much faster than re-running
`npm install`, and guarantees byte-for-byte the same binding the
in-process loader uses on Node hosts).

CC + Gemini-CLI don't need this — their in-process loader works.

## Cost model

| Operation | Time |
|---|---|
| Cold spawn (first user-pack JS dispatch of a session) | ~50–100ms |
| Warm invoke (cached subprocess, capability round-trip) | ~5–10ms |
| Per-isolate creation inside the runner | ~5–10ms |
| Per-invocation (sub-ms warm, in-isolate) | sub-ms |

Compared to the prior `vm.runInContext` loader at ~0.1ms per invocation:
the 10–30× slowdown is acceptable for a `_`-keystroke-frequency call.
Per-blank result caching (TTL via the blank's own `set` / state) absorbs
most repeat work.

## Won't-do (deliberate scope cuts)

- **Worker-threads sandbox** as a parallel option. Sticking with
  subprocess for the cleaner security story (Bun's worker threads share
  JS engine state in a way subprocess doesn't).
- **Hot-reload of user-pack JS in the live subprocess.** Same restart
  story as the in-process loader.
- **Multi-process pool** for concurrent user-pack JS invocations. One
  subprocess multiplexed is enough — user-pack invocations are
  LLM-call-rate, not per-frame.
- **gRPC / native IPC.** JSON over stdin/stdout is fine for this
  volume; don't over-engineer.

## When to extend

The capability handler builder in `subprocess-loader.ts` mirrors
`buildContextFromCaps` in `registry.ts`. When you add a new capability
to the in-process loader, also add:

1. The handler field (`storageList`, etc.) to `CapabilityHandler`.
2. The cap-`*` op shape to `RunnerOut`.
3. The `awaitCap` call in `subprocess-runner.cjs`'s `invokeUserMethod`.
4. The case in `handleCapRequest` in `subprocess-loader.ts`.
5. The `capsAvailable` flag if the capability is opt-in.

Both loaders must agree on the surface; the in-process tests in
`node-loader.test.ts` and the subprocess tests in
`subprocess-loader.test.ts` should each pin the new shape.
