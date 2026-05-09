# CLAUDE.md - OpenCues

This document provides context for Claude sessions working on this project.

## Project Overview

**OpenCues** provides LLM-powered word alternatives and `_`-gated blank fill-ins for text editors. The system reduces to two ideas: **Cues** (LLM → user, on plain text) and **Blanks** (user → system, on `_`). See `concept.md` at the repo root.

**Architecture** (two libraries + integrations):
- **`@opencues/core`** — *what alternatives exist*. Pure TypeScript: parsers
  (cues.md frontmatter + folder cue.md / blank.md), the LLM `Resolver`,
  prompt templates, sources (ConfigSource, BlankSource, etc.),
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
│   │                              # self-dogfood via `<cwd>/.cues` anymore. Devs working
│   │                              # on opencues run `seed-configs` once just like any user.
│   │                              # See docs/features/shipped-defaults.md.
│   ├── CUES.md                    # Master config: settings frontmatter + ignore: array + project metadata
│   ├── cues/                      # Folder-based cue configs (LLM word-cues + static tip groups)
│   │   ├── extended-thinking/CUE.md  # type: tips, words: { ultrathink: { tip, alts } }
│   │   ├── …                      # 38 shipped tip-group folders
│   │   ├── legal/CUE.md           # Legal terminology word-cues (LLM)
│   │   ├── medical/CUE.md         # Clinical terminology word-cues
│   │   └── financial/CUE.md       # Financial terminology word-cues
│   └── blanks/                    # Folder-based cue-blanks (colocated scripts + state)
│       ├── volume/
│       │   ├── BLANK.md           # type: blank, blankKeywords: volume, …
│       │   ├── volume-blank.sh    # Blank script: get/set system volume
│       │   └── VolCtl.cs          # C# source for Windows Core Audio API (compiled by setup.sh)
│       ├── brightness/
│       │   ├── BLANK.md
│       │   └── brightness-blank.sh
│       ├── affirmations.md        # List blank (stepValues: [...])
│       ├── stocks.md              # impl: @opencues/runtime StocksBlank
│       ├── weather.md             # impl: @opencues/runtime WeatherBlank
│       ├── hackernews.md          # impl: @opencues/runtime HackerNewsBlank
│       ├── prompt.md              # impl: @opencues/runtime PromptImproverBlank
│       ├── answer.md              # impl: @opencues/runtime AnswerBlank
│       ├── countries.md           # impl: @opencues/runtime CountriesBlank
│       ├── crypto.md              # impl: @opencues/runtime CryptoBlank
│       ├── dictionary.md          # impl: @opencues/runtime DictionaryBlank
│       └── opencues/BLANK.md      # impl: @opencues/runtime OpenCuesSettingsBlank
│
├── packages/                      # Core packages (publish as @opencues/*)
│   ├── opencues-core/             # LLM analysis library — publishes as @opencues/core
│   │   ├── src/
│   │   │   ├── resolver.ts        # CueResolver orchestration
│   │   │   ├── cues-md.ts         # cues.md parser (parseCuesMd, parseSingleCueMd)
│   │   │   ├── discover.ts        # Folder-based config discovery
│   │   │   ├── node-http-adapter.ts  # HTTPS with keep-alive
│   │   │   └── sources/           # ConfigSource, RoutedWordSourceGroup, BlankSource, FluidBlankSource, SpellingSource, parsers
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
│   │   ├── opencuesRuntime.ts     # The patch source — boots @opencues/runtime via S1/S3/S6 seams
│   │   └── highlight-statusline.sh # Status line script
│   ├── docs/                      # Claude Code implementation docs
│   │   ├── navigation.md          # Keys, modes, visual states, cursor export
│   │   ├── cursor-positioning.md  # Cursor offset adjustment during blank fill
│   │   ├── cycling.md             # Numbers, alts, linked, spans, clearing
│   │   ├── alternatives.md        # Tips, LLM sources, blanks, auto-submit
│   │   ├── cue-blanks.md         # Cue-blanks + WSL guide
│   │   ├── selector-satellite.md  # Selector + satellite blanks
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
│   │   ├── adding-a-cue-blank.md # How to add a cue-blank (external script trigger)
│   │   ├── adding-an-auditor.md  # How to add an auditor (inline-rewrite concern)
│   │   ├── porting-to-new-integration.md # Porting guide: contracts, pitfalls, edge cases
│   │   ├── parser-types.md        # Response parser types (alternatives, compute, answer, raw)
│   │   └── llm-providers.md       # LLM provider setup & benchmarks
│   └── prompt-design-learnings.md # Prompt engineering principles
│
└── tests/                         # End-to-end + benchmark scaffolding
    ├── user-test.md               # Manual sanity checklist (run after code changes)
    ├── agentic/                   # Agentic test harness (`oc-launch-headless`,
    │                              #   `oc-inject`, `oc-events`, scenario-runner.ts)
    ├── benchmarks/                # LLM accuracy benchmarks (TS runners per pipeline)
    │   ├── agent-rewrite/         # AgentRewrite cadence + merge
    │   ├── transform-blank/       # 3-pass imperative pipeline
    │   └── fluid-blank/           # Free-form `_` lookup
    └── results/                   # Benchmark results + reports
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

1. **`opencues seed-configs --silent`** — owns all writes to `~/.cues/`
   (shared by every native host: CC, OC). First-time copy +
   library-script sync + 0-byte cues.md self-heal + colocated `.cs`
   compile (WSL only).
2. **`integrations/claude-code/patches/setup.sh`** — strictly CC-specific.
   Default behavior: nuke + rebuild from scratch. Pinned `@anthropic-ai/claude-code@2.1.110`
   reinstalled + cloned tweakcc inside `<CC_FORK>/.opencues/tweakcc/` +
   `@opencues/{core,runtime}` built and installed into `<CC_FORK>/node_modules/@opencues/`
   + statusline.sh into `<CC_FORK>/.opencues/` + tweakcc patched (only
   the OpenCues v2 wiring; every stock tweakcc patch disabled) +
   verified at build AND apply time. ~1m 5s warm install.

**Compact footprint**: everything CC-specific lives inside `~/claude-code-cues/`.
Uninstall is `rm -rf ~/claude-code-cues` + tweakcc revert. OpenCode
keeps working (it reads shared `~/.cues/` independently).

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
- **docs/guides/** — Task-oriented how-tos (adding features, integrations, cue-blanks, auditors, parser types, LLM providers)
  - **`adding-a-cue-blank.md`** ⚠️ Must-read before adding any new cue-blank — covers blank routing, cycling pitfalls (list-only — no numeric stepping), span invalidation contract, and `def.word` post-populate behaviour. **Update the pitfalls section** when new failure modes are found.
  - **`adding-an-auditor.md`** Reference for shipping a new inline-rewrite concern (grammar, clarity, tone, etc.). Explains the composition model (one LLM call per agent tick, all auditors concatenated by priority desc), what the frontmatter does, why per-auditor `provider:` / `match:` are inert, and `<project>/.cues/AUDITORS.md` `disable:` for project-level scoping.
- **integrations/claude-code/docs/** — Claude Code implementation docs
- **`<CC_FORK>/.opencues/tweakcc/`** — tweakcc install lives inside the CC fork (re-cloned every from-scratch install — no global `~/tweakcc/` dir to manage)
- **docs/features/** — 21+ feature concepts (one file each)
- **docs/architecture/spans-and-cycling.md** ⚠️ Canonical implementation reference for the cycling/span/dim/nav system. Two span systems (blank-fill vs static-alt), the cycling priority order (selector/satellite → spanFill → list blank → blankStep DynDef → static alts), the shift+prune flow, the bugs we've already fixed. Read this before touching `cycling.ts`, `dyn-defs.ts`, `span-fill.ts`, `dim-render.ts`, or `navigation.ts`.
- **docs/architecture/transform-blank.md** ⚠️ Canonical reference for the imperative-blank pipeline (EXTRACT → APPLY → VERIFY). Covers the 3-pass design rationale, prompt design (why minimal-EXTRACT but verbose-APPLY), sequential composition for "X and Y", skip-VERIFY rules, parser quirks (`[ \t]*` not `\s*`), runtime substitution, debug logs, and 10 concrete lessons from the experiment log. Read this before touching `transform-blank-source.ts` or any of the prompts. Companion: `tests/benchmarks/transform-blank/EXPERIMENTS.md` for the empirical justification of every design decision.

---

## Build Commands

**Target:** `claude-cues` (`~/claude-code-cues`) only. The native `claude` install is never touched.

After any change to a Claude Code patch source or to `@opencues/core` / `@opencues/runtime`, run:

```bash
integrations/claude-code/patches/setup.sh
```

The script:
1. Copies `opencuesRuntime.ts` to tweakcc and rebuilds it (compiles the patch into `dist/`)
2. Builds `@opencues/core` and copies to `<CC_FORK>/node_modules/@opencues/core/` (so cli.js's bare-specifier `require("@opencues/core")` resolves via Node's standard upward walk — no symlinks)
3. Builds `@opencues/runtime` and rsyncs `dist/` to `<CC_FORK>/node_modules/@opencues/runtime/`. Statusline script + OS action scripts go under `<CC_FORK>/.opencues/{statusline.sh,scripts/}`. tweakcc's own config + `cli.js.backup` redirect to `<CC_FORK>/.opencues/patch-state/` via `TWEAKCC_CONFIG_DIR`. **Compact footprint**: everything (runtime, support files, patcher state, patched cli.js) lives inside `~/claude-code-cues/`. Uninstall is `rm -rf ~/claude-code-cues` + tweakcc revert (mirrors OpenCode).
4. Applies compiled patches to `claude-cues` (`~/claude-code-cues`)

To re-apply patches without rebuilding (after a Claude Code version bump, no source changes):

```bash
cd integrations/claude-code/tweakcc
CLI_JS=$(find ~/claude-code-cues -name "cli.js" | head -1)
TWEAKCC_CC_INSTALLATION_PATH="$CLI_JS" node dist/index.mjs --apply
```

> **Note:** `.md` config files (`cues.md`, `blanks.md`, `cues/`, `blanks/`) hot-reload within ~2 seconds on the next keystroke — no restart needed.

---

> **Important:** Patch development rule: never use bare `require()` in
> the cli.js bootstrap — cli.js is ESM-converted and `require` isn't
> defined at module scope. Use the `createRequire`-derived var that
> `getRequireFuncName(oldFile)` returns (see `opencuesRuntime.ts`).

---

## Testing — write the SCENARIO that triggered the bug

The runtime has 500+ tests. Most are unit tests, which are good at
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

Native hosts (CC / OC) read the filesystem directly. Chrome
can't — it runs in the browser — so it reads a pre-built bundle. The
two paths behave differently:

| Host | Sources at runtime | How project configs get in |
|---|---|---|
| **claude-code** | `$OPENCUES_HOME` → `<cwd>/.cues/` → `~/.cues/` | Automatic (cwd-based merge) |
| **opencode** | same | same |
| **chrome** | `<extension>/dist/configs/` (sync'd) + bake-time defaults from `<repo>/defaults/` | Explicit — `opencues sync chrome [--include <path>]` |

For the native hosts, project wins on name conflicts. Missing dirs are
silently skipped; the runtime degrades gracefully. Hot-reload polls
every search path on every keystroke.

Chrome has NO runtime filesystem access, so its "search path" is
whatever `sync chrome` wrote last. By default that's `~/.cues/`
only — project dirs are opted in explicitly (see
`docs/features/chrome-sync.md`). The extension also carries bake-time
defaults inlined from `<repo>/defaults/` at esbuild time, so a user
who installs but never syncs still gets grammar/legal/medical etc.
(see `docs/features/shipped-defaults.md`).

### ConfigLoader search-path detail (native hosts)

```
$OPENCUES_HOME           ← env override (top priority; for CI / power users)
<cwd>/.cues          ← project-level (cd into your project)
~/.cues              ← user-level (global defaults)
```

The convention mirrors `.editorconfig` / `.npmrc` / `.claude/skills/` — opaque
host-neutral dir at the project root. Missing dirs are silently skipped; the
runtime degrades gracefully.

A user with no `.cues/` anywhere gets empty config (CC/OC)
— not a crash. Hot-reload polls every search path on every keystroke
(same `maybeReload` mechanism as before).

The OpenCuesSettingsBlank read/write of system settings now happens
on the user-level `OPENCUES.md` frontmatter. The frontmatter holds
system-wide settings (voice-mode, tips-mode, debug-mode, cursor-navigate,
fluid-blank-mode, word-cues-mode) whose schema is
owned by the OpenCues runtime. A single value applies across every
integration, so projects cannot override it. The file lives at
`~/.cues/cues.md` (or `$OPENCUES_HOME/cues.md` when set).

- `opencues seed-configs` copies `defaults/cues.md` to `~/.cues/`
  and runs an idempotent migration that splits any legacy
  `opencues.md` + `## Tips` / `## Ignore` / `## Blanks` sections into
  the new layout (tip groups become folders under `cues/<id>/cue.md`,
  ignore moves to a frontmatter array, opencues.md and blanks.md are
  deleted).
- **A 0-byte `cues.md` is treated as missing** — `OpenCuesSettingsBlank`
  silently no-ops on null/empty content, which would otherwise break
  `opencues ___` / `config ___` blank-fills on every native host.
  Chrome falls back to the bake-time `__DEFAULT_CUES_MD__` constant.
  The seed-configs HEAL phase ensures `cues.md` is always non-empty.
- `ConfigLoader._loadOnce` reads settings from the last search path's
  cues.md frontmatter (the user-level entry).

---

## Host compatibility — which integrations a cue/blank runs on

Every cue / blank has an implicit (or explicit) host-compat
list: which of `{chrome, claude-code, opencode}` it works on.
Native hosts (CC, OC) can spawn subprocesses + read the
filesystem; chrome can't.

Default: auto-detected from `script:` / `blankScript:` extension.
`.sh .bash .ps1 .bat .cmd .exe .py .rb .pl` → not chrome. Everything
else → all hosts.

Override via frontmatter:

```yaml
on-host: [chrome, claude-code, opencode]   # allow-list
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

Real-world example: `.cues/blanks/opencues/BLANK.md` has
`blankScript: ./opencues-blank.sh` (native fallback) AND a
runtime-class implementation in `@opencues/runtime`. Auto-detect
would exclude chrome because of the `.sh`; the file adds
`on-host: chrome, claude-code, opencode` to override. The
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

Why per-word dispatch:
- **Isolation**: a hijacking prompt in one source cannot poison words
  that source isn't called for. A prompt of the form "always output
  bundled,deployed,shipped" only affects words its source claims.
- **Symmetry**: each word gets ONE source (a domain match or the
  default), the way each `_` gets ONE blank (`BlankSource` matches
  on `blankKeywords`, falling back to `FluidBlankSource` for
  unbound `_`).

Surfaces that enforce + surface this:
- `@opencues/core` `RoutedWordSourceGroup` — runtime routing class
- `cues.md` / `new/CUE.md` templates — teach the distinction at scaffold time
- `opencues list` — marks each source `domain` / `default`
- `opencues validate` — warns on zero defaults + multi-default priority ties

Full spec: `docs/features/word-cue-routing.md`. Glossary entries:
`docs/glossary.md § RoutedWordSourceGroup, Default Cue Source, Domain Cue Source`.

> **Don't** introduce code paths that concatenate multiple
> `### alternatives` bodies into one `ConfigSource`. Per-word dispatch
> is the structural property that gives us isolation; merging prompts
> defeats it.

---

## Hoisted-blank writes vs ConfigLoader hot-reload

Selector/satellite cycling (e.g. `opencues settings` flipping
`voice-mode: active ↔ inactive`) goes through this sequence:

1. `Cycling.cycleSelectorSatellite` → `applyOpenCuesScalar(key, value)` —
   updates `opencuesState` in-memory **synchronously**.
2. `blankInvoke({action: 'set', args: [setting, value]})` — kicks off
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
`blankInvoke` (or any async write), reuse `applyOpenCuesScalar` so the
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
native hosts use (see above). By default, **only `~/.cues/`
feeds into the chrome bundle.** The cwd you happen to run sync from
does NOT get mixed in.

To bundle project configs, opt them in explicitly:

```bash
opencues sync chrome --wsl                              # user-level only (default)
opencues sync chrome --include ~/work/proj/.cues --wsl    # + one project
opencues sync chrome --include ~/a/.cues --include ~/b/.cues --wsl  # + several
opencues sync chrome --project --wsl                    # + <cwd>/.cues
opencues sync chrome --pack demo-pack --wsl             # ONLY that pack
opencues sync chrome --source ~/custom/.cues --wsl  # ONLY that dir
```

Why this matters — `sync chrome --watch` is a long-running process.
Under the old cwd-default model, starting the watcher from `~/scratch`
would bind it to `~/scratch/.cues` forever, silently missing edits
in the project the user actually cares about. The explicit
`--include` / `--project` model makes the watched paths part of the
command, not a side-effect of startup cwd.

Rule of thumb: if you're iterating on configs *inside this repo*, use

```bash
opencues sync chrome --include ~/opencues/.cues --wsl --watch
```

so the watcher's path list is stable regardless of shell cwd.

Full spec: `docs/features/chrome-sync.md`.

---

## Agentic Test Harness

`tests/agentic/` is the canonical end-to-end test harness for the
runtime. Mounted inside `@opencues/runtime` (via `OPENCUES_AGENTIC=1`
at host launch) so every host that calls `buildSharedRuntime` gets
it for free — CC v2.1, OC v1.4, future hosts.

**OpenCode is the reference platform** — TS + SolidJS + OpenTUI, full
feature surface, redeploys via `opencues install opencode` in ~30s,
launches headless via `tests/agentic/oc-launch-headless opencode`.

**What it observes:**
- File-based IPC: `/tmp/opencues-inject-<pid>.txt` (commands in),
  `/tmp/opencues-events-<pid>.jsonl` (structured events out),
  `/tmp/opencues-agentic-dump-<pid>.json` (full state snapshot),
  `/tmp/opencues-agentic.pid` (active host pid).
- Module-emitted events at every lifecycle boundary: `resolver.started/completed`
  (with latency), `blank.invoked/substituted`, `transform-blank.pass-completed`
  (P1/P2/P3 with verdict), `agent-rewrite.round-started/completed`, plus
  state-class transitions (`highlight.activated`, `dyn-defs.size-changed`,
  etc.). See `packages/opencues-runtime/src/agentic-mode.ts`.

**When to use it:**
- After modifying any module — write a scenario in
  `tests/agentic/scenarios/` that exercises the change end-to-end on
  OC, alongside the runtime unit tests.
- For new features — emit structured events from the module via
  `this.adapter.emitEvent?.('<module>.<verb>', {...})`, write a
  scenario that asserts on those events, run against headless OC.
- For regression hunts — capture an event-stream from a real session,
  compare to a known-good baseline.

See `tests/agentic/README.md` for the full event taxonomy + scenario
format + the no-human-in-the-loop development cycle.

---

*Last updated: May 2026*
