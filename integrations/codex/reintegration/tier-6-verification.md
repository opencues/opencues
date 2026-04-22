# Tier 6 — Interactive verification (user walkthrough)

The infrastructure layer is end-to-end smoke-tested (boot →
ConfigLoader → text-change → control-invoke → directives flow all
proven via JSON-RPC). What's NOT yet verified is what happens when
codex actually renders + a human types: do dim ranges show up, does
cycling work via Ctrl+Alt+Up/Down, does BlankFill auto-populate.

This page is the walkthrough for that verification.

## Prereqs (one-time)

### 1. libcap-dev (Linux only)

codex-rs links its sandbox crate against libcap. WSL2 / Ubuntu
defaults don't include it.

```bash
sudo apt install -y libcap-dev pkg-config
```

After this, `cargo build -p codex-tui` from `~/codex-cues/codex-rs/`
succeeds. (See `REPAIR.md` § IL-3.)

### 2. Rust toolchain ≥ 1.85

If you don't have rustup:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source ~/.cargo/env
```

Otherwise `rustup update stable`. Codex-rs needs edition2024
(stabilized in Rust 1.85). `bin/install.cjs` pre-flights this.

### 3. opencues-installed configs

```bash
pnpm exec opencues seed-configs   # populate ~/.opencues/ if not already
```

## Build + run

```bash
# From the opencues repo root:
pnpm exec opencues install codex   # 9 steps; first run takes ~5-10 min

# Then launch:
pnpm exec opencues run codex
# (or directly: ~/codex-cues/launch.sh)
```

The `launch.sh` helper sets `OPENCUES_DAEMON_PATH=...` so
ChatComposer's bridge starts. If the env var is missing, codex runs
unpatched (the bridge field stays None).

## Tail the daemon log in another terminal

```bash
tail -f /tmp/opencues.log
# or: pnpm exec opencues logs --tail
```

You should see:
```
[hh:mm:ss.mmm][codex-daemon][info] daemon started; pid=XXXX
[hh:mm:ss.mmm][codex-daemon][info] ConfigLoader: loaded N cue entries, opencuesState={...}
[hh:mm:ss.mmm][codex-daemon][info] daemon booted (params={...})
[hh:mm:ss.mmm][codex-daemon][info] Statusline export at /tmp/opencues-codex-XXXX.status.json
```

If `Resolver: built with N sources` appears, GROQ_API_KEY is set and
the LLM resolver is wired.

## Test cases (walk top-to-bottom)

- [ ] **T1 — Dim ranges appear on cuable words.** Type
      `the volume is 25 and HN posts hello`. Within ~500ms after the
      pause, `volume`, `25` (numbers control), and `HN` should appear
      dimmed. (Daemon emits `directives` notification with dim
      ranges; chat_composer.rs render path applies them.)

- [ ] **T2 — Navigation key dispatch.** Press `Ctrl+Alt+Right` to
      step to the next navigable word. Active word should appear
      highlighted (REVERSED+BOLD). `Ctrl+Alt+Left` to go back.

- [ ] **T3 — Cycling.** Navigate to `volume`, press `Ctrl+Alt+Up`.
      It should cycle to the volume control's behavior (currently
      degrades to "exit 127" in the daemon log because volume isn't
      hoisted — see REPAIR.md LF-5; non-fatal). Navigate to a
      grammar word like `hello`, press `Ctrl+Alt+Up` — it should
      cycle through LLM-suggested alternatives (requires
      `GROQ_API_KEY`).

- [ ] **T4 — Selector + Satellite blanks.** Type `voice-mode _`. The
      `_` should auto-populate with the current value (`active` or
      `inactive`) within ~500ms. `Ctrl+Alt+Up` cycles between values
      and writes back to `~/.opencues/opencues.md` via the
      OpenCuesSettingsControl (verify the file changed).

- [ ] **T5 — Hoisted control end-to-end.** Type `HN posts _`. The
      blank should populate with a live HN headline within a few
      seconds (network call to HN's RSS). Cycling shows different
      headlines.

- [ ] **T6 — Hot-reload.** With codex still open, edit
      `~/.opencues/cues.md` (e.g. add a tip). The daemon's
      ConfigLoader polls every ~2s; the next text-change you trigger
      should pick up the new tip without restarting codex.

- [ ] **T7 — Cycle survival across edits.** Cycle `attorney` →
      `lawyer`. Then prepend `Yesterday ` to the input. Cycle
      progress on `lawyer` should survive the prefix shift via
      deterministic relocate (see
      `docs/features/deterministic-relocate.md`).

- [ ] **T8 — Status file.** Verify
      `/tmp/opencues-codex-${pid}.status.json` exists and updates
      when you focus a word. (`cat $(ls -t /tmp/opencues-codex-*.status.json | head -1)`)

- [ ] **T9 — Side-by-side parity.** Type the same sentence in
      `opencues run claude-code` and `opencues run codex`. The
      navigable words should match (modulo controls only available
      in one of the integrations).

- [ ] **T10 — Daemon crash recovery.** Find the daemon's pid (in
      `/tmp/opencues.log`), `kill -9 <pid>`. Codex should keep
      running (degraded — no dimming). The TUI patch's
      `Bridge::is_alive()` polling will detect and could trigger a
      restart, but auto-restart isn't wired in chat_composer.rs yet.
      For now, restart codex to recover.

## Things that won't work yet

- **TTS (`speak: true` words)** — codex doesn't have a spawn-process
  bridge yet; TTS depends on it. Tier 3 follow-up.
- **Volume / brightness / any `.sh`-backed control via cycling** —
  the spawnProcess fallthrough returns exit 127 (LF-5 in REPAIR.md).
  The hoisted controls (HN, Stocks, Weather, Answer, PromptImprover,
  OpenCuesSettings) all work via control-invoke.
- **Auto-restart on daemon crash** — Bridge::is_alive() exposes
  the signal; chat_composer.rs doesn't poll it yet.

## What to do if something fails

1. **Check `/tmp/opencues.log` first.** The daemon logs every RPC
   it processes; an error line with file:line points at the bug.
2. **Check the daemon stderr ring** via the bridge. From inside
   chat_composer.rs you'd call `bridge.recent_stderr()`; from
   outside, look at `/tmp/opencues.log` and any panics codex prints.
3. **Walk REPAIR.md.** LFs are bugs we already hit + fixed; ILs are
   environmental gotchas. Symptom → Why → Fix.
4. **File a new LF entry.** Symptom / Why / Fix / File:line, plus
   note whether the fix needs to land in `tui-bridge-wiring.diff`
   (regenerate with `cd ~/codex-cues && git diff codex-rs/tui/`).

## Done?

Once T1-T8 are green and T9-T10 are at least understood, the
integration is **beta**. Update `integrations/codex/README.md` +
`HANDOFF.md` to flip alpha → beta, and remove the "needs
interactive verification" line from `parity-review.md`'s
beta-readiness checklist.
