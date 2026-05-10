# OpenCues for Gemini CLI

`@opencues/gemini-cli` — patches a [Gemini CLI](https://github.com/google-gemini/gemini-cli) fork to add real-time word alternatives, blanks, and cue-blanks inline in your prompts. Native rendering via Ink's `<Text>` component honouring inline ANSI escapes.

> **Shares user-level state with CC + OC**: `~/.cues/` (cue/blank configs) and `~/.cues/scripts/speak.sh` (TTS) are common across all native hosts. Brightness/volume cue-blanks, the opencues-settings selector/satellite, prompt-improver, stocks/weather/HackerNews blanks — all work identically on Gemini CLI because the runtime's `blanksRegistry` + spawn fallback are the same shape that CC and OC use. You can install Gemini CLI standalone (no CC or OC required) and TTS still works.

| Field | Value |
|---|---|
| Version | 0.1.0 |
| Compatible with | Gemini CLI 0.41.x (pinned to v0.41.2 / SHA `b0c7a17`) |
| Source | `integrations/gemini-cli/` |
| Runtime | `@opencues/core`, `@opencues/runtime` (installed into the fork's `node_modules/`) |

---

## Install

Requires: Node.js 18+, [pnpm](https://pnpm.io), npm (Gemini CLI's build tool).
From a fresh clone of the OpenCues repo:

```bash
pnpm install
opencues install gemini-cli       # or: pnpm exec opencues install gemini-cli
```

That's the whole install — one command, end to end. The installer will:

1. **Clone** `google-gemini/gemini-cli` at the pinned SHA into `~/gemini-cli-cues/` (or reuse an existing clone at `--target <path>`)
2. **Install fork dependencies** via `npm install` so the fork's own deps (Ink, React, etc.) land
3. **Build** `@opencues/core` + `@opencues/runtime` (turbo-cached)
4. **Install** the built artefacts into the fork at `node_modules/@opencues/{core,runtime}/`
5. **Patch** the fork in place: drops `opencues.ts` bootstrap + edits `AppContainer.tsx`, `components/InputPrompt.tsx`, `components/Footer.tsx`
6. **Build** the fork (`npm run build`) so the patched TS sources land in `packages/cli/dist/`

Re-runs are idempotent — unchanged patches skip, unchanged builds skip. First install is ~5 min (mostly `git clone` + `npm install` + initial build); re-runs are under 60s.

### Custom fork location

```bash
opencues install gemini-cli --target /path/to/your/gemini-cli-fork
```

### Verbose output

Set `OPENCUES_INSTALL_VERBOSE=1` to stream every command's output. By default the installer shows a six-line progress summary and logs everything else to `/tmp/opencues-install-gemini.log`.

---

## Run

```bash
opencues run gemini-cli           # or: pnpm exec opencues run gemini-cli
```

Launches `node packages/cli/dist/index.js` inside the patched fork. Watch `/tmp/opencues.log` in a second shell for the boot line:

```
[HH:MM:SS][info] OpenCues runtime starting (Gemini CLI v0.41)
```

---

## Uninstall

One command:

```bash
opencues uninstall gemini-cli
```

This reverts the three patched TSX/TS files via `git checkout --`, deletes the `opencues.ts` bootstrap, and removes `node_modules/@opencues/{core,runtime}/`. The fork itself (`~/gemini-cli-cues/`) stays in place — it's your Gemini CLI checkout, not OpenCues's artefact. To remove it entirely:

```bash
rm -rf ~/gemini-cli-cues
```

---

## Verify

| Test | What it checks |
|---|---|
| Type `5f`, position cursor on it, Up/Down | Numeric cycling: `5f → 5.5f → 6f` |
| Type `opencues settings _`, cycle Up | Selector/satellite via the `OpenCuesSettingsBlank` runtime class |
| Type `weather _ paris` | LLM/HTTP cue-blank: fills with current Paris weather |
| Footer at bottom of the TUI shows tip when a word is highlighted | `useOpenCuesTip()` React hook wired into `Footer.tsx` |
| Cued words appear dimmed; active word bright-white | Per-visual-line `decorateLine()` in `InputPrompt.tsx` |

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
├── cues.md          word sources + LLM prompts
├── blanks.md        cue-blank declarations
├── cues/            folder-based cue sources (one folder per source)
│   └── <name>/cue.md
└── blanks/          folder-based cue-blank configs
    └── <name>/cue.md
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
| `~/gemini-cli-cues/` | Cloned Gemini CLI fork (~1.5 GB after `npm install` + build) |
| `~/gemini-cli-cues/node_modules/@opencues/core/` | Built `@opencues/core` |
| `~/gemini-cli-cues/node_modules/@opencues/runtime/` | Built `@opencues/runtime` |
| `~/gemini-cli-cues/packages/cli/src/ui/opencues.ts` | OpenCues bootstrap (the `opencuesBootstrap.ts` source, copied in) |
| `~/gemini-cli-cues/packages/cli/src/ui/AppContainer.tsx` | **Patched in place** — mounts the runtime + subscribes to KeypressContext |
| `~/gemini-cli-cues/packages/cli/src/ui/components/InputPrompt.tsx` | **Patched in place** — publishes TextBuffer access + decorates per-visual-line rendering |
| `~/gemini-cli-cues/packages/cli/src/ui/components/Footer.tsx` | **Patched in place** — renders OpenCues tip alongside other footer indicators |
| `~/.cues/` | User-level configs (see Configuration above) |
| `/tmp/opencues.log` | Runtime debug log (created on first launch) |
| `/tmp/opencues-install-gemini.log` | Installer log from the most recent install |

`opencues which` prints every path with ✓ / − markers per existence.

---

## Update workflow

```bash
cd ~/opencues && git pull
pnpm install
opencues install gemini-cli       # rebuilds + redeploys + reapplies patches into fork
opencues run gemini-cli           # restart
```

`.md` config files (`cues.md`, `blanks.md`, `cues/*`, `blanks/*`) hot-reload within ~2s on the next keystroke. Set `OPENCUES_HOME` to point at a non-default config root if you keep your configs separately from the repo.

---

## See also

- [`docs/architecture/repo-structure.md`](../../docs/architecture/repo-structure.md) — repo layout + stage tracker
- [`integrations/gemini-cli/patches/opencuesBootstrap.ts`](patches/opencuesBootstrap.ts) — the actual bootstrap (read for what gets injected)
- [`@opencues/runtime` adapter band](../../packages/opencues-runtime/adapters/gemini/v0.41/) — the Gemini v0.41 host adapter (what `boot()` resolves to)
- [`reintegration/steps.md`](reintegration/steps.md) — phased re-integration plan + commit log
