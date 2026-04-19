# OpenCues for Claude Code

`@opencues/cc` — patches Claude Code's CLI via [tweakcc](https://github.com/Piebald-AI/tweakcc) to add real-time word alternatives, blanks, and cue-controls inline in your prompts.

| Field | Value |
|---|---|
| Version | 0.1.0 |
| Compatible with | Claude Code 2.1.110+ (2.1.x line) |
| Source | `integrations/cc/` |
| Runtime | `@opencues/core`, `@opencues/runtime` (installed to `~/.claude/node_modules/`) |

---

## Install (from a clone)

```bash
git clone https://github.com/opencues/opencues
cd opencues
pnpm install
pnpm --filter @opencues/cc dev-install
```

If your `claude` CLI lives at a non-standard path (e.g. you use [`claude-cues`](../../CLAUDE.md#claude-installs) at `~/local-claude-code/`):

```bash
pnpm --filter @opencues/cc dev-install -- \
  --target ~/local-claude-code/node_modules/@anthropic-ai/claude-code/cli.js
```

The installer:
1. Builds `@opencues/core` + `@opencues/runtime` (turbo-cached)
2. Installs them to `~/.claude/node_modules/@opencues/{core,runtime}/`
3. Builds tweakcc with the patches under `patches/`
4. Applies patches to the detected `cli.js`

> **Future:** post-publish, the same script runs as `npx @opencues/cc`. Same flags, same behaviour.

---

## Verify

After install, restart `claude-cues` (or whichever Claude CLI you patched) and try:

| Test | What it checks |
|---|---|
| Type `5f`, position cursor on it, Ctrl+Alt+Up | Numeric cycling: `5f → 5.5f → 6f` |
| Type `voice-mode active`, cycle Up | Selector/satellite + `@opencues/runtime` settings control |
| Type `weather _ paris` | LLM/HTTP control: fills with current Paris weather |
| Cycle any cyclable word | TTS announces the cycled value (uses `~/.claude/actions/speak.sh`) |
| Verify highlighted word shows tip in the status bar | Statusline export → `highlight-statusline.sh` |

If any of these fail, tail `/tmp/opencues.log` in another shell — the runtime writes diagnostics there regardless of whether the TUI swallows stderr.

---

## Update workflow

```bash
cd opencues
git pull
pnpm install                              # picks up dep changes
pnpm --filter @opencues/cc dev-install    # rebuilds + redeploys
# Restart claude-cues
```

`.md` config files (`cues.md`, `blanks.md`, `controls.md`, `cues/*`, `controls/*`) hot-reload within ~2s on the next keystroke — no install needed for config edits.

---

## What gets installed where

| Path | Contents |
|---|---|
| `~/.claude/node_modules/@opencues/core/` | Built `@opencues/core` (CueResolver, parsers, sources) |
| `~/.claude/node_modules/@opencues/runtime/` | Built `@opencues/runtime` (Navigation, Cycling, BlankFill, controls/) |
| `~/.claude/claude-code-tips.json` | Pre-computed word alternatives (read by ConfigLoader) |
| `~/.claude/actions/` | OS-bound scripts (`speak.sh`, `volume.sh`, `brightness.sh`, plus `.exe` shims compiled from `.cs` on WSL) |
| `~/.claude/highlight-statusline.sh` | Status-line script (wire via `/statusline` in CC) |
| `<cli.js>` | Patched in-place; tweakcc keeps a `.backup` next to it |

---

## Removing

Restore the original `cli.js` from the backup tweakcc kept:

```bash
cp ~/.tweakcc/cli.js.backup \
   ~/local-claude-code/node_modules/@anthropic-ai/claude-code/cli.js
rm -rf ~/.claude/node_modules/@opencues
rm -rf ~/.claude/actions ~/.claude/claude-code-tips.json ~/.claude/highlight-statusline.sh
```

---

## See also

- [`docs/architecture/repo-structure.md`](../../docs/architecture/repo-structure.md) — overall repo shape + stage tracker
- [`integrations/cc/docs/`](docs/) — feature reference (navigation, cycling, alternatives, blanks, status line, etc.)
- [`integrations/cc/docs/architecture.md`](docs/architecture.md) — patch architecture + development notes
- [`CLAUDE.md`](../../CLAUDE.md) — internal project notes including the `claude-cues` vs `claude` install distinction
