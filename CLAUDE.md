# CLAUDE.md - OpenCues

This document provides context for Claude sessions working on this project.

## Project Overview

**OpenCues** provides LLM-powered word alternatives for text editors. The core library analyzes text and suggests alternatives (synonyms, opposites, completions) that users can cycle through.

**Architecture** (two libraries + integrations):
- **`@opencues/core`** — *what alternatives exist*. Pure TypeScript: parsers
  (cues.md / controls.md / opencues.md / blanks.md), the LLM `Resolver`,
  prompt templates, sources (ConfigSource, ControlBlankSource, etc.),
  HTTP adapter. Given text + config, answers "what should we suggest for
  this word?" Knows nothing about editors, key events, or rendering.
- **`@opencues/runtime`** — *how the user interacts with those alternatives*.
  Host-agnostic: the `HostAdapter` contract, Navigation / Cycling /
  DimRender / BlankFill modules, render-directive ANSI work, state
  classes, and per-host adapter bands (Claude Code v2.1, future browser,
  …). Knows nothing about LLMs. Will depend on `@opencues/core` from the
  BlankFill phase onward — modules will receive a `Resolver` instance.
- **Integrations** — Editor-specific glue. Claude Code's integration is
  the `tweakcc` patch that injects a thin bootstrap into `cli.js`; that
  bootstrap calls `@opencues/runtime`'s `boot()` entry point.

Roughly: `@opencues/core` is the brain, `@opencues/runtime` is the nervous
system, and each integration is a spinal-cord-shaped bridge between the
host and the runtime.


**Current Integrations**:
- **Claude Code** (`integrations/cc/`) — patches Claude Code 2.1.110+ via tweakcc
- **OpenCode** (`integrations/oc/`) — patches OpenCode 1.4.x; runtime loaded inline
- **Chrome** (`integrations/chrome/`) — MV3 extension; CSS Custom Highlight API for in-page rendering

> Re-org in progress — folders rename to `cc/`, `oc/`, `chrome/` in Stage 4 of
> the repo restructure. See `docs/architecture/repo-structure.md` for the
> target layout + stage tracker.

---

## Claude Installs

Two Claude Code installs exist on this machine. **OpenCues work targets `claude-cues` only — never touch the native install.**

| Command | Location | Version | Purpose |
|---|---|---|---|
| `claude-cues` | `~/local-claude-code` (local npm) | 2.1.110 (pegged) | OpenCues patches applied here |
| `claude` | `~/.local/bin/claude` (native) | 2.1.110 | Clean/unpatched — development use |

- `claude-cues` is the patched instance. All `setup.sh` runs and tweakcc patch applies target it.
- `claude` is never patched. Use it for unaffected Claude Code sessions during development.
- The version on `claude-cues` is pegged at **2.1.110** — do not upgrade it without verifying patch compatibility.

---

## Repository Structure

```
opencues/
├── CLAUDE.md                      # THIS FILE - project overview
├── README.md                      # Public readme with install instructions
│
├── .opencues/                     # Repo's OWN OpenCues config (project-level by convention)
│   ├── cues.md                    # OpenCues config (tips, prompts, ignore)
│   ├── blanks.md                  # Blank-fill modes (math, factual, grammar, etc.)
│   ├── controls.md                # Cue-controls (can be empty if using folders)
│   │                              # (opencues.md is user-level only — ~/.opencues/opencues.md)
│   ├── cues/                      # Folder-based word cue configs
│   │   ├── grammar/cue.md         # Base word alternatives
│   │   ├── legal/cue.md           # Legal terminology alternatives
│   │   ├── medical/cue.md         # Clinical terminology alternatives
│   │   └── financial/cue.md       # Financial terminology alternatives
│   └── controls/                  # Folder-based cue-controls (colocated scripts + state)
│       ├── volume/
│       │   ├── cue.md
│       │   ├── volume.sh          # Word-control script: up/down via key presses
│       │   ├── volume-blank.sh    # Blank-control script: get/set via Core Audio API
│       │   └── VolCtl.cs          # C# source for Windows Core Audio API (compiled by setup.sh)
│       ├── brightness/
│       │   ├── cue.md
│       │   └── brightness.sh
│       ├── numbers/cue.md         # Step control (stepSuffixes: f, step: 0.5)
│       ├── affirmations/cue.md    # List control
│       ├── stocks/cue.md          # impl: @opencues/runtime StocksControl
│       ├── weather/cue.md         # impl: @opencues/runtime WeatherControl
│       ├── hackernews/cue.md      # impl: @opencues/runtime HackerNewsControl
│       ├── prompt/cue.md          # impl: @opencues/runtime PromptImproverControl
│       ├── answer/cue.md          # impl: @opencues/runtime AnswerControl
│       └── opencues/cue.md        # impl: @opencues/runtime OpenCuesSettingsControl
│
├── packages/                      # Core packages (publish as @opencues/*)
│   ├── opencues-core/             # LLM analysis library — publishes as @opencues/core
│   │   ├── src/
│   │   │   ├── resolver.ts        # CueResolver orchestration
│   │   │   ├── cues-md.ts         # cues.md parser (parseCuesMd, parseSingleCueMd)
│   │   │   ├── discover.ts        # Folder-based config discovery
│   │   │   ├── node-http-adapter.ts  # HTTPS with keep-alive
│   │   │   └── sources/           # ConfigSource, ClassifiedSourceGroup, ControlBlankSource, parsers
│   │   ├── prompts/               # Prompt references + documentation
│   │   │   ├── linked.txt         # Linked words prompt
│   │   │   └── references/        # Prompt documentation
│   │   └── dist/                  # Built output
│   └── opencues-runtime/          # Host-agnostic runtime — publishes as @opencues/runtime
│       ├── src/                   # Modules: Navigation, Cycling, BlankFill, etc.
│       ├── adapters/              # Per-host adapter bands
│       │   ├── cc/v2.1/           # Claude Code 2.1.x adapter
│       │   ├── oc/v1.4/           # OpenCode 1.4.x adapter
│       │   └── chrome/v1/         # Chrome extension adapter
│       └── dist/                  # Built output
│
├── integrations/cc/      # Claude Code integration (@opencues/cc)
│   ├── patches/                   # tweakcc patches + installer
│   │   ├── setup.sh               # ONE-COMMAND INSTALLER
│   │   ├── cursorStateExport.ts   # Cursor position → JSON
│   │   ├── wordHighlight.ts       # Navigation, numbers, rendering, TTS
│   │   ├── dynamicHighlight.ts    # LLM integration, cycling, spans, TTS
│   │   ├── highlight-statusline.sh # Status line script
│   │   ├── claude-code-tips.json  # Per-word tips file
│   │   └── actions/               # Scripts (volume.sh, speak.sh, SpeakCtl.cs)
│   ├── docs/                      # Claude Code implementation docs
│   │   ├── navigation.md          # Keys, modes, visual states, cursor export
│   │   ├── cursor-positioning.md  # Cursor offset adjustment during blank fill
│   │   ├── cycling.md             # Numbers, alts, linked, spans, clearing
│   │   ├── alternatives.md        # Tips, LLM sources, blanks, auto-submit
│   │   ├── cue-controls.md         # Cue-controls + WSL guide
│   │   ├── selector-satellite.md  # Selector + satellite blank controls
│   │   ├── status-line.md         # Status line setup, format, disabling
│   │   ├── config.md              # All config options
│   │   ├── architecture.md        # Architecture + data flow diagrams
│   │   └── prompting-guide.md     # Claude Code CLI tips
│   └── tests/                     # Integration tests
│
├── docs/                          # General documentation
│   ├── overview.md                # System layers, API, interfaces, usage examples
│   ├── features/                  # One file per feature concept (20 features)
│   │   ├── README.md              # Feature index
│   │   ├── navigation.md          # Feature 1: Word navigation
│   │   ├── cycling.md             # Feature 2: Word cycling
│   │   ├── ...                    # Features 3-15 (one file each)
│   │   └── secondary-display.md   # Feature 14: Secondary display (status line)
│   ├── guides/                    # Task-oriented how-tos
│   │   ├── adding-a-feature.md    # How to add a new feature
│   │   ├── adding-an-integration.md # How to add a new editor integration
│   │   ├── adding-a-cue-control.md # How to add a cue-control (external script trigger)
│   │   ├── porting-to-new-integration.md # Porting guide: contracts, pitfalls, edge cases
│   │   ├── parser-types.md        # Response parser types (alternatives, compute, answer, raw)
│   │   └── llm-providers.md       # LLM provider setup & benchmarks
│   └── prompt-design-learnings.md # Prompt engineering principles
│
└── tests/                         # Benchmarks & test data
    ├── user-test.md               # Manual sanity checklist (run after code changes)
    ├── benchmarks/                # LLM accuracy benchmarks
    │   ├── prompt-improve.sh      # Prompt improver benchmark (99 cases, --category filter)
    │   └── ...                    # Word/blank/factual/math benchmarks
    └── results/                   # Benchmark results
```

---

## Quick Install (Claude Code)

```bash
git clone https://github.com/opencues/opencues ~/opencues
~/opencues/integrations/cc/patches/setup.sh
export GROQ_API_KEY="your-key"
```

The setup script:
1. Clones tweakcc from upstream into `integrations/cc/tweakcc/`
2. Copies + integrates patch files
3. Builds `@opencues/core` + `@opencues/runtime`, installs everything under `~/.claude/opencues/` (single dir; uninstall is `rm -rf`)
4. Applies patches to `claude-cues` (`~/local-claude-code`) — not the native `claude` install

**Recommended invocation** (the repo's `opencues` CLI wraps this):

```bash
pnpm exec opencues install claude-code
# or, if cli.js lives at a non-standard path:
pnpm exec opencues install claude-code --target ~/local-claude-code/node_modules/@anthropic-ai/claude-code/cli.js
```

The legacy `integrations/cc/patches/setup.sh` direct invocation still works for contributors hacking on the patches.

---

## Key References

- **README.md** — Features, install, configuration, troubleshooting
- **CONTRIBUTING.md** — How to extend the standard, build integrations, modify cues-core
- **docs/overview.md** — System architecture, core interfaces, API usage
- **docs/glossary.md** — All terminology (cues, blanks, sources, parsers, config files)
- **docs/guides/** — Task-oriented how-tos (adding features, integrations, cue-controls, parser types, LLM providers)
  - **`adding-a-cue-control.md`** ⚠️ Must-read before adding any new control — covers blank routing, cycling pitfalls (numeric vs list), span invalidation contract, and `def.word` post-populate behaviour. **Update the pitfalls section** when new failure modes are found.
  - **`creating-a-cue-type.md`** ⚠️ Must-read before implementing a new cue type — covers dedicated global vs `_dynDefs` decision, span cleanup (word-level invalidation pattern), `def.word` contract, and section E pitfalls. **Update section E** when new invalidation or cleanup patterns are discovered.
- **integrations/cc/docs/** — Claude Code implementation docs
  - **`tweakcc-setup.md`** — One-time tweakcc setup steps (patches to remove, cues block to comment out)
- **integrations/cc/tweakcc/** — tweakcc install (untracked, gitignored) — clone here on fresh setup
- **integrations/cc/reintegration/steps.md** — Progressive re-integration log (step status + what changed)
- **docs/features/** — 21 feature concepts (one file each)

---

## Build Commands

**Target:** `claude-cues` (`~/local-claude-code`) only. The native `claude` install is never touched.

After any change to a Claude Code patch source or to `@opencues/core` / `@opencues/runtime`, run:

```bash
integrations/cc/patches/setup.sh
```

The script:
1. Copies patch `.ts` files (`cursorStateExport.ts`, `wordHighlight.ts`, `dynamicHighlight.ts`, `opencuesRuntime.ts`) to tweakcc and rebuilds it (compiles patches into `dist/`)
2. Builds `@opencues/core` and copies to `~/.claude/opencues/core/`
3. Builds `@opencues/runtime` and rsyncs `dist/` to `~/.claude/opencues/runtime/`. Tips JSON, statusline script, and OS action scripts also go under `~/.claude/opencues/`. tweakcc's own config + `cli.js.backup` redirect there too via `TWEAKCC_CONFIG_DIR`. Single dir = clean uninstall.
4. Applies compiled patches to `claude-cues` (`~/local-claude-code`)

To re-apply patches without rebuilding (after a Claude Code version bump, no source changes):

```bash
cd integrations/cc/tweakcc
CLI_JS=$(find ~/local-claude-code -name "cli.js" | head -1)
TWEAKCC_CC_INSTALLATION_PATH="$CLI_JS" node dist/index.mjs --apply
```

> **Note:** `.md` config files (`cues.md`, `blanks.md`, `controls.md`, `cues/`, `controls/`) hot-reload within ~2 seconds on the next keystroke — no restart needed.

---

> **Important:** See `integrations/cc/docs/architecture.md` § "Development Notes" for critical patch development rules (e.g., never use bare `require()` in patch files).

---

## Environment

- **API Key**: `GROQ_API_KEY` for Groq (default provider)
- **API Key**: `FINNHUB_API_KEY` for Finnhub (stock prices)
- **Debug**: `DEBUG=cues*` for debug logging
- **Config**: `~/.tweakcc/config.json` for Claude Code settings

> **PRE-LAUNCH:** Rotate `GROQ_API_KEY` and `FINNHUB_API_KEY` before making the repo public. Keys are hardcoded in `integrations/chrome/.env` (gitignored) for dev convenience.

---

## Config search paths — project-level + user-level

ConfigLoader reads `.md` configs and `cues/*` / `controls/*` folders from a
**search path list**, in priority order. Earlier entries win on name conflicts
(cue source name, blank mode name, control name).

Default chain (CC + OC adapters):

```
$OPENCUES_HOME           ← env override (top priority; for CI / power users)
<cwd>/.opencues          ← project-level (cd into your project)
~/.opencues              ← user-level (global defaults)
```

The convention mirrors `.editorconfig` / `.npmrc` / `.claude/skills/` — opaque
host-neutral dir at the project root. Missing dirs are silently skipped; the
runtime degrades gracefully.

A user with no `.opencues/` anywhere gets bake-time defaults (chrome) or
empty config (CC/OC) — not a crash. Hot-reload polls every search path on
every keystroke (same `maybeReload` mechanism as before).

The OpenCuesSettingsControl read/write of `opencues.md` is a special
case: it is user-level only. `opencues.md` holds system-wide settings
(voice-mode, tips-mode, debug-mode, cursor-navigate) whose schema is
owned by the OpenCues runtime. A single value applies across every
integration, so projects cannot override it. The file lives at
`~/.opencues/opencues.md` (or `$OPENCUES_HOME/opencues.md` when set)
and is auto-created on first write.

- `opencues init` does NOT scaffold `opencues.md` — neither at
  project nor user level.
- `opencues seed-configs` (no flag) copies it to `~/.opencues/`;
  `seed-configs --project` skips it.
- `ConfigLoader._loadOnce` reads it only from the last search path
  (the user-level entry).

---

## Hoisted-control writes vs ConfigLoader hot-reload

Selector/satellite cycling (e.g. `opencues settings` flipping
`voice-mode: active ↔ inactive`) goes through this sequence:

1. `Cycling.cycleSelectorSatellite` → `applyOpenCuesScalar(key, value)` —
   updates `opencuesState` in-memory **synchronously**.
2. `controlInvoke({action: 'set', args: [setting, value]})` — kicks off
   the host's **async** file/storage write. Chrome: `chrome.storage.local.set`.
   OpenCode: `fs.writeFile`.
3. `setText(newText)` fires the host's text-change pipeline →
   `ConfigLoader.maybeReload`.

**Race**: step 3's reload can fire *before* step 2's async write lands.
The reload reads the still-stale file, parses the old `opencuesState`,
and overwrites the in-memory update from step 1.

**Fix pattern** (already wired in `config-loader.ts`):
`applyOpenCuesScalar` arms `_suppressReloadUntil = Date.now() + 2500`.
`maybeReload` short-circuits while inside that window. 2.5s is plenty for
either host's async write to complete; after that the normal hot-reload
debounce takes over.

If you add a new code path that mutates a scalar *and* writes via
`controlInvoke` (or any async write), reuse `applyOpenCuesScalar` so the
suppression fires automatically. Tests pinning the contract live in
`config-loader.test.ts` — `applyOpenCuesScalar suppresses the next
maybeReload (write-race guard)` and the resume-after-window companion.

---

## Chrome Extension — Dev Workflow

Chrome runs on Windows; this repo lives in WSL2. The unpacked extension Chrome
loads from is on the Windows desktop, **not** the WSL build dir:

- **Build (WSL)**: `/home/wilfred/opencues/integrations/chrome/`
- **Loaded by Chrome (Windows)**: `/mnt/c/Users/wilfred/Desktop/opencues-chrome-extension/`

After every `npm run build`, sync the fresh artefacts to the Windows path or
Chrome will keep running the stale bundle (no errors, just no new behaviour):

```bash
cp -r integrations/chrome/dist/* /mnt/c/Users/wilfred/Desktop/opencues-chrome-extension/dist/
cp integrations/chrome/manifest.json /mnt/c/Users/wilfred/Desktop/opencues-chrome-extension/manifest.json
```

Then reload the extension at `chrome://extensions` and hard-refresh the page.

> Symptom that this step was skipped: `[opencues][info] OpenCues runtime starting (Chrome v1)` is missing from devtools console while legacy `[OpenCues] ...` lines still fire.

---

## Testing Harness (private)

<!-- PRE-LAUNCH: This entire section and all references to opencues-auto MUST be removed
     from this file AND scrubbed from git history before the repo goes public.
     Use: git filter-repo --path-glob '*/CLAUDE.md' --replace-text <(echo 'opencues-auto==>REDACTED') -->

A separate private repo (`~/.claude/opencues-auto/`) provides automated integration testing for the Claude Code integration. It is **not** part of the public opencues repo.

**What it does:**
- Injects text into a running Claude Code instance via file-based IPC
- Moves the cursor, cycles alternatives, and reads highlight state — all programmatically
- Runs test suites that verify cues, blanks, controls, cycling, transitions, and cursor-navigate

**When to use it:**
- After modifying `wordHighlight.ts` or `dynamicHighlight.ts` — run the test suites to catch regressions
- After adding a new feature — write tests in opencues-auto to cover it
- After `setup.sh` — re-run `install-harness.sh` then restart Claude Code before testing

**Setup:** `~/.claude/opencues-auto/claude-code/testing/install-harness.sh` (after `setup.sh`)

**Test suites:**
- `test-cues.sh` — core: alts, tips, controls, blanks (14 tests)
- `test-cues-transitions.sh` — state isolation between injects (7 tests)
- `test-cues-cycling.sh` — Up/Down cycling (9 tests)
- `test-cursor-navigate.sh` — cursor-navigate feature (15 tests)

See `~/.claude/opencues-auto/CLAUDE.md` for full documentation.

---

*Last updated: April 2026*
