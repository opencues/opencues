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

> **Status: pre-alpha.** No live-fixes recorded yet because the
> integration hasn't been run end-to-end. As bugs surface during
> Tier 6 verification (see `CODEX-CHECKLIST.md`), append them
> below using the same shape as `oc/REPAIR.md` — Symptom / Why / Fix /
> File:line, plus folding the fix into `setup.sh`'s STEP 4 (when
> implemented) so re-applying the patches stays mechanical.

## Live-fixes discovered during testing

*(none yet — pre-alpha)*

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

### IL-3. Smoke test exits 0 even when daemon misbehaves

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
