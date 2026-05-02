# Codex ↔ OpenCode parity review

**As of:** 2026-04-22 (post Tier 1-5 + parts of 3.G/4.C/4.F)
**Pinned to:** codex-rs SHA `d58d3cc`
**Reference:** OpenCode integration at `integrations/opencode/` —
the production-grade pattern codex mirrors. Differences below are
either codex-specific architecture (Rust TUI vs TS TUI, JSON-RPC
bridge vs in-process) or known gaps documented as Tier 4 defensive
follow-ups.

## Surface-level parity matrix

| Capability | OC | Codex | Notes |
|---|---|---|---|
| `opencues install <host>` | ✅ | ✅ | 9 setup steps, OPENCUES_INSTALL_VERBOSE=1 |
| `opencues uninstall <host>` | ✅ | ✅ | git checkout + rm |
| `opencues run <host>` | ✅ | ✅ | launch helper at `<fork>/launch.sh` |
| `opencues seed-configs` | ✅ | ✅ | identical implementation |
| `--target <path>` flag | ✅ | ✅ | custom fork dir |
| `--dry-run` flag | ✅ | ✅ | 8-step plan listed |
| Pre-flight cargo version check | n/a (TS) | ✅ | rustup ≥1.85 required for codex-rs's edition2024 |
| `opencues which` integration | ✅ | ✅ | shows install state |
| `opencues doctor` integration | ✅ | ✅ | cross-host diagnostics |

## Runtime modules (subscribed by `buildSharedRuntime` in both)

| Module | OC | Codex | Notes |
|---|---|---|---|
| ConfigLoader | ✅ | ✅ | `await load()` before boot response (codex-only — OC fires-and-forgets; codex needs the populated cueMap before the bridge sends events) |
| Navigation | ✅ | ✅ | subscribed via buildSharedRuntime |
| Cycling | ✅ | ✅ | subscribed via buildSharedRuntime |
| BlankFill | ✅ | ✅ | subscribed via buildSharedRuntime; controlInvoke before spawnProcess |
| DimRender | ✅ | ✅ | subscribed via buildSharedRuntime |
| Resolver (LLM) | opt-in via `host.llmApiKey` | opt-in via `GROQ_API_KEY` env | same constructor args |
| Statusline | opt-in via `host.statusFilePath` | always-on at `/tmp/opencues-codex-${pid}.status.json` | codex enables unconditionally; same Statusline class |
| TTS | opt-in via `host.ttsScriptPath` | ☐ not wired | codex has no spawn-process bridge yet — TTS depends on it |
| CursorStateExport | opt-in via `host.cursorStatePath` | ☐ not wired (Tier 3.H optional) | codex has no in-tree consumer; can add when needed |
| `controlInvoke` registry | 6 controls | 6 controls | identical (`HackerNewsControl`, `StocksControl`, `WeatherControl`, `AnswerControl`, `PromptImproverControl`, `OpenCuesSettingsControl`) |
| `createSourceReclassifier` | ✅ | ✅ | one shared instance between adapter + bundle |

## Adapter capabilities

| Capability | OC `OPENCODE_V14_CAPABILITIES` | Codex `CODEX_BASE_CAPABILITIES` | Notes |
|---|---|---|---|
| `file-read` | ✅ | ✅ | direct fs ops in CodexAdapter |
| `file-write` | ✅ | ✅ | direct fs ops in CodexAdapter |
| `force-render` | ✅ | ✅ | bridge → daemon RPC |
| `render-override` | ✅ | ✅ | DimRender feeds RenderDirectives |
| `dim-ranges` | ✅ | ✅ | merged with history-search highlights in chat_composer.rs render path |
| `highlight-range` | ✅ | ✅ | as above |
| `change-source` | not in base | ✅ | added so reclassifier source attribution works |
| `spawn-process` | conditional on `host.spawnProcess` | ☐ never advertised | gracefully fails (exit 127) when BlankFill falls through; see REPAIR.md LF-5 |
| `control-invoke` | conditional on `host.controlInvoke` | conditional (always ON in production: registry passed) | mirrors OC pattern exactly |
| `selection` | n/a | ☐ | OC's getSelection always returns null too |
| `shimmer` | n/a | ☐ | chrome-only |

## RPC surface (codex-only)

OC has no RPC because the runtime is in-process. Codex's daemon ↔
bridge RPC surface (per `docs/protocol.md`):

| Method | Direction | Status | Notes |
|---|---|---|---|
| `boot` | bridge → daemon (request) | ✅ | constructs runtime bundle, awaits ConfigLoader.load |
| `text-change` | bridge → daemon (notification) | ✅ | reclassifies source, fans to onTextChange handlers |
| `key` | bridge → daemon (request) | ✅ | dispatches to onKey handlers, returns `{consumed: bool}` |
| `force-render` | bridge → daemon (request) | ✅ | collects directives, emits `directives` notification |
| `control-invoke` | bridge → daemon (request) | ✅ | dispatches to controls registry, returns ProcessResult or null |
| `directives` | daemon → bridge (notification) | ✅ | dim ranges + active range, applied in TUI render path |
| `set-text` | daemon → bridge (notification) | ✅ | wired via `Bridge::on_set_text` callback; ChatComposer drains a channel into the textarea |
| `log` | daemon → bridge (notification) | ✅ | bridge prints to stderr (TUI patch can route) |

## Tests

| File | OC | Codex | Notes |
|---|---|---|---|
| Adapter band `boot.test.ts` | 6 tests | 5 tests | codex's are surface tests (re-exports + types) — daemon does the heavy lifting |
| Adapter band `holder.test.ts` | 3 tests | n/a | codex has no holder pattern (no SolidJS lazy publish) |
| Daemon JSON-RPC tests | n/a | 33 tests | parse errors, jsonrpc version, unknown method, all 5 RPC methods, 4 sub-areas (Tier 3.A/C/D/E/F) |
| Total runtime tests | 415 → still passing | 415 → 463 (+48) | codex contributed 48 new tests across daemon + adapter band |

## Bridge crate (codex-only)

Rust crate at `integrations/codex/patches/opencues-bridge/`. No OC
analogue (OC runs in-process).

| Surface | Status | Notes |
|---|---|---|
| `Bridge::start(config)` | ✅ | spawns daemon, registers stdout + stderr threads |
| `notify_text_change(text, cursor, source)` | ✅ | fire-and-forget notification |
| `dispatch_key(KeyEvent) -> bool` | ✅ | id-keyed req/resp correlation, 200ms timeout, fail-open |
| `invoke_control(name, action, args) -> Option<Value>` | ✅ | 10s timeout for network-bound controls |
| `on_set_text(callback)` | ✅ | Send+Sync closure registered with frame thread |
| `directives() -> Directives` | ✅ | snapshot of last directives notification |
| `is_alive() -> bool` | ✅ | flipped false when stdout/stderr EOF observed |
| `recent_stderr() -> Vec<String>` | ✅ | ring buffer of 64 lines for crash diagnostics |
| Auto-restart on crash | ☐ | by design — TUI patch owns recovery flow |
| Heartbeat | ☐ | redundant with BrokenPipe surfacing immediately |
| Directives double-buffer | ☐ | premature optimization at this scale |

## TUI patches (Tier 5)

Pinned-version model: edits live as a unified-diff that `setup.sh`
`git apply`s on install. When upstream codex-rs moves past the
pinned SHA, the maintainer regenerates the diff against the new SHA.

| Edit | Where | Notes |
|---|---|---|
| Bridge crate dep | `tui/Cargo.toml` | `opencues-bridge = { path = "../opencues-bridge" }` |
| Struct field | `chat_composer.rs:ChatComposer` | `opencues_bridge: Option<Bridge>` + `opencues_set_text_rx` |
| Init in constructor | `chat_composer.rs:new_with_config` | spawns bridge if `OPENCUES_DAEMON_PATH` set; registers on_set_text |
| Key dispatch | `chat_composer.rs:handle_key_event` (top) | drain set-text → snapshot → dispatch_key → return on consumed |
| Text-change notify | `chat_composer.rs:handle_key_event` (bottom) | snapshot diff → notify_text_change |
| Render directives | `chat_composer.rs:render_textarea` (non-zellij) | merges bridge.directives() into existing styled-with-highlights path |
| Helper functions | top of `chat_composer.rs` | `opencues_key_name(KeyCode)`, `opencues_highlight_pairs()` |

Total diff: 230 lines, all marked with `OPENCUES_BRIDGE_BEGIN/END`
comments for re-apply detection.

## Documentation

| Doc | OC | Codex | Notes |
|---|---|---|---|
| Per-integration README | ✅ | ✅ | both updated for current state |
| Adapter REPAIR.md | ✅ | ✅ | codex has 6 LFs + 5 ILs documented |
| Reintegration logs | `steps.md`, `parity-review.md`, `O-review.md` | this file (parity-review.md) | codex's history is the commit log; no need for steps.md |
| HANDOFF.md | n/a | ✅ | will be updated to "alpha" after this commit |
| Architecture doc | brief in README | `docs/architecture.md` + `docs/protocol.md` | codex's RPC layer warrants extra docs |
| advance.sh | ✅ (8 live-fixes baked in) | ☐ | the pinned-version model means we regenerate the diff instead of layering fixes; `git apply` is the advance step |

## What's NOT verified yet (Tier 6)

These need an interactive `opencues run codex` session — the daemon
+ bridge + TUI patches are all in place but the live-typing
verification hasn't happened on this machine because
`cargo build -p codex-tui` requires `libcap-dev` (system package,
see REPAIR.md IL-3; one `sudo apt install -y libcap-dev` fixes it).

- Type a sentence with cuable words → see dim ranges visible
- Cycle a word → text mutates, cycle position survives
- Type `voice-mode _` → blank auto-populates with 'active' (or current value)
- Type `volume _` → BlankFill calls volume control via spawn fallthrough → currently degrades to "exit 127" per LF-5 (volume not hoisted)
- Type `HN posts _` → HackerNewsControl populates with live RSS headlines (works via control-invoke)
- Edit `~/.cues/cues.md` while codex is running → hot-reload picks up change
- Edit text outside a cycled word → cycle progress survives prefix edits (deterministic relocate)

The infrastructure layer is end-to-end verified via the smoke test
(bridge ↔ daemon JSON-RPC handshake + boot + control-invoke +
text-change + force-render). The TUI overlay is the last piece
that needs human eyes on a real terminal.

## Beta-readiness checklist

- [x] All Tier 1-5 sub-items done
- [x] All BLOCKERS cleared (Tier 4.A + 4.B)
- [x] Pre-flight checks for known environmental issues (cargo version, libcap, pinned SHA drift)
- [x] Idempotent install — safe to re-run any number of times
- [x] Live-fixes documented in REPAIR.md (6 LFs + 5 ILs)
- [x] Test coverage parity (48 new codex tests; full surface covered)
- [ ] Tier 6 interactive verification (needs the user)
- [x] Promote `pre-alpha` → `alpha` in README/HANDOFF
- [ ] Optional Tier 4 defensive items (auto-restart, heartbeat, double-buffer) — not blocking beta
