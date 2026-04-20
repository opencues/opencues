# Handoff — what's done, what remains

Built overnight as scaffolding. The infrastructure layer is complete; the actual TUI patching needs human attention because Codex's `ChatComposer` is non-trivial and merging into evolving upstream Rust requires care.

## What's done ✓

| Layer | Status | Where |
|---|---|---|
| Package skeleton | ✓ | `package.json`, `bin/install.cjs` |
| README + docs | ✓ | `README.md`, `docs/protocol.md`, `docs/architecture.md` |
| JSON-RPC protocol spec | ✓ | `docs/protocol.md` — wire format defined |
| Node-side daemon | ✓ | `packages/opencues-runtime/dist/adapters/codex/v1/daemon.js` (entry point) |
| Adapter band placeholder | ✓ | `packages/opencues-runtime/adapters/codex/v1/boot.ts` |
| Rust bridge crate template | ✓ | `patches/opencues-bridge/` (copied into fork by setup.sh) |
| setup.sh — clone fork + add bridge crate | ✓ | `patches/setup.sh` |
| `opencues install codex` wiring | ✓ | `bin/install.cjs` + opencues CLI registry |
| `opencues run codex` wiring | ✓ | opencues CLI |
| `opencues doctor` codex section | ✓ | opencues CLI |
| Walkthrough checklist | ✓ | `CHECKLIST.md` (root) — "Codex" section |

## What remains (tagged TODOs in code)

### 1. Wire the bridge into Codex's `ChatComposer` (≈ 4-8 hours of Rust work)

**File:** `<fork>/codex-rs/tui/src/bottom_pane/chat_composer.rs`

**Hooks needed:**

- (a) **On every text change** (after `TextArea::insert_str`, `delete_char`, etc.): call `bridge.notify_text(&self.textarea.text(), self.textarea.cursor_offset())`. The bridge sends a JSON-RPC `text-change` notification to the daemon.
- (b) **On every key event** before normal handling: call `bridge.dispatch_key(key_event)` — if it returns `true`, swallow the event (the daemon consumed it for navigation/cycling).
- (c) **In the render loop**: query `bridge.directives()` for the latest highlight ranges, apply them to the `TextArea`'s render via either:
  - Modifying glyph styling per-cell during the existing render path
  - OR maintaining a parallel highlight overlay rendered on top
  - OR (cleanest) extending `TextArea` with a `set_styled_ranges(ranges: &[(Range<usize>, Style)])` API and using ratatui's `Span` styling

The `TextArea` component lives at `<fork>/codex-rs/tui/src/bottom_pane/textarea.rs`. Read it first; whichever approach is least invasive is best.

### 2. Wire the bridge crate into setup.sh patches (≈ 30 min)

**File:** `integrations/codex/patches/setup.sh`

Currently does steps 1-3 (clone, add to workspace, build). The TODO marker `# TODO STEP 4` shows where the in-place patches via Python/sed should go (mirrors `integrations/opencode/patches/setup.sh`'s pattern). Likely sed-injects:

- Add `let _bridge = opencues_bridge::Bridge::start();` to the ChatComposer constructor
- Add the call sites from §1 above
- Wire a Cargo.toml dep on `opencues-bridge`

### 3. Verify end-to-end (≈ 1 hour)

After §1 + §2 land:
1. `pnpm exec opencues install codex` — should clone, build, succeed
2. `pnpm exec opencues run codex` — TUI launches
3. Type "voice-mode active" — should highlight; cycling should toggle
4. Compare behaviour parity against `opencues run claude-code`

### 4. Optional polish

- `--watch` mode for the bridge crate (rebuild on save during dev)
- Latency tuning (the daemon's `text-change` could be debounced if needed)
- Codex-specific cue config (e.g. for the slash commands Codex supports natively)

## Why I stopped at this point

The TUI patches in §1 require:
- Reading 1000+ lines of `chat_composer.rs` + `textarea.rs` carefully
- Understanding Codex's render pipeline (ratatui `Frame` rendering, paint passes)
- Finding patch points that survive an upstream `git pull` (Codex evolves fast)
- Testing with a live LLM to verify the full loop works

Doing those in a session without you available risks shipping a half-broken patch I can't validate. The infrastructure I *did* build is the load-bearing part — the TUI hooks are mechanical from here, and the JSON-RPC daemon is identical regardless of host.

## Suggested workflow when picking this up

1. Read `docs/architecture.md` — 5 min, sets the mental model
2. Read `docs/protocol.md` — 5 min, the wire format
3. Read `patches/opencues-bridge/src/lib.rs` — 10 min, the existing client code
4. Run `pnpm exec opencues install codex` — confirms infrastructure works (cargo build of bridge crate alone)
5. Open `chat_composer.rs` in the fork, find the three patch points (a/b/c above), implement
6. `cargo build --release` in the fork; iterate
7. Run `opencues run codex`, smoke-test
8. Update CHECKLIST.md with the patch points actually used (so re-applying after upstream changes is mechanical)

Estimated time to working integration from here: 4–8 hours of focused work.
