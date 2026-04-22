# Codex adapter — repair guide

Codex integration band. Pin: **openai/codex (`d58d3cc`)** — see
`integrations/codex/patches/setup.sh` `PINNED_SHA`.

The runtime side is host-agnostic; the only band-specific code lives at:

- `packages/opencues-runtime/adapters/codex/v1/daemon.ts` — JSON-RPC
  scaffolding that the bridge crate spawns
- `packages/opencues-runtime/adapters/codex/v1/boot.ts` — thin
  re-export over `daemon.ts`
- `integrations/codex/patches/opencues-bridge/src/lib.rs` — the
  Rust bridge crate that lives inside the codex-rs workspace
- `integrations/codex/patches/setup.sh` — install pipeline
- `integrations/codex/patches/opencues-bridge/src/bin/smoke.rs` —
  bridge ↔ daemon smoke test

> **Status: alpha.** Tiers 1-5 (CODEX-CHECKLIST.md) have all landed
> with end-to-end testing of the bridge ↔ daemon path. Tier 6
> (live TUI verification with cycling + dim ranges visible in codex)
> requires the user to run `opencues run codex` interactively — the
> infrastructure is in place. Live-fixes from the build-out below.

## Live-fixes discovered during testing

### LF-1. Stdin-close race exited daemon mid-boot (Tier 3.A)

**File:** `packages/opencues-runtime/adapters/codex/v1/daemon.ts`
`startDaemon`.

**Symptom:** A single-line stdin pipe (`echo '{boot…}' | node daemon.js`)
closed immediately after the line, triggering `rl.on('close')` and
`process.exit(0)` BEFORE the async boot handler (which awaits
ConfigLoader.load) had resolved. The boot reply never made it out.

**Why:** `void daemon.handleLine(line)` was fire-and-forget. The
'close' event fired before the IIFE resolved. Single-line bridges
(every test, every smoke run) saw zero output from the boot handler.

**Fix:** Track in-flight handleLine promises and await them on
'close' before exiting. Initially a Set-based tracker; later replaced
by a chain promise (also gives FIFO ordering — see LF-3).

### LF-2. Reclassifier instances diverged in test stub (Tier 3.C)

**File:** `packages/opencues-runtime/adapters/codex/v1/daemon.test.ts`
`stubBuildRuntime`.

**Symptom:** Tier 3.F's "text-change reclassifies to runtime when text
matches setText" test failed with `expected ['runtime'] received ['user']`.

**Why:** The test stub created the adapter and the bundle's
reclassifier as TWO different instances. setText('foo') marked write
on the adapter's instance; reclassify('foo') ran on the bundle's
instance — no match. Production wires the same instance into both.

**Fix:** Construct one reclassifier in the stub, pass into both. The
fix is also a contract assertion: anyone implementing buildRuntime
must wire the same reclassifier into the adapter and the bundle.

### LF-3. RPC ordering wasn't FIFO (Tier 3.E)

**File:** `packages/opencues-runtime/adapters/codex/v1/daemon.ts`
`startDaemon`.

**Symptom:** Two-line stdin (boot + control-invoke) returned the
control-invoke response with `-32000 daemon not yet booted` BEFORE
the boot response — even though the bridge sent boot first.

**Why:** readline's 'line' event fired for both lines back-to-back;
each scheduled handleLine async; the fast one (control-invoke
checking runtime=null) finished first.

**Fix:** Serialize the readline handler through a chained promise
queue. Each request waits for the previous one before starting.
Trade-off: a slow control-invoke blocks the queue; that's the
correct behavior for a single-connection JSON-RPC server (matches
how every JSON-RPC implementation orders responses).

### LF-4. ConfigLoader.load was fire-and-forget on boot (Tier 3.F)

**File:** `packages/opencues-runtime/adapters/codex/v1/daemon.ts`
`defaultBuildRuntime`.

**Symptom:** Live test sent boot + text-change + force-render. The
text-change handler fired but BlankFill saw an empty cueMap because
ConfigLoader.load hadn't completed.

**Why:** `buildSharedRuntime` calls `configLoader.load().catch(...)`
fire-and-forget — modules tolerate the empty pre-load window. OC
gets away with it because real users type slowly enough that load
finishes before the first cue-bearing text-change. Codex's test
harness sends them rapidly.

**Fix:** Await `shared.configLoader.load()` after `buildSharedRuntime`
returns. `load()` is idempotent (returns the in-flight promise), so
this just waits on the existing call. Adds ~200-500ms to boot time
depending on config size — fine, the bridge boots once per session.

### LF-5. spawnProcess threw, killing the daemon on shell-script controls (Tier 3.F)

**File:** `packages/opencues-runtime/adapters/codex/v1/adapter.ts`
`CodexAdapter::spawnProcess`.

**Symptom:** Live text "the volume is _" triggered BlankFill ->
controlInvoke('volume') -> null (volume isn't hoisted) -> fallthrough
to spawnProcess -> THROW -> handleLine exception -> "handleLine threw"
log line + the directives notification still arrived but BlankFill
state was inconsistent.

**Why:** BlankFill at `blank-fill.ts:228` doesn't gate on the
`spawn-process` capability before calling `adapter.spawnProcess` (it
has its own `script` presence check, but not the cap check).
CodexAdapter doesn't advertise `spawn-process` (no bridge wiring for
subprocesses), so the spawnProcess call should logically never happen,
but in practice does because of that capability gap.

**Fix:** Make CodexAdapter.spawnProcess return a "command unavailable"
ProcessHandle (exitCode 127 + warn log) instead of throwing. Modules
treat non-zero exit as "skip this slot" and stay alive. Proper
long-term fix: either (a) hoist volume/brightness to TS (a la HN /
Stocks / Weather / Answer / PromptImprover / OpenCuesSettings), or
(b) add a spawn-process JSON-RPC method that tunnels stdio through
the bridge.

### LF-6. Statusline async-write didn't flush before daemon exit (Tier 3.G)

**File:** `packages/opencues-runtime/adapters/codex/v1/daemon.ts`
`startDaemon` close handler.

**Symptom:** Test pipe closed stdin → daemon.handleLine completed →
pending promise resolved → process.exit(0). But Statusline's
`adapter.writeFile(...)` was a fresh microtask scheduled by an
onRender callback inside the handleLine's collect-directives path.
That microtask hadn't resolved by the time exit fired.

**Why:** The inflight promise tracker only awaited handleLine
promises — anything THOSE handlers spawned (writeFile, log
appendFileSync) wasn't tracked.

**Fix:** Add a 100ms `setTimeout` after the inflight promise resolves
before calling process.exit. Pragmatic — fs.writeFile microtasks
resolve well within that window; tracking every transitive promise
would require mutating writeFile's signature.

## Known infrastructure-level fixes

## Known infrastructure-level fixes

These are pre-emptive notes about fragile integration points the user
should expect to re-apply as upstream codex-rs evolves. Not bugs;
just maintenance load.

### IL-1. Codex pinned SHA may drift

**File:** `integrations/codex/patches/setup.sh` `PINNED_SHA="d58d3cc"`.

**Symptom:** `git checkout d58d3cc` fails with "fatal: reference is
not a tree" (upstream pruned the ref) or warning "couldn't checkout
$PINNED_SHA — using HEAD".

**Why:** OpenAI's codex repo evolves fast; SHAs may be force-pushed
or branches reorganized. The pinned SHA is the version everything
was tested against.

**Fix:** Bump `PINNED_SHA` to a current upstream SHA, re-run
`pnpm exec opencues install codex`, verify the bridge still builds
and the smoke test passes. If TUI patches (Tier 5) are wired,
re-test those too — the patch sites in `chat_composer.rs` may have
moved.

### IL-2. `members = [` regex match in Cargo.toml is brittle

**File:** `integrations/codex/patches/setup.sh` `patch_workspace`.

**Symptom:** Setup fails at "Add bridge to Cargo.toml workspace"
with `couldn't find 'members = [' in Cargo.toml — please add manually`.

**Why:** The Python regex `r'(members\s*=\s*\[)'` assumes Cargo
keeps the workspace members list in TOML's standard inline-array
form. If upstream switches to a multi-line list with no `[` on the
declaration line, or moves to a different table layout, the regex
misses.

**Fix:** Edit `Cargo.toml` manually to add `"opencues-bridge",` to
the workspace members list. The setup script is idempotent: re-run
will skip the patch step and continue.

### IL-3. libcap-dev missing for full codex-tui build (Tier 6 prereq)

**File:** environmental — Linux system packages.

**Symptom:** `cargo build -p codex-tui` (or any full build of codex's
TUI binary) panics in `codex-linux-sandbox`'s build.rs:

```
failed to compile vendored bubblewrap for Linux target:
libcap not available via pkg-config
```

**Why:** codex-rs vendors `bubblewrap` for Linux sandboxing. The
build script links against `libcap` via `pkg-config`. Default WSL2 /
Ubuntu installs don't include `libcap-dev`.

**Fix:** Install the system package.

```bash
sudo apt install -y libcap-dev pkg-config
```

(`pkg-config` is usually present but listed for completeness.)

After install, `cargo build -p codex-tui` succeeds. The bridge crate
itself doesn't need libcap — only the full codex-tui binary does
(for the sandbox).

Tier 6 verification (running `opencues run codex` interactively)
needs this. Type-checking the bridge wiring (Tier 5 patches) does
NOT need this — `CODEX_SKIP_VENDORED_BWRAP=1 cargo check -p
codex-tui --lib` works without libcap.

### IL-4. Cargo too old for codex-rs's workspace manifest

**File:** environmental — user's `cargo --version` < 1.85 (Feb 2025).

**Symptom:** `pnpm exec opencues install codex` fails at the
`▸ cargo build -p opencues-bridge` step with:

```
error: failed to load manifest for workspace member
       `<fork>/codex-rs/analytics`
Caused by: feature `edition2024` is required
The package requires the Cargo feature called `edition2024`, but
that feature is not stabilized in this version of Cargo (1.75.0).
```

**Why:** even though we only ask cargo to build the `opencues-bridge`
crate (`-p opencues-bridge`), cargo must parse every workspace
member's `Cargo.toml` first to construct the dependency graph. One
of codex-rs's members (`analytics` at minimum) declares
`edition = "2024"`, which was stabilized in Rust 1.85 (Feb 2025).
Older toolchains can't load the workspace at all.

**Fix:** update the user's Rust toolchain.

```bash
rustup update stable
# or fresh-install if no rustup:
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
```

Verify with `cargo --version` ≥ 1.85, then re-run
`pnpm exec opencues install codex`. The setup.sh is idempotent —
the partial state (cloned fork, copied bridge crate, patched
Cargo.toml) doesn't need cleanup before retry.

`bin/install.cjs` includes a pre-flight cargo version check that
fails fast with this message if cargo is too old.

### IL-5. Smoke test exits 0 even when daemon misbehaves

**File:** `integrations/codex/patches/opencues-bridge/src/bin/smoke.rs`.

**Symptom:** `cargo run --bin opencues-bridge-smoke` reports
"daemon should exit cleanly" but doesn't actually verify the boot
RPC succeeded — only that the bridge spawned the daemon process
and could write to stdin.

**Why:** Smoke is intentionally minimal; it tests the framework, not
the runtime semantics. The daemon's `boot` response is a fire-and-
forget `send_request` (lib.rs:96-101) — bridge doesn't await the
response before exiting.

**Fix:** None required for the smoke test (it's load-bearing only
for "did the install pipeline produce something runnable"). For
real integration verification, see `CODEX-CHECKLIST.md` Tier 6 —
real verification happens once the TUI patches land and a live
session can be tested.

## Bridge gaps tracker

Two known TODOs in `lib.rs` that block Tier 6 verification:

- **Line ~119**: `dispatch_key` always returns `false` (no req/resp
  correlation). See `CODEX-CHECKLIST.md` Tier 4.A.
- **Line ~195**: `set-text` notification handler is a stub (no
  callback registration). See `CODEX-CHECKLIST.md` Tier 4.B.

These are not "bugs to fix" yet — they're known scaffolding limits
documented in HANDOFF.md.
