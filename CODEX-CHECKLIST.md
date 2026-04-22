# Codex integration — review checklist

> **Purpose:** Walk this top-to-bottom to bring `integrations/codex/`
> from pre-alpha scaffolding to OpenCode parity. Items are ordered
> easy → hard. Each item has a severity (`BLOCKER` / `HIGH` /
> `MEDIUM` / `LOW`) and cites file paths so you can dive in.
>
> **Reference state:** OpenCode (`integrations/opencode/`) is the
> production-grade reference. Source: `/tmp/codex-vs-oc-comparison.md`
> (full agent report; 796 lines; everything below is distilled from
> there).
>
> **What's been done overnight (commits):**
> - Trivial cleanups (Tier 1 below) — done by Claude
> - `--verbose` flag parity with OC (Tier 2.A) — done by Claude
> - Basic daemon tests (Tier 2.D) — done by Claude
>
> **What needs YOU:** Tier 3 onward — daemon module wiring, Rust
> bridge fixes, TUI patches, verification. The mechanical scaffolding
> is in place; the remaining work needs design + Rust.

---

## Pre-reading

Before starting any tier:

- [ ] Read `integrations/codex/HANDOFF.md` — author's notes on what
      remains and why they stopped
- [ ] Read `integrations/codex/docs/architecture.md` — the bridge
      design (5 min)
- [ ] Read `integrations/codex/docs/protocol.md` — the JSON-RPC wire
      format (5 min)
- [ ] Skim `integrations/opencode/patches/opencuesBootstrap.ts` —
      the canonical reference for what daemon.ts should eventually look like

---

## Tier 1 — Trivial cleanups (~5 min each)

These are safe one-liners. Done overnight.

- [x] **Drop dead `tipsPath` field** — protocol.md, lib.rs `BridgeConfig`,
      lib.rs boot RPC payload. Tips moved into `cues.md ## Tips` block
      (commit `b6b1951`); no host consumes a separate tips file path
      anymore. Same dead-field cleanup that OC got yesterday.
- [x] **Add `--target` example to codex README install section** —
      currently only `pnpm exec opencues install codex` is shown
      without the `--target /custom/path` form

---

## Tier 2 — Infrastructure polish (~30-60 min each)

OC-parity ergonomic improvements that don't require runtime work.

- [x] **A. `--verbose` flag in setup.sh + install.cjs** —
      parity with `OPENCUES_INSTALL_VERBOSE=1` and `--verbose` in OC's
      install.cjs. Default behavior should pipe to a log file
      (`/tmp/opencues-install-codex.log`); `--verbose` streams to
      stdout. **Severity: MEDIUM** (codex's setup is opaque on failure
      because everything goes through `tail -15`)
- [ ] **B. Error wrapping in setup.sh** — wrap each step in a `run_step`
      function (mirror OC's pattern) so failures point at which step
      broke. Currently the `set -euo pipefail` will exit but doesn't
      tell you whether step 1 (clone), step 4 (cargo build), or step 5
      (smoke test) failed. **Severity: MEDIUM**. *Files:*
      `integrations/codex/patches/setup.sh:1-139`
- [ ] **C. Build steps stream to log** — mirror OC's
      `/tmp/opencues-install-oc.log` pattern. Currently codex's setup
      truncates `cargo build` output to `tail -15` (line 91), losing
      the first error if the build fails. **Severity: HIGH** (debugging
      cargo failures is currently impossible). *Files:*
      `integrations/codex/patches/setup.sh:89-94`
- [x] **D. Daemon JSON-RPC unit tests** — basic tests for the wire
      protocol: invalid JSON, missing jsonrpc field, unknown method,
      `boot` request returns `{ok:true}`, `key` returns
      `{consumed:false}` while runtime modules are TODO.
      **Severity: HIGH** (currently 0 tests vs OC's 13).
      *Files:* new `packages/opencues-runtime/adapters/codex/v1/daemon.test.ts`
- [ ] **E. Adapter band `boot.test.ts` + `holder.test.ts` parity** —
      mirror OC's adapter band tests. Even if daemon is a thin
      JSON-RPC stub, the band's surface should be tested. Holder
      pattern doesn't apply to codex (no holder), but boot.test.ts
      should test that startDaemon's exports match the daemon.ts shape.
      **Severity: MEDIUM**. *Files:* new
      `packages/opencues-runtime/adapters/codex/v1/boot.test.ts`

---

## Tier 3 — Daemon module wiring (~3-6 hours)

This is the big work to make the daemon non-stub. Each step
should mirror what `integrations/opencode/patches/opencuesBootstrap.ts`
does for OpenCode. Use OC as the structural template.

- [ ] **A. Wire ConfigLoader** — `daemon.ts:86` is currently
      `// TODO: actually wire ConfigLoader + modules`. Should:
      - Construct ConfigLoader with the `configSearchPaths` from boot RPC params
      - Wait for `configLoader.load()` before resolving `boot` response
      - Subscribe to file-change events (the OC pattern uses `fs.watch`)
      - **Severity: HIGH** (BLOCKER for everything below — no cues
        without configs).
      - *Reference:* `integrations/opencode/patches/opencuesBootstrap.ts:204-206`
- [ ] **B. Construct adapter wrapping the daemon** — daemon needs a
      `HostAdapter` instance to pass to runtime modules. Unlike OC
      (which has an in-process adapter via bindings), codex's adapter
      will be a synthetic shim: `getText` returns the latest text
      received via `text-change` RPC; `setText` sends the `set-text`
      notification back to the bridge. **Severity: BLOCKER**.
      *Reference:* `packages/opencues-runtime/adapters/oc/v1.4/adapter.ts:1-183`
- [ ] **C. Source reclassifier** — `createSourceReclassifier` from
      `boot-common`. Used in OC's setText/pushText to mark runtime
      writes so the next text-change pulse correctly identifies them
      as `source: 'runtime'` not `'user'`. Without this, cycling
      causes feedback loops (every cycle clears the highlight).
      **Severity: HIGH**. *Reference:*
      `integrations/opencode/patches/opencuesBootstrap.ts:74-76, 154, 158-162, 319`
- [ ] **D. Build controls registry** — mirror OC's exact registry:
      ```typescript
      const controlsRegistry = new Map<string, Control>([
        ['hackernews', new HackerNewsControl()],
        ['stocks', new StocksControl({ apiKey: process.env.FINNHUB_API_KEY })],
        ['weather', new WeatherControl()],
        ['answer', new AnswerControl({ apiKey: process.env.GROQ_API_KEY })],
        ['prompt', new PromptImproverControl({ apiKey: process.env.GROQ_API_KEY })],
        ['opencues', new OpenCuesSettingsControl({...})],
      ])
      const controlInvoke = createControlInvoke(controlsRegistry)
      ```
      **Severity: HIGH**. *Reference:*
      `integrations/opencode/patches/opencuesBootstrap.ts:116-127`
- [ ] **E. Add `control-invoke` RPC method to protocol + daemon** —
      bridge sends control invocations via JSON-RPC; daemon dispatches
      via `controlInvoke`. Update `docs/protocol.md` with the new
      method. **Severity: HIGH** (depends on D).
- [ ] **F. Wire Navigation / Cycling / BlankFill / DimRender / Resolver
      / Statusline / TTS modules** — same shared-runtime pattern OC
      uses. Each module subscribes to events from the synthetic
      adapter (B). **Severity: BLOCKER** for actual cue functionality.
      *Reference:* `packages/opencues-runtime/adapters/oc/v1.4/boot.ts:153-251`
- [ ] **G. Statusline file export** — `/tmp/opencues-codex-${pid}.status.json`
      (file, not socket — README says socket but file is consistent
      with OC's `/tmp/opencues-opencode-status-${pid}.json`).
      **Severity: MEDIUM**. *Reference:*
      `packages/opencues-runtime/adapters/oc/v1.4/boot.ts:169-177`
- [ ] **H. Cursor state export** — similarly, write
      `/tmp/opencues-codex-cursor-state-${pid}.json` if codex needs
      external cursor reads. **Severity: LOW** (codex may not need it
      — codex isn't using a status line script the way CC is).
- [ ] **I. Wire `force-render` to actually emit `directives`** —
      currently `daemon.ts:104` is a TODO. Should call
      `collectRenderDirectives` from the runtime + emit the
      `directives` notification. **Severity: HIGH** (without this,
      the bridge sees no highlights).

---

## Tier 4 — Rust bridge fixes (~2-4 hours)

The bridge crate has known holes. These are Rust changes that need
careful design — concurrency, ownership, async. Not as straightforward
as the daemon work above.

- [ ] **A. Implement `dispatch_key` request/response correlation by
      ID** — `lib.rs:119-123` currently always returns `false`.
      Without this, codex can never consume Ctrl+Alt+Up/Down for
      cycling. **Severity: BLOCKER**. The TODO comment says
      "synchronous wait for response is noisy without tokio" — options:
      (a) add tokio + go async, (b) use a `oneshot` channel keyed by
      request id with a short timeout, (c) make `dispatch_key`
      fire-and-forget and have the bridge buffer key events while it
      waits for the daemon's verdict. (b) is the cleanest.
- [ ] **B. Implement `set-text` callback** — `lib.rs:195-197`
      currently has a TODO. Bridge needs a registration mechanism so
      `chat_composer.rs` can give it a closure to apply set-text
      results to the TextArea. **Severity: BLOCKER**. Pattern:
      `Bridge::on_set_text(callback: Box<dyn Fn(&str, usize)>)`
      called once during construction; frame handler invokes it on
      `set-text` notifications.
- [ ] **C. Daemon restart on crash** — `lib.rs` doesn't restart the
      daemon if it dies. Watchdog thread that checks
      `child.try_wait()` periodically and respawns. **Severity: HIGH**
      (without this, a daemon crash freezes the TUI's highlighting
      forever — only TUI restart recovers).
- [ ] **D. Daemon health check / heartbeat** — bridge sends a periodic
      `ping` notification; daemon doesn't reply (it's a notification);
      bridge times out the daemon if no `directives`/`log` activity
      for N seconds. **Severity: MEDIUM**.
- [ ] **E. Request timeout in `send_request`** — `lib.rs:132-141`
      has no timeout. If the daemon hangs (e.g., ConfigLoader stuck on
      slow disk I/O), the calling thread hangs too. Add a 500ms
      timeout. **Severity: LOW** (unlikely but possible).
- [ ] **F. Better error reporting** — `lib.rs:71` uses
      `Stdio::inherit()` for daemon stderr. If the daemon crashes,
      the user sees the panic on stderr but the TUI just stops
      receiving directives — silent failure for the highlight system.
      Capture stderr + surface "daemon dead" via a TUI banner.
      **Severity: MEDIUM**.
- [ ] **G. Directives double-buffer** — currently `Arc<Mutex<Directives>>`
      can race with the render loop. Probably fine in practice (single
      writer + frame-rate reads), but a double-buffer (or
      `arc-swap` crate) would eliminate the lock contention.
      **Severity: LOW**.

---

## Tier 5 — TUI patches in chat_composer.rs (~4-8 hours)

This is the headline gap from HANDOFF.md. Until these land, none of
the daemon work above is observable in the TUI.

- [ ] **A. Read `<fork>/codex-rs/tui/src/bottom_pane/chat_composer.rs`
      end-to-end** — needed to find safe patch points. Estimate
      ~1000 LOC.
- [ ] **B. Read `<fork>/codex-rs/tui/src/bottom_pane/textarea.rs`** —
      this is what we're hooking the render path into. Find whether
      it has a `set_styled_ranges()` API or whether we need to add one
      (vs. a parallel highlight overlay).
- [ ] **C. Decide rendering strategy** — three options:
      1. Modify glyph styling per-cell during the existing render path
      2. Maintain a parallel highlight overlay
      3. Extend `TextArea` with `set_styled_ranges(ranges, style)` —
         the cleanest; uses ratatui's `Span` styling
      Option 3 is preferred unless TextArea's structure makes it hard.
- [ ] **D. Wire the bridge crate dep** — add to
      `<fork>/codex-rs/tui/Cargo.toml`:
      `opencues-bridge = { path = "../opencues-bridge" }`
- [ ] **E. Add `bridge` field to `ChatComposer`** — `Option<Bridge>`
      so a daemon failure degrades to vanilla codex behavior instead
      of preventing TUI startup.
- [ ] **F. In `ChatComposer::new()` — start the bridge** —
      `Bridge::start(BridgeConfig {...})`; warn (not panic) on failure.
- [ ] **G. In key-handling path — call `bridge.dispatch_key` BEFORE
      normal handling** — if it returns true, swallow the event.
      Depends on Tier 4.A landing.
- [ ] **H. In text-mutation path — call `bridge.notify_text_change`
      AFTER mutation** — fires after every `insert_str`,
      `delete_char`, etc.
- [ ] **I. In render path — query `bridge.directives()` and apply** —
      uses the rendering strategy decided in C.
- [ ] **J. Add `bridge.on_set_text(...)` callback** — apply
      runtime-driven text writes to the TextArea. Depends on Tier 4.B.
- [ ] **K. STEP 4 in setup.sh: Python sed-injects** — once the patch
      points are stable, mechanize the application via setup.sh's
      TODO marker (line 126). Mirrors OC's pattern.

---

## Tier 6 — End-to-end verification

After Tiers 3-5 land, verify in this order:

- [ ] **A. `pnpm exec opencues install codex`** — full install
      pipeline runs without error
- [ ] **B. `pnpm exec opencues run codex`** — TUI launches with the
      bridge wired
- [ ] **C. `tail -f /tmp/opencues.log`** — daemon's startup log line
      appears
- [ ] **D. Type a sentence with cuable words** — e.g. "the quick fox" —
      dimming should appear within ~2.5s after the LLM responds
- [ ] **E. Cycle a word** — Ctrl+Alt+Right to navigate, Ctrl+Alt+Up
      to cycle. Text should mutate in place.
- [ ] **F. Type `voice-mode _`** — should auto-populate with a value
      from the OpenCuesSettings control. Cycling should toggle and
      write back to `~/.opencues/opencues.md`.
- [ ] **G. Type `volume _`** — control-bound blank should auto-populate
      with the live value. Cycling should call `volume.sh up/down`.
- [ ] **H. Type `HN posts _`** — HackerNewsControl should populate
      with live RSS headlines.
- [ ] **I. Edit `~/.opencues/cues.md`** — hot-reload should pick up
      the change within ~2s without TUI restart.
- [ ] **J. Edit text outside a cycled word** — cycle progress should
      survive prefix edits (deterministic relocate).
- [ ] **K. Compare behavior side-by-side with `opencues run claude-code`**
      — same sentence, same cues, same cycle results.

---

## Tier 7 — Documentation parity with OC

Once codex actually works, mirror OC's reintegration docs.

- [ ] **A. Promote codex from pre-alpha → alpha/beta in:**
      `README.md`, `damon.md`, `CLAUDE.md`, `integrations/codex/README.md`,
      `integrations/codex/HANDOFF.md` (or rename to DONE.md)
- [ ] **B. Write `integrations/codex/reintegration/steps.md`** —
      mirror OC's per-phase walkthrough with commit SHAs, rollback
      targets, module list per phase, live-test instructions
- [ ] **C. Write `integrations/codex/reintegration/parity-review.md`** —
      OC has this; documents which OC features the integration does/doesn't have
- [ ] **D. Write `packages/opencues-runtime/adapters/codex/REPAIR.md`** —
      mirror OC's REPAIR.md with the live-fixes discovered during
      testing (the "8 bugs" in OC's was hard-won knowledge)
- [ ] **E. Write `integrations/codex/patches/advance.sh`** —
      mirror OC's advance.sh — incremental phase advancer with the
      live-fixes baked in. Useful for re-applying after upstream
      codex-rs changes.
- [ ] **F. Update CLAUDE.md "Claude Installs" section** — add codex
      as a parallel install with its own line in the table
- [ ] **G. Update CLEANUP.md** — once Tier 1-5 done, mark codex
      cleanup items in CLEANUP.md as completed

---

## What I checked vs didn't (audit transparency)

**Files I read in full:**
- `integrations/codex/README.md`, `HANDOFF.md`, `package.json`, `bin/install.cjs`, `patches/setup.sh`, `docs/{protocol,architecture}.md`
- `integrations/codex/patches/opencues-bridge/src/lib.rs`, `Cargo.toml`
- `packages/opencues-runtime/adapters/codex/v1/{boot,daemon}.ts`
- The full agent comparison report at `/tmp/codex-vs-oc-comparison.md`

**Files I sampled:**
- `integrations/opencode/patches/opencuesBootstrap.ts` (read by audit agent)
- `packages/opencues-runtime/adapters/oc/v1.4/{adapter,boot}.ts` (read by audit agent)

**What I did NOT verify (needs running code):**
- Whether `cargo build -p opencues-bridge` actually succeeds on a fresh clone
- Whether `cargo run --bin opencues-bridge-smoke` exits 0
- Whether the daemon path `packages/opencues-runtime/dist/adapters/codex/v1/daemon.js` is correctly produced by the runtime build
- Whether the codex pinned SHA `d58d3cc` still exists on `openai/codex` upstream (may have been pruned)
- Anything that requires a running TUI

**Tooling assumptions:**
- You have `rustup` + `cargo` available
- You're on the same machine as OC (i.e. `~/codex-cues` for the fork is fine)
- `pnpm exec opencues install codex` is the canonical install command (per CLI registry)

---

## Estimated effort

| Tier | Hours | Notes |
|---|---|---|
| 1 | done | trivial cleanups |
| 2 | done (A, D) + ~1h (B, C, E remaining) | infra polish |
| 3 | 3-6h | daemon wiring — the biggest TS chunk |
| 4 | 2-4h | bridge fixes — Rust |
| 5 | 4-8h | TUI patches — the HANDOFF.md headline |
| 6 | 1-2h | end-to-end verification |
| 7 | 1-2h | docs |
| **Total** | **~12-22h** | for a full beta-quality codex integration |
