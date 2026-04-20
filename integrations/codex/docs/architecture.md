# Architecture

How the three pieces fit together.

## The three pieces

1. **`@opencues/runtime` daemon entry** — `packages/opencues-runtime/adapters/codex/v1/daemon.ts`. A long-running Node process that owns ConfigLoader, Navigation, Cycling, BlankFill, etc. — the same modules CC and OC use. Reads JSON-RPC requests from stdin, writes notifications + responses to stdout.

2. **`opencues-bridge` Rust crate** — `integrations/codex/patches/opencues-bridge/`. A small (~300 line) crate copied into the codex workspace by setup.sh. Responsibilities:
   - Spawn the daemon subprocess on startup
   - Marshal text-change, key events, force-render to the daemon as JSON-RPC
   - Receive set-text / directives / log notifications
   - Maintain the latest directives for the TUI render path to read
   - Clean shutdown when the TUI exits

3. **TUI patches** — applied by setup.sh (TODO; see HANDOFF.md). Wire `chat_composer.rs` to the bridge:
   - On every key event: `bridge.dispatch_key(...)` → swallow if consumed
   - On every text mutation: `bridge.notify_text(...)`
   - On every render pass: `bridge.directives()` to get highlight ranges, apply via TextArea styled-spans

## Why this shape

**Daemon owns runtime state.** ConfigLoader caches parsed configs, Cycling tracks current alt index per word, BlankFill holds in-flight requests. Putting any of that in Rust would mean reimplementing all 350+ runtime tests in Rust. Daemon = single source of truth, host gets a dumb client.

**Per-session daemon, not global.** Each codex TUI session spawns its own daemon. Avoids cross-session state corruption + makes `kill <tui-pid>` clean up everything. Daemon socket path includes pid to disambiguate concurrent sessions.

**JSON-RPC over stdio.** No port allocation, no socket files to clean up, no auth. stdio closes when the parent dies. Latency is ~100µs per round-trip on the same machine — fine for keystroke pacing (~100ms human cadence). If we ever need lower latency, switch to a Unix domain socket; the protocol shape doesn't change.

**Bridge crate is thin.** It does NOT know about cues, controls, or LLMs. It only knows: "send these events, receive those directives, render this overlay." All semantic logic stays on the Node side. Means we can swap the daemon without touching Rust.

## What stays in Rust

- TUI rendering (ratatui frame management)
- Key event capture (the bridge intercepts BEFORE Codex's normal handling)
- Text buffer ownership (the daemon never directly mutates the TextArea — it sends `set-text` notifications which the bridge applies)
- Codex's normal commands, slash commands, MCP wiring — all unchanged

## What stays in TS (daemon side)

- ConfigLoader + parse + hot-reload
- Resolver (LLM calls)
- Navigation / Cycling / BlankFill / DimRender modules
- All 6 hoisted controls (HackerNewsControl, StocksControl, etc. — same code CC + OC use)
- Statusline (writes to its own log file or sends `directives.tip` to the bridge)

## Why no embedded JS engine

Considered embedding `deno_core` (V8) or `boa` (pure-Rust JS) in the bridge, then loading `@opencues/runtime` directly. Rejected because:

- **Binary weight.** `deno_core` is ~10MB linked. Codex's release binary is currently ~80MB; adding 10MB for OpenCues integration is a heavy ask of users who don't care about it.
- **Startup cost.** V8 init takes ~50ms. Multiplied across N sessions = annoying. Daemon process startup is ~30ms (Node V8 init too, but only once per session).
- **Debugging.** If something breaks inside the embedded engine, debugging is hell. Subprocess + JSON-RPC = `tail /tmp/opencues.log` + JSON-RPC tracing. Both ends are debuggable independently.
- **Hot-reload contention.** `@opencues/runtime` ConfigLoader uses fs.watch → polling. In-process embedding would conflict with Codex's own file-watching for its config.

The subprocess approach has none of those problems and the only cost is the JSON-RPC protocol itself (which is tiny + reusable for future hosts).

## What this means for future hosts

If we ever add (e.g.) an Emacs integration, a Vim integration, or any other host where embedding TS is awkward, the JSON-RPC protocol from `docs/protocol.md` is reusable verbatim. New hosts only need to:

1. Spawn the daemon (same binary, same args)
2. Translate their key/text events to the protocol
3. Apply the daemon's directives to their render path

The bridge crate's pattern (300 lines) is roughly portable — replace the Rust-specific bits (tokio runtime, serde) with whatever the new host uses.
