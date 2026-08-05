# OpenCues for OpenCode

> Part of **[OpenCues](../../README.md)**. Other integrations:
> [Claude Code](../claude-code/README.md) · [Gemini CLI](../gemini-cli/README.md) ·
> [Chrome](../chrome/README.md) · [Shell](../shell/README.md).

`@opencues/opencode` — patches an [OpenCode](https://github.com/sst/opencode) TUI fork to add real-time word alternatives, blanks, and cue-blanks inline in your prompts. Native rendering via the TUI's syntax-highlighting layer.

> **Shares user-level state with CC**: `~/.cues/` (cue/blank configs) and `~/.cues/scripts/speak.sh` (TTS) are common across both native hosts. Brightness/volume cue-blanks, the opencues-settings selector/satellite, prompt-improver, stocks/weather/HackerNews blanks — all work identically on OpenCode because the runtime's `blanksRegistry` + spawn fallback are the same shape that CC uses. You can install OpenCode standalone (no CC required) and TTS still works.

| Field | Value |
|---|---|
| Version | 0.1.0 |
| Compatible with | OpenCode 1.4.x and 1.14.x (pinned to v1.14.17 / SHA `40ba8f3`; also tested on v1.4.14 / `c90281c` and v1.4.11 / `5e9d5c7`) |
| Source | `integrations/opencode/` |
| Runtime | `@opencues/core`, `@opencues/runtime` (installed into the fork's `node_modules/`) |

---

## Install

### Prerequisites

You need the `opencues` CLI on PATH. If you haven't set that up yet,
follow [`docs/install.md`](../../docs/install.md)
— that covers Node, pnpm, the clone, and getting `opencues` on PATH.

This integration also needs **[bun](https://bun.sh/)** — OpenCode
itself is a Bun app, so the fork's own dependencies install via
`bun install`. You don't have to install it yourself: the installer's
preflight offers a contained copy at `~/.opencues/vendor/bun/`
(removed cleanly by `opencues uninstall opencode`). Press **Y** to
accept, or **n** + install bun system-wide via
`curl -fsSL https://bun.sh/install | bash`.

### Install command

```bash
opencues install opencode
```

That's the whole install — one command, end to end. The installer will:

1. **Clone** `sst/opencode` at the pinned SHA into `~/.opencues/forks/opencode/` (or reuse an existing clone at `--target <path>`)
2. **Install fork dependencies** via `bun install` so the fork's own deps (e.g. `@opentui/solid/preload`) land
3. **Build** `@opencues/core` + `@opencues/runtime` (turbo-cached)
4. **Install** the built artefacts into the fork at `node_modules/@opencues/{core,runtime}/`
5. **Patch** the fork in place: drops `opencues.ts` bootstrap + edits `app.tsx`, `component/prompt/index.tsx`, `feature-plugins/home/footer.tsx`, `feature-plugins/sidebar/footer.tsx` (all paths relative to `~/.opencues/forks/opencode/packages/opencode/src/cli/cmd/tui/` — NOT files in the OpenCues repo)

Re-runs are idempotent — unchanged patches skip, unchanged builds skip. First install is ~5 min (mostly `git clone` + `bun install`); re-runs are under 30s.

### Custom fork location

```bash
opencues install opencode --target /path/to/your/opencode-fork
```

### Verbose output

Set `OPENCUES_INSTALL_VERBOSE=1` to stream every command's output. By default the installer shows a five-line progress summary and logs everything else to `/tmp/opencues-install-oc.log`.

---

## Run

```bash
opencues run opencode
```

Launches `bun run dev` inside the patched fork. Watch `/tmp/opencues.log` in a second shell for the boot line:

```
[HH:MM:SS][info] OpenCues runtime starting (OpenCode v1.4)
```

---

## Uninstall

One command:

```bash
opencues uninstall opencode
```

This reverts the four patched TSX files via `git checkout --`, deletes the `opencues.ts` bootstrap, and removes `node_modules/@opencues/{core,runtime}/`. The fork itself (`~/.opencues/forks/opencode/`) stays in place — it's your OpenCode checkout, not OpenCues's artefact. To remove it entirely:

```bash
rm -rf ~/.opencues/forks/opencode
```

---

## Verify

| Test | What it checks |
|---|---|
| Type `[Your prompt] improve prompt _` | **Prompt-improver blank** — the headline daily-driver: rewrites your rough prompt into a structured one before you send it. |
| Type `[Your prompt] add a paragraph about security _` | **Transform blank** — extends your existing draft with the requested addition, in place. |
| Type `[your list] format as bullet points _` | **Transform blank** — formatting instruction following the body. |
| Type `opencues settings _`, cycle Up | **Selector / satellite** — slide-out for runtime settings. |
| Type `we should ultrathink this approach`, navigate to `ultrathink` (Ctrl+Alt+Right), cycle Up | **Word cycle** — local-lookup tip with no LLM round-trip. |
| Status bar at bottom of TUI shows tip when a word is highlighted | `opencuesTip()` SolidJS signal wired into `home/footer.tsx`. |

If something fails, the runtime writes diagnostics to `/tmp/opencues.log`.

---

## Configuration

OpenCues reads configs from **one or more `.cues/` directories** in priority order:

| Source | Location | Purpose |
|---|---|---|
| `$OPENCUES_HOME` env var | wherever you set it | Top-priority override (CI / power users / dotfiles repo) |
| Project-level | `<cwd>/.cues/` | Per-project overrides — cd into your project, those configs apply |
| User-level | `~/.cues/` | Global defaults — apply everywhere unless overridden |

Project-level wins on name conflicts (cue source name, blank mode name, blank name). Hot-reload polls every search path on every keystroke — edit any file, changes take effect within ~2s.

Each directory has the same shape:
```
.cues/
├── CUES.md          word sources + LLM prompts
├── BLANKS.md        cue-blank declarations
├── cues/            folder-based cue sources (one folder per source)
│   └── <name>/CUE.md
└── blanks/          folder-based cue-blank configs
    └── <name>/BLANK.md
```

`OPENCUES.md` (voice-mode, tips-mode, debug-mode, cursor-navigate) is **system-wide**, runtime-owned, and lives only at user-level — the runtime auto-manages it.

**Seed `~/.cues/` from the repo's defaults:**

```bash
opencues seed-configs        # user-level
opencues seed-configs --project   # from a project dir
```

Idempotent — copies any file that doesn't already exist at the destination.

---

## Where things live (blast radius)

| Path | Contents |
|---|---|
| `~/.opencues/forks/opencode/` | Cloned OpenCode fork (~3 GB after `bun install`) |
| `~/.opencues/forks/opencode/node_modules/@opencues/core/` | Built `@opencues/core` |
| `~/.opencues/forks/opencode/node_modules/@opencues/runtime/` | Built `@opencues/runtime` |
| `~/.opencues/forks/opencode/packages/opencode/src/cli/cmd/tui/opencues.ts` | OpenCues bootstrap (the `opencuesBootstrap.ts` source, copied in) |
| `~/.opencues/forks/opencode/packages/opencode/src/cli/cmd/tui/app.tsx` | **Patched in place** — mounts the runtime + forwards keyboard events |
| `~/.opencues/forks/opencode/packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` | **Patched in place** — publishes textarea ref + onContentChange handler |
| `~/.opencues/forks/opencode/packages/opencode/src/cli/cmd/tui/feature-plugins/home/footer.tsx` | **Patched in place** — renders OpenCues tip alongside MCP status |
| `~/.opencues/forks/opencode/packages/opencode/src/cli/cmd/tui/feature-plugins/sidebar/footer.tsx` | **Patched in place** — renders OpenCues tip in the sidebar slot |
| `~/.cues/` | User-level configs (see Configuration above) |
| `/tmp/opencues.log` | Runtime debug log (created on first launch) |
| `/tmp/opencues-install-oc.log` | Installer log from the most recent install |

`opencues which` prints every path with ✓ / − markers per existence.

---

## Rendering — how selection, dim and markdown are styled

OpenCues paints its in-buffer styling through OpenTUI's `syntax.registerStyle` + `textarea.extmarks` APIs rather than ANSI codes. Each style is registered once on first use and reused by extmark ID — see `applyOpenCuesDirectives()` in `opencuesBootstrap.ts`.

| Style ID | Use | StyleDefinition |
|---|---|---|
| `opencues-highlight` | **Active selection** (cycling) — chrome-style box | `fg: white, bg: black` |
| `opencues-dim` | Dimmed words (alts not currently selected, agent-task context) | `dim: true` |
| `opencues-bold` | LLM-emitted `**bold**` after marker strip | `bold: true` |
| `opencues-italic` | LLM-emitted `*italic*` | `italic: true` |
| `opencues-code` | LLM-emitted `` `code` `` | `fg: warm amber RGBA(0.9, 0.7, 0.4)` |
| `opencues-strike` | LLM-emitted `~~strike~~` | `strikethrough: true` (falls back to `dim` if not supported) |
| `opencues-heading` | `# heading` lines | `bold: true, underline: true` |
| `opencues-list` | `- list` markers | `fg: muted grey RGBA(0.7, 0.7, 0.7)` |

**Why a black-bg selection instead of inverse?** OpenTUI doesn't emit raw ANSI inverse — its style API takes `fg` / `bg` as RGBA. A `bg: black` paint reads as a chrome-style selection box; ANSI inverse would invert whatever the editor's current bg is (often dark anyway, so the effect would be invisible on many themes). Bold is explicitly OFF on `opencues-highlight` — the white-on-black contrast is already strong; bold adds visual noise on long selected spans.

**To re-skin a style:** edit the `syntax.registerStyle(...)` call for the style ID. The change picks up on the next launch (no cache invalidation needed; the lazy register sees the new StyleDefinition).

**To kill a style entirely:** leave the runtime emitting the directive but skip the `desired.set(...)` line in `applyOpenCuesDirectives()` for that range type. The extmark just won't be created.

OpenTUI's `StyleDefinition` interface (in `@opentui/core/syntax-style.d.ts`) supports: `fg`, `bg`, `bold`, `italic`, `underline`, `dim`, `strikethrough`. No other style attributes are accepted — adding e.g. `blink: true` is silently dropped.

---

## Update workflow

```bash
cd ~/opencues && git pull
pnpm install
opencues install opencode     # rebuilds + redeploys into fork
opencues run opencode         # restart
```

`.md` config files (`CUES.md`, `BLANKS.md`, `cues/*`, `blanks/*`) hot-reload within ~2s on the next keystroke. Set `OPENCUES_HOME` to point at a non-default config root if you keep your configs separately from the repo.

---

## See also

- [`docs/architecture/repo-structure.md`](../../docs/architecture/repo-structure.md) — repo layout + stage tracker
- [`integrations/opencode/patches/opencuesBootstrap.ts`](patches/opencuesBootstrap.ts) — the actual bootstrap (read for what gets injected)
- [`@opencues/runtime` adapter band](../../packages/opencues-runtime/adapters/oc/v1.4/) — the OC v1.4 host adapter (what `boot()` resolves to)
