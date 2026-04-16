# CLAUDE.md - OpenCues

This document provides context for Claude sessions working on this project.

## Project Overview

**OpenCues** provides LLM-powered word alternatives for text editors. The core library analyzes text and suggests alternatives (synonyms, opposites, completions) that users can cycle through.

**Architecture**:
- **cues-core** — Pure TypeScript library for LLM analysis (prompts, resolver, HTTP adapter)
- **Integrations** — Editor-specific implementations that use cues-core

**Current Integrations**:
- **Claude Code** — via tweakcc patches (`integrations/claude-code/patches/`)

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
├── cues.md                        # OpenCues config (tips, prompts, ignore)
├── blanks.md                      # Blank-fill modes (math, factual, grammar, etc.)
├── controls.md                    # Cue-controls (can be empty if using folders)
├── opencues.md                    # System state (settings, current values, tips)
├── README.md                      # Public readme with install instructions
│
├── cues/                          # Folder-based word cue configs
│   ├── grammar/cue.md             # Base word alternatives
│   ├── legal/cue.md               # Legal terminology alternatives
│   ├── medical/cue.md             # Clinical terminology alternatives
│   └── financial/cue.md           # Financial terminology alternatives
│
├── controls/                      # Folder-based cue-controls (colocated scripts + state)
│   ├── volume/
│   │   ├── cue.md                 # Control config (type: control, blankKeywords, etc.)
│   │   ├── volume.sh              # Word-control script: up/down via key presses
│   │   ├── volume-blank.sh        # Blank-control script: get/set via Core Audio API
│   │   └── VolCtl.cs              # C# source for Windows Core Audio API (compiled by setup.sh)
│   ├── brightness/
│   │   ├── cue.md
│   │   └── brightness.sh
│   ├── numbers/
│   │   └── cue.md                 # Step control (stepSuffixes: f, step: 0.5)
│   ├── affirmations/
│   │   └── cue.md                 # List control (stepValues: ["I am strong", ...])
│   ├── stocks/
│   │   ├── cue.md                 # Read-only API control (blankReadOnly, Finnhub)
│   │   ├── stock-blank.sh         # Fetch script: get <keyword> → resolve ticker → price
│   │   └── tickers.json           # Keyword-to-ticker mapping
│   ├── weather/
│   │   ├── cue.md                 # Read-only API control (Open-Meteo, context-driven)
│   │   └── weather-blank.sh       # Fetch script: geocode + forecast (any city/country)
│   ├── hackernews/
│   │   ├── cue.md                 # Dynamic list control (blankDismissible, RSS feed)
│   │   └── hn-blank.sh            # Fetch script: RSS → one title per line → scrollable list
│   ├── prompt/
│   │   ├── cue.md                 # Consume-all control (blankConsumeAll, two-step LLM)
│   │   └── prompt-blank.sh        # Two-step LLM: extract prompt/conditions → improve → 3 alts
│   └── answer/
│       ├── cue.md                 # Consume-context control (blankConsumeContext, factual lookup)
│       └── answer-blank.sh        # LLM: keyword + context → answer (3 alternatives)
│
├── packages/                      # Core packages
│   └── cues-core/                 # LLM analysis library
│       ├── src/
│       │   ├── resolver.ts        # CueResolver orchestration
│       │   ├── cues-md.ts         # cues.md parser (parseCuesMd, parseSingleCueMd)
│       │   ├── discover.ts        # Folder-based config discovery
│       │   ├── node-http-adapter.ts  # HTTPS with keep-alive
│       │   └── sources/           # ConfigSource, ClassifiedSourceGroup, ControlBlankSource, parsers
│       ├── prompts/               # Prompt references + documentation
│       │   ├── linked.txt         # Linked words prompt
│       │   └── references/        # Prompt documentation
│       └── dist/                  # Built output
│
├── integrations/claude-code/      # Claude Code integration
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
~/opencues/integrations/claude-code/patches/setup.sh
export GROQ_API_KEY="your-key"
```

The setup script:
1. Clones tweakcc from upstream
2. Copies and integrates patch files
3. Builds cues-core → ~/.claude/node_modules/
4. Applies patches to `claude-cues` (`~/local-claude-code`) — not the native `claude` install

---

## Key References

- **README.md** — Features, install, configuration, troubleshooting
- **CONTRIBUTING.md** — How to extend the standard, build integrations, modify cues-core
- **docs/overview.md** — System architecture, core interfaces, API usage
- **docs/glossary.md** — All terminology (cues, blanks, sources, parsers, config files)
- **docs/guides/** — Task-oriented how-tos (adding features, integrations, cue-controls, parser types, LLM providers)
  - **`adding-a-cue-control.md`** ⚠️ Must-read before adding any new control — covers blank routing, cycling pitfalls (numeric vs list), span invalidation contract, and `def.word` post-populate behaviour. **Update the pitfalls section** when new failure modes are found.
  - **`creating-a-cue-type.md`** ⚠️ Must-read before implementing a new cue type — covers dedicated global vs `_dynDefs` decision, span cleanup (word-level invalidation pattern), `def.word` contract, and section E pitfalls. **Update section E** when new invalidation or cleanup patterns are discovered.
- **integrations/claude-code/docs/** — Claude Code implementation docs
  - **`tweakcc-setup.md`** — One-time tweakcc setup steps (patches to remove, cues block to comment out)
- **integrations/claude-code/tweakcc/** — tweakcc install (untracked, gitignored) — clone here on fresh setup
- **integrations/claude-code/reintegration/steps.md** — Progressive re-integration log (step status + what changed)
- **docs/features/** — 21 feature concepts (one file each)

---

## Re-integration Status

> ⚠️ **ACTIVE RE-INTEGRATION** — The existing patches are outdated against the current Claude Code version. We are progressively re-implementing from scratch against `claude-cues` (v2.1.110). **Ignore all prior `setup.sh` and build instructions below** until re-integration is complete.

**Current approach:** Start small — get a minimal patch working against the new version, verify it, then layer features back in incrementally. Do not attempt to apply the old patch files wholesale.

**Target:** `claude-cues` (`~/local-claude-code`) only. The native `claude` install is never touched.

---

## Build Commands

> ⚠️ The instructions below describe the **pre-re-integration** workflow. They are preserved for reference but are **not currently operational**. Do not follow them until re-integration is complete.

~~**After any change, use `setup.sh`**~~ — the setup.sh-based workflow is outdated pending re-integration.

```bash
# OLD — do not use during re-integration
integrations/claude-code/patches/setup.sh
```

The script previously:
1. Copied patch `.ts` files to tweakcc and rebuilt tweakcc (compiled patches into `dist/`)
2. Built cues-core (`src/` → `dist/`) and copied to `~/.claude/node_modules/cues-core/`
3. Applied compiled patches to `claude-cues` (`~/local-claude-code`) — never the native `claude` install

```bash
# OLD — re-apply patches only (after Claude Code updates, no source changes)
cd ~/tweakcc
CLI_JS=$(find ~/local-claude-code -name "cli.js" | head -1)
TWEAKCC_CC_INSTALLATION_PATH="$CLI_JS" node dist/index.mjs --apply
```

> **Note:** `.md` config files (`cues.md`, `blanks.md`, `controls.md`, `cues/`, `controls/`) hot-reload within ~2 seconds on the next keystroke — no restart needed (this will remain true post-re-integration).

---

> **Important:** See `integrations/claude-code/docs/architecture.md` § "Development Notes" for critical patch development rules (e.g., never use bare `require()` in patch files).

---

## Environment

- **API Key**: `GROQ_API_KEY` for Groq (default provider)
- **API Key**: `FINNHUB_API_KEY` for Finnhub (stock prices)
- **Debug**: `DEBUG=cues*` for debug logging
- **Config**: `~/.tweakcc/config.json` for Claude Code settings

> **PRE-LAUNCH:** Rotate `GROQ_API_KEY` and `FINNHUB_API_KEY` before making the repo public. Keys are hardcoded in `integrations/chrome-extension/.env` (gitignored) for dev convenience.

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
