# OpenCues for OpenCode

`@opencues/opencode` — patches an [OpenCode](https://github.com/sst/opencode) TUI fork to add real-time word alternatives, blanks, and cue-controls inline in your prompts. Native rendering via the TUI's syntax-highlighting layer.

| Field | Value |
|---|---|
| Version | 0.1.0 |
| Compatible with | OpenCode 1.4.x (pinned to v1.4.11 / SHA `5e9d5c7`) |
| Source | `integrations/opencode/` |
| Runtime | `@opencues/core`, `@opencues/runtime` (installed into the fork's `node_modules/`) |

---

## Install

Requires: Node.js 18+, [pnpm](https://pnpm.io), [bun](https://bun.sh/).
From a fresh clone of the OpenCues repo:

```bash
pnpm install
opencues install opencode     # or: pnpm exec opencues install opencode
```

That's the whole install — one command, end to end. The installer will:

1. **Clone** `sst/opencode` at the pinned SHA into `~/opencode-cues/` (or reuse an existing clone at `--target <path>`)
2. **Install fork dependencies** via `bun install` so the fork's own deps (e.g. `@opentui/solid/preload`) land
3. **Build** `@opencues/core` + `@opencues/runtime` (turbo-cached)
4. **Install** the built artefacts into the fork at `node_modules/@opencues/{core,runtime}/`
5. **Patch** the fork in place: drops `opencues.ts` bootstrap + edits `app.tsx`, `component/prompt/index.tsx`, `feature-plugins/home/footer.tsx`

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
opencues run opencode         # or: pnpm exec opencues run opencode
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

This reverts the three patched TSX files via `git checkout --`, deletes the `opencues.ts` bootstrap, and removes `node_modules/@opencues/{core,runtime}/`. The fork itself (`~/opencode-cues/`) stays in place — it's your OpenCode checkout, not OpenCues's artefact. To remove it entirely:

```bash
rm -rf ~/opencode-cues
```

---

## Verify

| Test | What it checks |
|---|---|
| Type `5f`, position cursor on it, Up/Down | Numeric cycling: `5f → 5.5f → 6f` |
| Type `voice-mode active`, cycle Up | Selector/satellite via the `@opencues/runtime` settings control |
| Type `weather _ paris` | LLM/HTTP control: fills with current Paris weather |
| Status bar at bottom of TUI shows tip when a word is highlighted | `opencuesTip()` SolidJS signal wired into `home/footer.tsx` |

If something fails, the runtime writes diagnostics to `/tmp/opencues.log`.

---

## Configuration

OpenCues reads configs from **one or more `.opencues/` directories** in priority order:

| Source | Location | Purpose |
|---|---|---|
| `$OPENCUES_HOME` env var | wherever you set it | Top-priority override (CI / power users / dotfiles repo) |
| Project-level | `<cwd>/.opencues/` | Per-project overrides — cd into your project, those configs apply |
| User-level | `~/.opencues/` | Global defaults — apply everywhere unless overridden |

Project-level wins on name conflicts (cue source name, blank mode name, control name). Hot-reload polls every search path on every keystroke — edit any file, changes take effect within ~2s.

Each directory has the same shape:
```
.opencues/
├── cues.md          word sources + LLM prompts
├── blanks.md        blank-fill modes
├── controls.md      cue-control declarations
├── cues/            folder-based cue sources (one folder per source)
│   └── <name>/cue.md
└── controls/        folder-based control configs
    └── <name>/cue.md
```

`opencues.md` (voice-mode, tips-mode, debug-mode, cursor-navigate) is **system-wide**, runtime-owned, and lives only at user-level — the runtime auto-manages it.

**Seed `~/.opencues/` from the repo's defaults:**

```bash
opencues seed-configs        # user-level
opencues seed-configs --project   # from a project dir
```

Idempotent — copies any file that doesn't already exist at the destination.

---

## Where things live (blast radius)

| Path | Contents |
|---|---|
| `~/opencode-cues/` | Cloned OpenCode fork (~3 GB after `bun install`) |
| `~/opencode-cues/node_modules/@opencues/core/` | Built `@opencues/core` |
| `~/opencode-cues/node_modules/@opencues/runtime/` | Built `@opencues/runtime` |
| `~/opencode-cues/packages/opencode/src/cli/cmd/tui/opencues.ts` | OpenCues bootstrap (the `opencuesBootstrap.ts` source, copied in) |
| `~/opencode-cues/packages/opencode/src/cli/cmd/tui/app.tsx` | **Patched in place** — mounts the runtime + forwards keyboard events |
| `~/opencode-cues/packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` | **Patched in place** — publishes textarea ref + onContentChange handler |
| `~/opencode-cues/packages/opencode/src/cli/cmd/tui/feature-plugins/home/footer.tsx` | **Patched in place** — renders OpenCues tip alongside MCP status |
| `~/.opencues/` | User-level configs (see Configuration above) |
| `/tmp/opencues.log` | Runtime debug log (created on first launch) |
| `/tmp/opencues-install-oc.log` | Installer log from the most recent install |

`opencues which` prints every path with ✓ / − markers per existence.

---

## Update workflow

```bash
cd ~/opencues && git pull
pnpm install
opencues install opencode     # rebuilds + redeploys into fork
opencues run opencode         # restart
```

`.md` config files (`cues.md`, `blanks.md`, `controls.md`, `cues/*`, `controls/*`) hot-reload within ~2s on the next keystroke. Set `OPENCUES_HOME` to point at a non-default config root if you keep your configs separately from the repo.

---

## See also

- [`docs/architecture/repo-structure.md`](../../docs/architecture/repo-structure.md) — repo layout + stage tracker
- [`integrations/opencode/patches/opencuesBootstrap.ts`](patches/opencuesBootstrap.ts) — the actual bootstrap (read for what gets injected)
- [`@opencues/runtime` adapter band](../../packages/opencues-runtime/adapters/opencode/v1.4/) — the OC v1.4 host adapter (what `boot()` resolves to)
