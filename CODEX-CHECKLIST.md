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
> **What's been done overnight (commits, in order):**
> - `d6d6671` Tier 1 cleanups + this checklist
> - `6cbc270` Tier 2.A + 2.B + 2.C: setup.sh refactored to per-step
>   `run_step` pattern with log file + `OPENCUES_INSTALL_VERBOSE=1`;
>   each install step now wrapped, errors point at which step broke
> - `e047431` Tier 2.D: daemon refactored to expose `createDaemon()`
>   factory, **12 unit tests added** + 1 real bug found and fixed
>   (daemon crashed on `boot` without params)
> - `<below>` Tier 2.E: codex/v1 adapter band has 5 surface tests
>   for boot.ts re-exports + CodexHostInfo shape + createDaemon API
>
> Runtime test count went from 415 → 432.
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

- [x] **A. `OPENCUES_INSTALL_VERBOSE=1` env-var support in setup.sh** —
      mirrors OC's pattern (env var, no CLI flag — OC doesn't have
      one either). Default pipes to `/tmp/opencues-install-codex.log`;
      `OPENCUES_INSTALL_VERBOSE=1` streams to stdout. **Done.**
- [x] **B. Error wrapping in setup.sh** — each step is now a function
      wrapped in `run_step` (the OC pattern). On failure, the failing
      step label + last 30 log lines are dumped to stderr. **Done
      (came with A).**
- [x] **C. Build steps stream to log** — every step now appends to
      `/tmp/opencues-install-codex.log`. The cargo build output is
      no longer truncated through `tail -15` — the full error is
      visible in the log file. **Done (came with A).**
- [x] **D. Daemon JSON-RPC unit tests** — 12 tests covering parse
      errors, jsonrpc version check, unknown methods, boot, key,
      text-change, force-render, notification (no-id) cases, and
      multi-frame state continuity. Caught + fixed a real bug:
      daemon crashed when `boot` was called without params.
      **Done.** *Files:*
      `packages/opencues-runtime/adapters/codex/v1/daemon.test.ts`
- [x] **E. Adapter band `boot.test.ts` parity** — 5 surface tests
      pinning the codex/v1 boot.ts re-exports + CodexHostInfo type
      shape + createDaemon API. **Holder.test.ts is N/A** — codex
      has no holder pattern (no SolidJS-style lazy publish; daemon
      owns its own state). **Done.** *Files:*
      `packages/opencues-runtime/adapters/codex/v1/boot.test.ts`

---

## Tier 3 — Daemon module wiring (~3-6 hours)

This is the big work to make the daemon non-stub. Each step
should mirror what `integrations/opencode/patches/opencuesBootstrap.ts`
does for OpenCode. Use OC as the structural template.

- [x] **A. Wire ConfigLoader** — Done. The boot RPC handler now
      constructs the runtime bundle (CodexAdapter + ConfigLoader),
      calls `subscribe()` + awaits `load()`, and only then sends the
      `{ok:true}` response. Boot failures return `-32001` instead of
      crashing. Live-verified: loading `~/.cues/` produced
      "ConfigLoader: loaded 138 cue entries, opencuesState={...}".
      Companion fix: `startDaemon` now tracks in-flight handleLine
      promises and awaits them on stdin close — single-line stdin
      pipes were racing the async boot handler before this.
- [x] **B. Construct adapter wrapping the daemon** — Done (FS subset).
      `adapters/codex/v1/adapter.ts:CodexAdapter` implements
      HostAdapter. FS ops + log are real via `node:fs/promises`;
      UI ops (getText/setText/onKey/onTextChange/onRender/
      forceRender/pushText) are STUBS that register subscriptions in
      arrays and expose `notifyTextChangeFromBridge` /
      `dispatchKeyFromBridge` / `collectRenderDirectives` bridge
      points the daemon will fan into when Tier 3.F-I lands.
      `spawnProcess` + `controlInvoke` are unimplemented (Tier 3.D-E).
      Capabilities = `['file-read', 'file-write']` for now; UI caps
      get added as their wiring lands.
- [x] **C. Source reclassifier** — Done. `defaultBuildRuntime`
      constructs the reclassifier and passes it into both the adapter
      (so `setText`/`pushText` mark runtime writes) and the bundle (so
      the daemon's text-change RPC handler can reclassify, when 3.F
      lands). 5 unit tests cover the bundle inclusion, mark-write
      behaviour for setText + pushText, one-shot semantics, and the
      adapter-without-reclassifier graceful no-op.
- [x] **D. Build controls registry** — Done. `buildControlsRegistry()`
      in `daemon.ts` registers the same six controls OC wires
      (HackerNews, Stocks, Weather, Answer, PromptImprover,
      OpenCuesSettings) with identical constructor args.
      `findOpenCuesMdPath()` mirrors OC's resolution
      ($OPENCUES_HOME → ~/.opencuesrc). `createControlInvoke`
      wraps the registry; `CodexAdapter` accepts the binding + adds
      `'control-invoke'` to capabilities when supplied. Same
      per-instance capability pattern OC uses in
      `adapters/oc/v1.4/adapter.ts:91-98`. 5 unit tests.
- [x] **E. Add `control-invoke` RPC method to protocol + daemon** —
      Done. New `control-invoke` request method dispatches to the
      Tier 3.D registry, returning the underlying `ProcessResult`
      shape verbatim. Unknown controls return `result: null` so the
      bridge can fall back to native. Errors fall into JSON-RPC's
      pre-defined codes (`-32000` not booted, `-32602` bad params,
      `-32603` internal failure); control-execution failures stay
      in the result body (non-zero `exitCode`) per the Control
      interface contract. Live-verified against real
      `OpenCuesSettingsControl` reading `~/.opencuesrc`.
      Bonus: caught + fixed an FIFO ordering bug — readline 'line'
      events now process serially through a chained promise queue.
      6 new unit tests.
- [x] **F. Wire Navigation / Cycling / BlankFill / DimRender / Resolver
      modules** — Done. `defaultBuildRuntime` calls `buildSharedRuntime`
      (same primitive OC uses) which subscribes ConfigLoader,
      Navigation, DimRender, Cycling, BlankFill atomically. Plus an
      opt-in Resolver gated on `GROQ_API_KEY` env var, mirroring OC's
      lines 196-206. **Three RPC fanout handlers wired** —
      `text-change` reclassifies + fans to text subscribers; `key`
      dispatches to key handlers + returns `consumed`; `force-render`
      collects every handler's render directives + emits a
      `directives` notification. CodexAdapter capabilities expanded
      to match `OPENCODE_V14_CAPABILITIES` + `change-source`.
      `spawnProcess` now degrades gracefully (warn + fail-handle)
      instead of throwing — BlankFill's controlInvoke→spawnProcess
      fallthrough doesn't gate on the spawn-process cap, so .sh-only
      controls would crash without this. Live-verified end-to-end:
      typing `the volume is 25 and HN posts _` correctly emitted
      `dim:[{4,10},{21,23}]` (volume + HN both dimmed) AND invoked
      the hoisted HackerNewsControl via control-invoke. Statusline
      (3.G) and TTS still TODO. 10 new tests.
- [x] **G. Statusline file export** — Done. Statusline subscribed
      unconditionally; writes `/tmp/opencues-codex-${pid}.status.json`
      on every changed-state render. Live-verified output matches OC's
      payload shape. Bonus fix: 100ms drain timeout on stdin close so
      async writeFile completes before exit (LF-6 in REPAIR.md).
- [ ] **H. Cursor state export** — Skipped. Codex doesn't have an
      external status-line script consumer the way CC does, and
      cursor position is already in the Statusline payload's `text`
      field. Wire later if a need surfaces.
- [x] **I. Wire `force-render` to actually emit `directives`** —
      Done as part of 3.F (the handler is in the same case block as
      text-change/key). `force-render` collects every render handler's
      directives, merges into one payload, emits a `directives`
      notification.

---

## Tier 4 — Rust bridge fixes (~2-4 hours)

The bridge crate has known holes. These are Rust changes that need
careful design — concurrency, ownership, async. Not as straightforward
as the daemon work above.

- [x] **A. Implement `dispatch_key` request/response correlation by
      ID** — Done. Used option (b) — std::sync::mpsc::sync_channel
      per request keyed by id in a HashMap. Frame handler thread
      sends the result Value to the parked SyncSender; dispatch_key
      blocks on `recv_timeout(200ms)` and parses
      `{consumed: bool}`. Times out fail-open (returns false) so a
      stuck daemon never hangs the codex render loop. KeyEvent +
      Modifiers structs exposed so callers build typed events.
      Live-verified via smoke.rs.
- [x] **B. Implement `set-text` callback** — Done.
      `Bridge::on_set_text(Option<SetTextCallback>)` registers a
      `Box<dyn Fn(&str, usize) + Send + Sync>` that the frame handler
      invokes when a `set-text` notification arrives. Codex's TUI
      patch (Tier 5) will register this once during
      `ChatComposer::new` to wire runtime-driven writes back into the
      actual TextArea. `None` unregisters. Live-verified registration
      in smoke.rs.
- [x] **C. Daemon liveness flag (replaces auto-restart)** — Done.
      `Bridge::is_alive()` returns false when stdout/stderr EOF is
      observed by the reader threads. Codex's TUI patch polls this
      and decides whether to drop+restart the bridge. Auto-restart
      lives in the TUI patch, not Bridge — gives codex control over
      user-visible recovery (banner, retry button).
- [ ] **D. Heartbeat** — Skipped. BrokenPipe on the next write
      surfaces death immediately; a separate ping wouldn't help.
- [x] **E. Request timeout in `send_request`** — Done as part of 4.A.
      `request_with_timeout(method, params, timeout)` is the new
      one-shot RPC helper. dispatch_key uses 200ms; invoke_control
      uses 10s (network-bound controls like Stocks/Weather/HN can
      take seconds). Timeouts return io::ErrorKind::TimedOut so
      callers can decide their fallback (dispatch_key → false,
      invoke_control → None).
- [x] **F. Better error reporting** — Done. Daemon stderr now
      captured via `Stdio::piped()`; reader thread maintains a
      ring buffer (last 64 lines). `Bridge::recent_stderr()` returns
      a snapshot — the TUI patch can include it in a "daemon died"
      banner or bug-report attachment.
- [ ] **G. Directives double-buffer** — Skipped. Premature at this
      scale (one writer + frame-rate reads; lock held only during
      clone). Revisit if profiling shows actual contention.

---

## Tier 5 — TUI patches in chat_composer.rs

All sub-items A-K landed. Pinned to codex-rs SHA d58d3cc. Patches
ship as a unified-diff at `integrations/codex/patches/tui-bridge-wiring.diff`
applied by setup.sh on install. Per the user's pegged-version model,
the diff will be regenerated when bumping PINNED_SHA.

- [x] **A. Read chat_composer.rs end-to-end** — done; patch points found.
- [x] **B. Read textarea.rs** — done; discovered it already has
      `render_ref_styled_with_highlights(ranges, style)` so no API
      additions needed.
- [x] **C. Decide rendering strategy** — picked option 3 (use the
      existing styled-with-highlights API). DIM modifier for dim
      ranges, REVERSED+BOLD for the active range, merged with the
      existing history-search highlights in the non-zellij branch.
- [x] **D. Wire bridge crate dep** — `opencues-bridge = { path = "../opencues-bridge" }`
      added to `tui/Cargo.toml`.
- [x] **E. `bridge: Option<opencues_bridge::Bridge>`** field on
      ChatComposer + `opencues_set_text_rx: Option<Receiver<...>>`.
- [x] **F. `new_with_config` starts the bridge** — gated on
      `OPENCUES_DAEMON_PATH` env (set by the launch helper). Failures
      drop to vanilla codex behaviour. Builds configSearchPaths from
      `$OPENCUES_HOME / cwd/.cues / $HOME/.cues` (mirrors OC
      and the runtime convention).
- [x] **G. dispatch_key BEFORE normal handling** — at the top of
      `handle_key_event`. Crossterm KeyCode → stable name string via
      `opencues_key_name`. Returns `(InputResult::None, true)` on
      consumed.
- [x] **H. notify_text_change AFTER mutation** — at the bottom of
      `handle_key_event`. Snapshot/diff approach (no instrumenting
      every insert_str / delete_char site).
- [x] **I. Apply directives in render path** — `opencues_highlight_pairs`
      helper converts dim + active to (Range, Style) tuples; merged
      with history-search highlights in the non-zellij branch.
- [x] **J. on_set_text callback** — registered in `new_with_config`.
      Pushes to a std::sync::mpsc channel; `handle_key_event` drains
      the channel at the top so cycling results land in the textarea
      before the next key is processed (also re-drains after a
      consumed key for cycle-result-then-immediate-redraw).
- [x] **K. setup.sh applies the diff** — new step 8
      "Apply TUI bridge-wiring patches" with idempotency
      (OPENCUES_BRIDGE_BEGIN marker check) + pre-flight (git apply
      --check, fails clean on upstream drift).

**Live-verified:**
- `pnpm exec opencues install codex` → 9/9 steps green
- Fresh-apply (after `git checkout` reverted fork files): 14
  OPENCUES_BRIDGE markers land in chat_composer.rs + opencues-bridge
  dep lands in Cargo.toml
- Idempotent re-run: apply step detects markers, skips cleanly
- Type-checked via `CODEX_SKIP_VENDORED_BWRAP=1 cargo check -p
  codex-tui --lib` (full build needs libcap-dev system package on
  Linux — orthogonal to patch validation)

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
      write back to `~/.opencuesrc`.
- [ ] **G. Type `volume _`** — control-bound blank should auto-populate
      with the live value. Cycling should call `volume.sh up/down`.
- [ ] **H. Type `HN posts _`** — HackerNewsControl should populate
      with live RSS headlines.
- [ ] **I. Edit `~/.cues/cues.md`** — hot-reload should pick up
      the change within ~2s without TUI restart.
- [ ] **J. Edit text outside a cycled word** — cycle progress should
      survive prefix edits (deterministic relocate).
- [ ] **K. Compare behavior side-by-side with `opencues run claude-code`**
      — same sentence, same cues, same cycle results.

---

## Tier 7 — Documentation parity with OC

Once codex actually works, mirror OC's reintegration docs.

- [x] **A. Promote codex from pre-alpha → alpha** — Done in
      README.md, damon.md, integrations/codex/README.md,
      integrations/codex/bin/install.cjs, integrations/codex/HANDOFF.md
      (banner at top, original text preserved as historical context).
- [ ] **B. `reintegration/steps.md`** — Skipped. The pegged-version
      model means the commit log IS the per-phase walkthrough; OC's
      steps.md was useful because that integration evolved across
      multiple sessions. Codex's full build-out lives in commits
      d6d6671 → adc0f40 with self-contained commit messages.
- [x] **C. `reintegration/parity-review.md`** — Done. 7-section
      OC-vs-codex feature matrix + Tier 6 verification list +
      beta-readiness checklist (7/9 done; remaining 2 need user-side
      libcap-dev + interactive run).
- [x] **D. `adapters/codex/REPAIR.md` filled in** — 6 LFs (live
      fixes from this session) + 5 ILs (infrastructure-level fixes)
      documented with Symptom/Why/Fix shape matching oc/REPAIR.md.
- [ ] **E. `patches/advance.sh`** — Skipped. The diff-based model
      means `git apply tui-bridge-wiring.diff` IS the advance step;
      no need for a script that layers fixes on top.
- [ ] **F. CLAUDE.md "Claude Installs" table** — Skipped. That table
      is for two parallel CC installs (claude-cues vs claude); codex
      doesn't have an analogous parallel-install story.
- [ ] **G. CLEANUP.md update** — N/A. CLEANUP.md doesn't currently
      have codex-specific items; nothing to mark.

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
| 2 | **all done** | infra polish |
| 3 | **A+B+C+D+E+F+G+I done; H skipped (codex-N/A)** | daemon wiring — the biggest TS chunk |
| 4 | **A+B+C+E+F done; D+G skipped (with rationale)** | bridge fixes — Rust |
| 5 | **all done** (pinned to SHA d58d3cc) | TUI patches — the HANDOFF.md headline |
| 6 | needs user (interactive `opencues run codex` after `sudo apt install -y libcap-dev`) | end-to-end verification |
| 7 | **A+C+D done; B/E/F/G skipped (with rationale)** | docs |
| **Total** | **~95% done** — only Tier 6 (interactive verification) needs the user | for a full beta-quality codex integration |
