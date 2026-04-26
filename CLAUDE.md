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
- **Claude Code** (`integrations/claude-code/`) — patches Claude Code 2.1.110+ via tweakcc
- **OpenCode** (`integrations/opencode/`) — patches OpenCode 1.4.x; runtime loaded inline
- **Chrome** (`integrations/chrome/`) — MV3 extension; CSS Custom Highlight API for in-page rendering

> Re-org in progress — folders rename to `cc/`, `oc/`, `chrome/` in Stage 4 of
> the repo restructure. See `docs/architecture/repo-structure.md` for the
> target layout + stage tracker.

---

## Claude Installs

Two Claude Code installs exist on this machine. **OpenCues work targets `claude-cues` only — never touch the native install.**

| Command | Location | Version | Purpose |
|---|---|---|---|
| `claude-cues` | `~/claude-code-cues` (local npm) | 2.1.110 (pegged) | OpenCues patches applied here |
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
├── defaults/                      # Shipped defaults — seed source for `opencues seed-configs`
│   │                              # AND the Chrome extension's bake-time bundled fallbacks.
│   │                              # NOT an ambient project-level config — the repo does not
│   │                              # self-dogfood via `<cwd>/.opencues` anymore. Devs working
│   │                              # on opencues run `seed-configs` once just like any user.
│   │                              # See docs/features/shipped-defaults.md.
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
├── integrations/claude-code/      # Claude Code integration (@opencues/claude-code)
│   ├── patches/                   # tweakcc patches + installer
│   │   ├── setup.sh               # ONE-COMMAND INSTALLER
│   │   ├── cursorStateExport.ts   # Cursor position → JSON
│   │   ├── wordHighlight.ts       # Navigation, numbers, rendering, TTS
│   │   ├── dynamicHighlight.ts    # LLM integration, cycling, spans, TTS
│   │   ├── highlight-statusline.sh # Status line script
│   │   └── actions/               # OS-bound scripts (speak.sh, brightness.sh, *.cs);
│   │                              # copied into <CC_FORK>/.opencues/scripts/ at install time
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
cd ~/opencues && pnpm install
pnpm exec opencues install claude-code
export GROQ_API_KEY="your-key"
```

`opencues install claude-code` chains two scripts:

1. **`opencues seed-configs --silent`** — owns all writes to `~/.opencues/`
   (shared by every native host: CC, OC, Codex). First-time copy +
   library-script sync + 0-byte opencues.md self-heal + colocated `.cs`
   compile (WSL only).
2. **`integrations/claude-code/patches/setup.sh`** — strictly CC-specific.
   Default behavior: nuke + rebuild from scratch. Pinned `@anthropic-ai/claude-code@2.1.110`
   reinstalled + cloned tweakcc inside `<CC_FORK>/.opencues/tweakcc/` +
   `@opencues/{core,runtime}` built and installed into `<CC_FORK>/node_modules/@opencues/`
   + statusline.sh into `<CC_FORK>/.opencues/` + tweakcc patched (only
   the OpenCues v2 wiring; every stock tweakcc patch disabled) +
   verified at build AND apply time. ~1m 5s warm install.

**Compact footprint**: everything CC-specific lives inside `~/claude-code-cues/`.
Uninstall is `rm -rf ~/claude-code-cues` + tweakcc revert. OpenCode + Codex
keep working (they read shared `~/.opencues/` independently).

For non-standard cli.js paths: `--target /path/to/cli.js`.
For dev iteration on patch sources: `--keep-state` (skips nuke; ~39s).

The legacy `integrations/claude-code/patches/setup.sh` direct invocation still
works for contributors hacking on the patches (also accepts `--keep-state`).

---

## Key References

- **README.md** — Features, install, configuration, troubleshooting
- **CONTRIBUTING.md** — How to extend the standard, build integrations, modify opencues-core
- **docs/overview.md** — System architecture, core interfaces, API usage
- **docs/glossary.md** — All terminology (cues, blanks, sources, parsers, config files)
- **docs/guides/** — Task-oriented how-tos (adding features, integrations, cue-controls, parser types, LLM providers)
  - **`adding-a-cue-control.md`** ⚠️ Must-read before adding any new control — covers blank routing, cycling pitfalls (numeric vs list), span invalidation contract, and `def.word` post-populate behaviour. **Update the pitfalls section** when new failure modes are found.
  - **`creating-a-cue-type.md`** ⚠️ Must-read before implementing a new cue type — covers dedicated global vs `_dynDefs` decision, span cleanup (word-level invalidation pattern), `def.word` contract, and section E pitfalls. **Update section E** when new invalidation or cleanup patterns are discovered.
- **integrations/claude-code/docs/** — Claude Code implementation docs
  - **`tweakcc-setup.md`** — One-time tweakcc setup steps (patches to remove, cues block to comment out)
- **`<CC_FORK>/.opencues/tweakcc/`** — tweakcc install lives inside the CC fork (re-cloned every from-scratch install — no global `~/tweakcc/` dir to manage)
- **integrations/claude-code/reintegration/steps.md** — Progressive re-integration log (step status + what changed)
- **docs/features/** — 21+ feature concepts (one file each)
- **docs/architecture/spans-and-cycling.md** ⚠️ Canonical implementation reference for the cycling/span/dim/nav system. Two span systems (blank-fill vs static-alt), seven cycling paths, the shift+prune flow, the bugs we've already fixed. Read this before touching `cycling.ts`, `dyn-defs.ts`, `span-fill.ts`, `dim-render.ts`, or `navigation.ts`.

---

## Build Commands

**Target:** `claude-cues` (`~/claude-code-cues`) only. The native `claude` install is never touched.

After any change to a Claude Code patch source or to `@opencues/core` / `@opencues/runtime`, run:

```bash
integrations/claude-code/patches/setup.sh
```

The script:
1. Copies patch `.ts` files (`cursorStateExport.ts`, `wordHighlight.ts`, `dynamicHighlight.ts`, `opencuesRuntime.ts`) to tweakcc and rebuilds it (compiles patches into `dist/`)
2. Builds `@opencues/core` and copies to `<CC_FORK>/node_modules/@opencues/core/` (so cli.js's bare-specifier `require("@opencues/core")` resolves via Node's standard upward walk — no symlinks)
3. Builds `@opencues/runtime` and rsyncs `dist/` to `<CC_FORK>/node_modules/@opencues/runtime/`. Statusline script + OS action scripts go under `<CC_FORK>/.opencues/{statusline.sh,scripts/}`. tweakcc's own config + `cli.js.backup` redirect to `<CC_FORK>/.opencues/patch-state/` via `TWEAKCC_CONFIG_DIR`. **Compact footprint**: everything (runtime, support files, patcher state, patched cli.js) lives inside `~/claude-code-cues/`. Uninstall is `rm -rf ~/claude-code-cues` + tweakcc revert (mirrors OpenCode).
4. Applies compiled patches to `claude-cues` (`~/claude-code-cues`)

To re-apply patches without rebuilding (after a Claude Code version bump, no source changes):

```bash
cd integrations/claude-code/tweakcc
CLI_JS=$(find ~/claude-code-cues -name "cli.js" | head -1)
TWEAKCC_CC_INSTALLATION_PATH="$CLI_JS" node dist/index.mjs --apply
```

> **Note:** `.md` config files (`cues.md`, `blanks.md`, `controls.md`, `cues/`, `controls/`) hot-reload within ~2 seconds on the next keystroke — no restart needed.

---

> **Important:** See `integrations/claude-code/docs/architecture.md` § "Development Notes" for critical patch development rules (e.g., never use bare `require()` in patch files).

---

## Pre-launch cleanup

`CLEANUP.md` (repo root) tracks scaffolding that needs removing before
launch — test fixtures embedded in shipped configs, dead code paths
left over from the option B refactor, dated "April 2026" commentary in
code comments, doc tidy-ups, and test consolidation. Walk the list
once Chrome + OpenCode are fully verified on phases 1–6, before
extending verification to Claude Code + Codex. The file is
self-deleting: `git rm CLEANUP.md` once everything inside is done.

`CODEX-CHECKLIST.md` (repo root) is the parallel tracker for the
codex integration's path from pre-alpha scaffolding to OpenCode
parity. 7 tiers ordered easy → hard, with severities + file
citations. Tiers 1–2 are done; Tier 3 onward (daemon module wiring,
Rust bridge fixes, TUI patches, verification) is the remaining
work. Self-deleting once codex hits beta.

---

## Testing — write the SCENARIO that triggered the bug

The runtime has 400+ tests. Most are unit tests, which are good at
pinning module behaviour but **structurally bad at catching the bug
class we keep hitting**: state inconsistencies across multiple modules
during multi-step user journeys (cycle → cycle → type → cycle, two
spans active, dim flicker between cycles, etc.).

**Rule:** when fixing a bug, write the SCENARIO (multi-step user
journey) that triggered it, not just a unit-level repro of the
broken function.

The right shape:
```ts
it('cycle → cycle → type → cycle preserves downstream defs', async () => {
  const { adapter, hlState, dynDefs } = await setupScenario('the attorney filed today');
  hlState.activate(1, ...);
  adapter.fireKey('up', { ctrl: true, alt: true });
  expect(adapter.setTextCalls.at(-1)).toBe('the lawyer filed today');
  adapter.fireKey('up', { ctrl: true, alt: true });
  expect(adapter.setTextCalls.at(-1)).toBe('the legal eagle filed today');
  expect(dynDefs.findSpanContaining(1)?.spanLength).toBe(2);
  // ... continue the user journey, asserting at every step
});
```

The wrong shape (what we'd write reflexively):
```ts
it('applyAltCycle handles multi-word alt', () => {
  const def = makeDef(...);
  applyAltCycle(event, def, +1, 1);
  expect(def.spanEnd).toBe(...);  // unit-level — misses every interaction
});
```

Where to put scenario tests:
- `packages/opencues-runtime/src/modules/cycling.scenarios.test.ts` — the
  canonical place for cycling/span/dim/nav journeys. 30+ tests cover
  the well-traveled paths; add to the relevant describe block.
- New domains get their own `<feature>.scenarios.test.ts` file.

Why this matters: the April 2026 bug arc had 8+ regressions caught
only after the user reported them. Each was a state inconsistency
across modules during a multi-step interaction. Unit tests covered
each module in isolation but missed the journey. The scenarios file
+ the pattern above is the structural fix.

See `docs/architecture/spans-and-cycling.md` § "Bugs we've fixed" for
the table of regressions and which scenario test now pins each one.

---

## Environment

- **API Key**: `GROQ_API_KEY` for Groq (default provider)
- **API Key**: `FINNHUB_API_KEY` for Finnhub (stock prices)
- **Debug**: `DEBUG=cues*` for debug logging
- **Config**: `~/.tweakcc/config.json` for Claude Code settings

> **PRE-LAUNCH:** Rotate `GROQ_API_KEY` and `FINNHUB_API_KEY` before making the repo public. Keys are hardcoded in `integrations/chrome/.env` (gitignored) for dev convenience.

> **PRE-LAUNCH (security):** the Chrome extension currently inlines
> `__GROQ_API_KEY__` from `.env` at esbuild time into `dist/content.js`
> (see `integrations/chrome/src/types.ts:42` and the esbuild config).
> That means anyone who installs the unpacked extension can grep the
> API key out of the JS bundle. **Fix before publishing**: drop the
> build-time inline; load the key from `chrome.storage.local`, set via
> a popup field. Removes the need for `.env` entirely. Tracked here
> because `opencues doctor` doesn't surface this.

---

## Config search paths — who reads what

Native hosts (CC / OC / codex) read the filesystem directly. Chrome
can't — it runs in the browser — so it reads a pre-built bundle. The
two paths behave differently:

| Host | Sources at runtime | How project configs get in |
|---|---|---|
| **claude-code** | `$OPENCUES_HOME` → `<cwd>/.opencues/` → `~/.opencues/` | Automatic (cwd-based merge) |
| **opencode** | same | same |
| **codex** | same | same |
| **chrome** | `<extension>/dist/configs/` (sync'd) + bake-time defaults from `<repo>/defaults/` | Explicit — `opencues sync chrome [--include <path>]` |

For the native hosts, project wins on name conflicts. Missing dirs are
silently skipped; the runtime degrades gracefully. Hot-reload polls
every search path on every keystroke.

Chrome has NO runtime filesystem access, so its "search path" is
whatever `sync chrome` wrote last. By default that's `~/.opencues/`
only — project dirs are opted in explicitly (see
`docs/features/chrome-sync.md`). The extension also carries bake-time
defaults inlined from `<repo>/defaults/` at esbuild time, so a user
who installs but never syncs still gets grammar/legal/medical etc.
(see `docs/features/shipped-defaults.md`).

### ConfigLoader search-path detail (native hosts)

```
$OPENCUES_HOME           ← env override (top priority; for CI / power users)
<cwd>/.opencues          ← project-level (cd into your project)
~/.opencues              ← user-level (global defaults)
```

The convention mirrors `.editorconfig` / `.npmrc` / `.claude/skills/` — opaque
host-neutral dir at the project root. Missing dirs are silently skipped; the
runtime degrades gracefully.

A user with no `.opencues/` anywhere gets empty config (CC/OC/codex)
— not a crash. Hot-reload polls every search path on every keystroke
(same `maybeReload` mechanism as before).

The OpenCuesSettingsControl read/write of `opencues.md` is a special
case: it is user-level only. `opencues.md` holds system-wide settings
(voice-mode, tips-mode, debug-mode, cursor-navigate) whose schema is
owned by the OpenCues runtime. A single value applies across every
integration, so projects cannot override it. The file lives at
`~/.opencues/opencues.md` (or `$OPENCUES_HOME/opencues.md` when set).

- `opencues init` does NOT scaffold `opencues.md` — neither at
  project nor user level.
- `opencues seed-configs` (no flag) copies it from `defaults/opencues.md`
  to `~/.opencues/`; `seed-configs --project` skips it.
- **A 0-byte `opencues.md` is treated as missing** by both `seed-configs`
  AND `setup.sh` (section 7a-bis self-heal). The `OpenCuesSettingsControl`
  silently no-ops on null/empty content (correct behavior for "no file
  exists"), so an empty seed used to silently break `opencues ___` /
  `config ___` blank-fills on every native host. Chrome was unaffected
  because its storage adapter falls back to the bake-time
  `__DEFAULT_OPENCUES_MD__` constant. Both the seed-configs check and
  the setup.sh self-heal now ensure `opencues.md` is always non-empty
  on disk.
- `ConfigLoader._loadOnce` reads it only from the last search path
  (the user-level entry).

---

## Host compatibility — which integrations a cue/control runs on

Every cue / blank / control has an implicit (or explicit) host-compat
list: which of `{chrome, claude-code, codex, opencode}` it works on.
Native hosts (CC, OC, codex) can spawn subprocesses + read the
filesystem; chrome can't.

Default: auto-detected from `script:` / `blankScript:` extension.
`.sh .bash .ps1 .bat .cmd .exe .py .rb .pl` → not chrome. Everything
else → all hosts.

Override via frontmatter:

```yaml
on-host: [chrome, claude-code, codex, opencode]   # allow-list
not-on-host: [chrome]                              # deny-list
```

Resolution: `on-host` (if set) wins over auto-detect, then `not-on-host`
filters. Surfaced by `opencues list` (per-entry marker), validated by
`opencues validate` (typos + contradictions), used by the upcoming
`opencues sync chrome`.

Full spec: `docs/features/host-compat.md`. Glossary entry:
`docs/glossary.md § Host Compat`. API: `@opencues/core`'s
`inferHostCompat()`, `formatHostList()`, `unknownHostNames()`,
`HOSTS`, `NATIVE_HOSTS`.

Real-world example: `.opencues/controls/opencues/cue.md` has
`blankScript: ./opencues-blank.sh` (native fallback) AND a
runtime-class implementation in `@opencues/runtime`. Auto-detect
would exclude chrome because of the `.sh`; the file adds
`on-host: chrome, claude-code, codex, opencode` to override. The
validator warns about the contradiction (on-host + .sh), which is
the expected nudge for readers to check.

---

## Word-alt routing — DEFAULT vs DOMAIN sources

Every `### alternatives` section in `cues.md` (or `cues/<name>/cue.md`)
becomes one `ConfigSource`. `buildSourcesFromConfig` wraps the whole
set in ONE `RoutedWordSourceGroup` that dispatches each highlighted
word to exactly one child source — never combines them into a giant
prompt.

Classification per source (frontmatter):

```
match: <regex> OR keywords: <list>     → DOMAIN  (only fires for matches)
neither match: nor keywords:           → DEFAULT (catches everything else)
```

Routing per word: highest-priority domain whose match/keyword hits the
word wins; otherwise highest-priority default; otherwise no cue (word
isn't navigable). Words destined for the same source are batched into
one parallel LLM call, then results are index-remapped back to the
original positions.

Why per-word dispatch (not the old "combine into one prompt"):
- **Isolation**: a hijacking prompt in one source can no longer poison
  every word. Sync-demo's "always output bundled,deployed,shipped"
  used to swap `happy → bundled`. With routing, that prompt only
  affects words its source is called for.
- **Symmetry**: blanks already use a `ClassifiedSourceGroup`; word-alts
  follow the same model now.

Surfaces that enforce + surface this:
- `@opencues/core` `RoutedWordSourceGroup` — runtime routing class
- `cues.md` / `new/cue.md` templates — teach the distinction at scaffold time
- `opencues list` — marks each source `domain` / `default`
- `opencues validate` — warns on zero defaults + multi-default priority ties

Full spec: `docs/features/word-alt-routing.md`. Glossary entries:
`docs/glossary.md § RoutedWordSourceGroup, Default Cue Source, Domain Cue Source`.

> **Don't** introduce code paths that rebuild the merged-prompt model
> (e.g. concatenating multiple `### alternatives` bodies into one
> `ConfigSource`). The `combineWordSources` export in
> `build-sources.ts` is a no-op shim kept only for external callers
> mid-migration; new code should not call it.

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

### `opencues sync chrome` source discovery

Chrome is a global browser extension — it runs across every tab, has
no cwd, and isn't scoped to any single project. So `sync chrome`
deliberately breaks from the user+project search-paths model the
native hosts use (see above). By default, **only `~/.opencues/`
feeds into the chrome bundle.** The cwd you happen to run sync from
does NOT get mixed in.

To bundle project configs, opt them in explicitly:

```bash
opencues sync chrome --wsl                              # user-level only (default)
opencues sync chrome --include ~/work/proj/.opencues --wsl    # + one project
opencues sync chrome --include ~/a/.opencues --include ~/b/.opencues --wsl  # + several
opencues sync chrome --project --wsl                    # + <cwd>/.opencues
opencues sync chrome --pack demo-pack --wsl             # ONLY that pack
opencues sync chrome --source ~/custom/.opencues --wsl  # ONLY that dir
```

Why this matters — `sync chrome --watch` is a long-running process.
Under the old cwd-default model, starting the watcher from `~/scratch`
would bind it to `~/scratch/.opencues` forever, silently missing edits
in the project the user actually cares about. The explicit
`--include` / `--project` model makes the watched paths part of the
command, not a side-effect of startup cwd.

Rule of thumb: if you're iterating on configs *inside this repo*, use

```bash
opencues sync chrome --include ~/opencues/.opencues --wsl --watch
```

so the watcher's path list is stable regardless of shell cwd.

Full spec: `docs/features/chrome-sync.md`.

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
