# OpenCues for OpenAI Codex (TUI)

`@opencues/codex` — patches OpenAI's [Codex Rust TUI](https://github.com/openai/codex) to add real-time word alternatives, blanks, and cue-controls inline in the chat composer.

| Field | Value |
|---|---|
| Version | 0.0.1 (pre-alpha — Rust TUI patches incomplete; see HANDOFF.md) |
| Compatible with | codex-rs (pinned SHA in `patches/setup.sh`) |
| Source | `integrations/codex/` |
| Architecture | Node daemon (`@opencues/runtime`) ↔ Rust bridge crate ↔ codex TUI patches |

> **STATUS — pre-alpha.** This integration's *infrastructure* (skeleton, install pipeline, JSON-RPC protocol, Rust bridge crate) is in place. The TUI patches that hook OpenCues' rendering + key-handling into Codex's `ChatComposer` are NOT yet implemented. See [`HANDOFF.md`](HANDOFF.md) for the remaining work.

## Install (from a clone)

```bash
git clone https://github.com/opencues/opencues
cd opencues
pnpm install
pnpm build

# Requires: rust toolchain (rustup) + cargo
pnpm exec opencues install codex
# or directly:
pnpm --filter @opencues/codex dev-install
```

The installer:
1. Verifies `cargo` is on PATH (rust toolchain required)
2. Clones `openai/codex` at the pinned SHA into `$HOME/codex-cues/` (or `--target <dir>`)
3. Builds `@opencues/runtime` (turbo-cached)
4. Adds `opencues-bridge` Rust crate to the codex workspace
5. Builds the patched codex TUI via `cargo build --release` (slow — first build ~5 min)
6. Drops a launch script the user invokes via `opencues run codex`

## Why a JSON-RPC bridge?

Codex is Rust; `@opencues/runtime` is TypeScript. Three options were considered:

1. **Subprocess + JSON-RPC over stdio** ← chosen. Daemon owns runtime state; bridge crate marshals events. No language re-write, runtime stays the source of truth across all hosts.
2. **Embed a JS engine in Rust (deno_core / boa)** — adds ~10MB binary weight, slow startup, opaque debugging.
3. **Port runtime to Rust** — multi-month effort, splits the source of truth.

JSON-RPC keeps the runtime authoritative and the bridge thin. Latency is sub-ms over a Unix pipe, fine for keystroke-paced events.

## Architecture

```
┌─────────────────────────┐     spawn        ┌──────────────────────────┐
│  codex-rs TUI           │ ────────────────▶│  Node daemon              │
│  (patched ChatComposer) │                   │  @opencues/runtime        │
│                         │ ◀──── stdio ─────│  (resolves cues, owns     │
│  opencues-bridge crate  │   JSON-RPC v2.0  │   ConfigLoader state)     │
└─────────────────────────┘                   └──────────────────────────┘
       ▲                                                 │
       │ key + text events                               │
       │                                                 ▼
       └─── render directives ◀──────── /tmp/opencues.log
            (highlight ranges,
             active-word index)
```

The daemon process lives for the duration of the codex session. JSON-RPC frames are line-delimited (one JSON object per line) for trivial parsing on both sides.

See [`docs/protocol.md`](docs/protocol.md) for the wire format.

## Run (post-install)

```bash
pnpm exec opencues run codex
# starts the patched codex TUI; the daemon is auto-spawned
```

Or directly: `cd ~/codex-cues && cargo run --release`.

## Verify

After install:
- `pnpm exec opencues which` — shows codex install state (✓/-)
- `pnpm exec opencues doctor` — runs cross-host diagnostics
- `pnpm exec opencues logs --tail` — tail runtime debug log

In a running codex session (post-TUI-patch):
- Type any text — words with available alternatives should dim
- Ctrl+Alt+Up/Down should cycle alternatives (key bindings TBD per Codex's existing chord map)

## Blast radius

| Path | What | Removed by uninstall? |
|---|---|---|
| `$HOME/codex-cues/` | Codex fork (~hundreds of MB) | ✗ leave manually with `rm -rf` |
| `<fork>/opencues-bridge/` | Bridge crate copy | ✓ |
| `<fork>/Cargo.toml` patches | Workspace member added | ✓ via git checkout |
| `<fork>/codex-rs/tui/src/...` patches | TUI hooks (when implemented) | ✓ via git checkout |
| `<fork>/target/` | Cargo build cache | leave |
| `~/.opencues/` user configs | shared with cc/oc | unchanged |

Runtime state during a session: `/tmp/opencues.log`, `/tmp/opencues-codex-<pid>.sock` (the daemon socket).

## Uninstall

```bash
pnpm exec opencues uninstall codex
# git checkout the patched files in the fork, rm bridge crate, rm launch script
# leaves the fork dir itself in place
```

To remove the fork entirely: `rm -rf $HOME/codex-cues`.

## See also

- [`HANDOFF.md`](HANDOFF.md) — what's done vs what remains for the TUI patches
- [`docs/protocol.md`](docs/protocol.md) — JSON-RPC wire format
- [`docs/architecture.md`](docs/architecture.md) — bridge crate + daemon design
- [`@opencues/runtime` adapter band](../../packages/opencues-runtime/adapters/codex/v1/) — adapter scaffolding
