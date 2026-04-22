# OpenCues — Overview for Damon

OpenCues adds real-time word guidance to text editors. As you type, it dims words that have alternatives, lets you navigate between them, and cycles through suggestions with arrow keys — all without leaving the input.

It currently runs inside four hosts:

- **Claude Code** (the CLI) — patched via `tweakcc`
- **OpenCode** (terminal-based AI coding tool) — patched fork at `~/opencode-cues`
- **Chrome** — Manifest V3 browser extension (works in any `<textarea>` / `contenteditable`)
- **Codex** (OpenAI's TUI) — alpha, pinned to codex-rs `d58d3cc`

Same runtime, four host adapters. The architecture deliberately keeps the host glue thin so adding new editors is mostly a few hundred lines of bridge code.

---

## System Overview

Three interaction modes, one navigable system:

| Mode | Trigger | What happens |
|------|---------|-------------|
| **Cues** | Type normally | Words with alternatives are dimmed. Navigate and cycle. |
| **Blanks** | Type `_` | LLM fills in the blank — maths, factual, grammar. |
| **Controls** | Type a keyword or `keyword _` | Triggers a script (volume, brightness) or fetches live data. |

```
┌──────────────────────────────────────────────────────────────────┐
│  USER  (typing in Claude Code, OpenCode, Chrome, or Codex)       │
│  "The dog was _ and the volume _"                                │
└──────────────────────────────────┬───────────────────────────────┘
                                   │ keystrokes
                                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  HOST INTEGRATION (per-editor glue — the spinal cord)            │
│  ┌────────────────┐  ┌─────────────┐  ┌────────────────┐  ┌───┐ │
│  │ tweakcc patches│  │ OpenCode    │  │ Chrome MV3     │  │..│ │
│  │ (CC v2.x)      │  │ patches v1.4│  │ extension      │  │  │ │
│  └────────┬───────┘  └──────┬──────┘  └────────┬───────┘  └───┘ │
└───────────┼─────────────────┼──────────────────┼────────────────┘
            │                 │                  │
            └─────────────────┴──────────────────┘
                              │ (single API)
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  @opencues/runtime  (host-agnostic — the nervous system)         │
│  Navigation · Cycling · BlankFill · DimRender · ConfigLoader     │
│  DynDefs · SpanFillState · TS controls (HN, Stocks, Weather, …)  │
└──────────────────────────────────┬───────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  @opencues/core  (pure TypeScript — the brain)                   │
│  CueResolver · RoutedWordSourceGroup · ClassifiedSourceGroup     │
│  ConfigSource · ControlBlankSource · parsers (cues.md, …)        │
└──────────────────────────────────┬───────────────────────────────┘
                                   │ HTTPS keep-alive
                                   ▼
                       ┌────────────────────┐         ┌────────────┐
                       │  LLM Provider      │         │ External   │
                       │  (Groq / OpenAI)   │         │ scripts +  │
                       │  ~200-500ms        │         │ APIs       │
                       └────────────────────┘         └────────────┘
                                                       (volume.sh,
                                                        stocks API,
                                                        weather API,
                                                        HN RSS …)
```

---

## Cue Types

---

### 1. Remote Word Cues

The core feature. After a short pause in typing, the system sends words to the LLM and gets back alternatives (synonyms, opposites, related words). Words with alternatives are dimmed. You navigate to one and cycle through its options with Up/Down.

- Configured in `cues/` folders or `cues.md`
- LLM prompt controls what kind of alternatives are returned (synonyms, antonyms, style variants)
- **Per-word routing.** Each `### alternatives` source is wrapped in a `RoutedWordSourceGroup` that dispatches each word to exactly ONE source — `liability` goes to the `legal` cue, `diagnosis` goes to `medical`, etc. Domain sources isolate from each other (a hijacking prompt in one source can no longer poison every word). A "default" source catches everything else (grammar). One LLM call per source group, in parallel.
- Results are cached per word — re-analysis only sends words that don't have alts yet (see "Resolver Skip Filter" under Other Features)
- Linked words cycle together (e.g. noun/verb pairs)
- Alternatives can be multi-word spans ("very good" → "excellent"); multiple spans can coexist in the same input
- Cycle progress survives prefix/middle text edits via deterministic relocate (see Other Features)

```
USER TYPES
──────────────────────────────────────────────
  "The dog was happy"

  state: { words: [...], alts: {} }
  (no highlighting — still typing)

  ... 300ms pause ...
                        │
                        ▼
ANALYZING
──────────────────────────────────────────────
  "The dog was happy"   ← no visual change yet
                            LLM request in flight

                        │
                        ▼ LLM returns:
                            dog:   ["cat", "fox", "bear"]
                            happy: ["joyful", "content", "pleased"]
ALTS READY
──────────────────────────────────────────────
  "The dog was happy"
            ~~~     ~~~~~   ← dimmed = has alts

  state: {
    alts: {
      1: ["dog", "cat", "fox", "bear"],
      3: ["happy", "joyful", "content", "pleased"]
    },
    hlIdx: null
  }

  User presses Ctrl+Alt+Right
                        │
                        ▼
NAVIGATED
──────────────────────────────────────────────
  "The dog was [happy]"
                ─────    ← underlined

  state: { hlIdx: 3 }
  Status line: (empty — no tip for this word)

  User presses Up
                        │
                        ▼
CYCLED
──────────────────────────────────────────────
  "The dog was [joyful]"
               ──────

  state: { alts[3].currentIndex: 1 }

  Up → "content" → "pleased" → wraps back to "happy"
```

---

### 2. Fill-in-the-Blank

Type `_` anywhere in your input and the system classifies the context and fills it in. The blank is detected on the same auto-submit cycle as word alts. The LLM gets the full sentence with `___` in place of the blank and returns the answer.

Three blank modes:
- **MATH** — `3 * 8 _` → `24`
- **FACTUAL** — `capital of France _` → `Paris`
- **GRAMMAR** — `she go _ the store` → `to` (fills missing words)

Blank modes are configured in `blanks.md`. The classifier decides which mode applies based on context.

```
USER TYPES
──────────────────────────────────────────────
  "the capital of France is _"

  state: { blanks: [5] }   ← _ at word index 5

  ... 300ms pause ...
                        │
                        ▼
CLASSIFYING
──────────────────────────────────────────────
  ControlBlankSource  → no keyword match → pass
  ClassifiedSourceGroup → classifies as FACTUAL
  LLM prompt: "fill in: the capital of France is ___"

                        │
                        ▼ LLM returns: "Paris"
FILLED
──────────────────────────────────────────────
  "the capital of France is [Paris]"
                              ~~~~~   ← dimmed

  state: { alts[5]: ["Paris"] }

  Single answer — no cycling. Navigate away to keep typing.
```

---

### 3. Control-Bound Blank

Type a keyword adjacent to `_` and the blank auto-populates with a live system value. Up/Down cycles the value and calls a script to apply it. The script always receives and returns plain numbers — display formatting (like `%`) is handled by the `blankSuffix` config field.

Multiple keyword occurrences in the same input are handled correctly — the keyword nearest to `_` is used, so `spanish weather 15°C is warmer than london weather _` finds the second "weather".

Config fields: `blankKeywords`, `blankStep`, `blankRange`, `blankSuffix`, `blankAutoPopulate`, `blankScript`.

```
USER TYPES
──────────────────────────────────────────────
  "volume _"

  ControlBlankSource:
    "volume" is adjacent to _ → matched
    blankSuffix: %

  Reads: controls/volume/state.txt → "50"
  displayValue = "50" + "%" = "50%"
                        │
                        ▼
AUTO-POPULATED
──────────────────────────────────────────────
  "volume [50%]"
           ~~~~   ← dimmed

  state: {
    alts[1]: ["50%"],
    metadata[1]: { controlName: "volume", blankStep: 6, blankSuffix: "%" }
  }

  User navigates to "50%" and presses Up
                        │
                        ▼
CYCLING
──────────────────────────────────────────────
  strip suffix:  "50%" → "50"
  arithmetic:    50 + 6 = 56
  re-add suffix: "56%"
  script call:   bash volume-blank.sh set 56   ← plain number

  "volume [56%]"
           ~~~~

  state: {
    alts[1]: ["56%"],
    _cueControlValues: { volume: 56 }
  }

  Up → 62% → 68% ...   Down → 62% → 56% → 50% → floor: 0%
```

---

### 4. Step Control

Any word matching a suffix pattern is navigable and steps arithmetically on Up/Down. No script, no LLM — pure config. Useful for numeric values in your text: pixel sizes, floats, percentages.

Configured with `stepSuffixes` (e.g. `px`), `step` (e.g. `5`), and `stepMin`/`stepMax`.

```
USER TYPES
──────────────────────────────────────────────
  "padding: 10px"

  "10px" matches stepSuffixes pattern → navigable

  "padding: 10px"
             ~~~~   ← dimmed

  state: { stepMatch: { word: "10px", suffix: "px", value: 10 } }

  User navigates to "10px" and presses Up
                        │
                        ▼
STEPPED
──────────────────────────────────────────────
  10 + 5 = 15

  "padding: 15px"
             ~~~~

  No script. No LLM. Instant.

  Up  → 15px → 20px → 25px → 30px ...
  Down → 25px → 20px → 15px → 10px → 5px → 0px  (stepMin: 0)
```

---

### 5. List Control

A blank that cycles through an ordered list of values rather than stepping numerically. The list can be static (defined in `stepValues`) or dynamic — if the script returns multiple lines, each line becomes a cycling option.

With `blankDismissible: true`, `_` is appended as the last option. Cycling to it dismisses the blank. A dismissed blank won't re-populate until the text changes.

```
USER TYPES
──────────────────────────────────────────────
  "affirmation _"

  ControlBlankSource:
    "affirmation" adjacent to _ → matched
    stepValues: ["I am strong","I am brave","I am worthy","I am enough"]
    blankDismissible: true
    → alts = [...stepValues, "_"]
                        │
                        ▼
AUTO-POPULATED
──────────────────────────────────────────────
  "affirmation [I am strong]"
               ~~~~~~~~~~~   ← span (3 words)

  state: {
    alts[1]: ["I am strong","I am brave","I am worthy","I am enough","_"],
    currentIndex: 0,
    spanLength: 3
  }
  Status line: "Daily affirmations"

  Up → "I am brave" → "I am worthy" → "I am enough" → ...
                        │
                        ▼  (one more Up)
DISMISSED
──────────────────────────────────────────────
  "affirmation _"

  state: {
    currentIndex: 4,
    _dismissedBlanks: { 1: true }
  }

  Analysis re-runs → _dismissedBlanks[1] is set → skip → stays as _
  User edits text → _dismissedBlanks cleared → next analysis re-populates
```

---

### 6. Read-Only Blank (Live Data)

A control-bound blank that fetches live data from an external API but does not allow cycling. The matched keyword is passed to the script so one script can serve multiple lookups (e.g. "reddit" → RDDT → price).

Set `blankReadOnly: true` in the control config.

```
USER TYPES
──────────────────────────────────────────────
  "Reddit stock _"

  ControlBlankSource:
    "reddit" adjacent to _ → matched (blankKeywords includes company names)
    blankReadOnly: true
    → calls: bash stock-blank.sh get reddit
    → script: looks up "reddit" in tickers.json → "RDDT"
    → calls Finnhub API → returns "121.45"
                        │
                        ▼
AUTO-POPULATED
──────────────────────────────────────────────
  "Reddit stock [121.45]"
                ~~~~~~   ← dimmed

  state: {
    alts[2]: ["121.45"],
    metadata[2]: { blankReadOnly: true }
  }
  Status line: "Stock price"

  User presses Up or Down
                        │
                        ▼  blankReadOnly → no-op

  "Reddit stock [121.45]"   ← unchanged
```

---

## Other Features

These work across all cue types and all hosts:

- **Navigation** — Ctrl+Alt+Left/Right moves between navigable words. Only words with alts, tips, step patterns, or controls are navigable.
- **Visual Cues** — Navigable words are dimmed. The selected word is underlined.
- **Status Line / Secondary Display** — Shows a tip (configured per control or word) in the host's status surface (CC status bar, OC home footer, Chrome popup) when a word is selected.
- **Linked Words** — Words that must change together. Cycling one cycles the other automatically.
- **Multi-Word Spans** — A cycling alternative can span multiple words. **N spans concurrent** — you can have several cycled spans live in the same input, each independent.
- **Cycle Survival**:
  - **Resolver Skip Filter** — once you cycle `attorney → lawyer`, the LLM is *not* re-asked about "lawyer" on the next pulse. Without this, the resolver would silently swap your alt track to a "lawyer"-themed one (`client / customer / person`). Saves tokens AND prevents drift.
  - **Deterministic Relocate** — type "Yesterday " in front of a sentence with cycled words, and the cycle progress *follows the words to their new index*. Only relocates when the match is unambiguous; ambiguity drops cleanly rather than guessing.
- **Per-Word Clearing** — Editing a word clears its alternatives. Other words in the input are unaffected.
- **Cursor Preservation** — Cursor position adjusts when a word changes length so you don't lose your place.
- **Cursor Navigate** (optional) — Highlight automatically follows cursor to navigable words. Toggle with the `cursor-navigate` setting.
- **Auto-Submit** — Analysis fires automatically after a pause in typing. Only unseen words are sent to the LLM.
- **Selector + Satellite Blanks** — A single `_` can become two linked words: a selector picks a setting, a satellite shows/writes its value. How `voice-mode active` toggles work in-text.
- **Tip Priority** — When a word matches multiple tip sources, a fixed priority decides which one wins (selector > satellite > control blank > cue-control keyword > local cue > LLM).
- **Hot-Reload Config** — `.md` config files reload within ~2 seconds for native hosts (CC, OC, codex). Chrome polls a content-addressable `.version` hash so `opencues sync chrome --watch` propagates edits into already-open tabs in the same window. No restart needed.

---

## Config Files

Lives at `~/.opencues/` (user-level) and optionally `<cwd>/.opencues/` (project-level — merged on top for native hosts; explicitly opt-in for Chrome via `opencues sync chrome --include`).

```
~/.opencues/
├── opencues.md     — System settings (voice-mode, tips-mode, debug-mode, cursor-navigate)
├── cues.md         — Tips (## Tips JSON block) + global prompts + ignore list
├── cues/           — Folder-based word cue configs (grammar, legal, medical, financial)
│   └── grammar/cue.md
├── blanks.md       — Blank-fill modes (math, factual, grammar, etc.)
├── controls.md     — Inline control definitions (rarely used)
└── controls/       — Folder-based controls (one folder per control)
    └── volume/
        ├── cue.md            — Config (blankKeywords, blankStep, blankSuffix, etc.)
        ├── volume.sh         — Word-control script (up/down)
        ├── volume-blank.sh   — Blank-control script (get/set)
        └── state.txt         — Runtime state (gitignored)
```

The repo's `defaults/` directory ships the seed configs — the same files get baked into the Chrome extension at build time and copied to `~/.opencues/` by `opencues seed-configs`. The repo no longer self-dogfoods via an in-tree `.opencues/`.

Each cue / blank / control declares which hosts it works on (`on-host: [chrome, claude-code, …]`) so chrome doesn't try to spawn a `.sh` script and native hosts don't ignore a TS-only control.

---

## Current Controls

| Control | Type | Usage |
|---------|------|-------|
| Volume | Word + blank | `volume` word → OSD; `volume _` → `50%`, steps by 6 |
| Brightness | Word | `brightness` word → steps by 10 |
| Numbers | Step | `1.5f`, `3.0f` → steps by 0.5 (suffix: `f`) |
| Affirmations | List (dismissible) | `affirmation _` → cycles through positive affirmations |
| Stocks | Read-only blank | `Reddit stock _` → live share price (Finnhub) |
| Weather | Read-only blank | `London weather _` → current forecast (Open-Meteo) |
| Hacker News | Dynamic list (dismissible) | `HN posts _` → live headlines from RSS feed |
| OpenCues Settings | Selector + Satellite | `voice-mode _` → `active` / `inactive`; cycling writes the setting to `opencues.md` |
| Answer | Consume-all blank | Dedicated answer-formatting control |
| Prompt Improver | Consume-all blank | Rewrites the surrounding prompt text in place |

---

## The `opencues` CLI

Single front-door for managing every host integration. OpenCues spans four hosts with very different install models — CC patches `cli.js` via `tweakcc`, OpenCode patches a forked source tree, Chrome bundles configs into the extension, Codex patches a Rust TUI. The `opencues` CLI normalizes "install / update / debug" so you don't have to remember each integration's quirks.

```
$ opencues --help

Setup:
  install <host>          Install a host integration (claude-code|opencode|codex|chrome|--all)
  uninstall <host>        Roll back an installation
  seed-configs            Copy repo defaults into ~/.opencues/
  update                  Pull, rebuild, redeploy installed integrations
  set-key <provider>      Store an API key in ~/.opencues/.env
  check-keys              Verify configured API keys against provider endpoints

Authoring:
  init                    Scaffold <cwd>/.opencues/ with templates
  new <kind> <name>       Scaffold a single cue / blank / control
  validate                Lint configs across search paths
  import <source>         Download a community config pack (gist/github/url/local)

Run / inspect:
  run <host>              Launch the patched host
  sync <host>             Bundle .opencues/ into a host that doesn't auto-discover (chrome)
  which                   Print every relevant path (installs, configs, logs)
  version                 Print CLI version + per-integration versions/compat
  doctor                  Cross-host diagnostics + suggested fixes
  list                    List every defined cue / blank / control with source path
  show <name>             Print full config for one cue / blank / control by name
  edit <file>             Open ~/.opencues/<file>.md in $EDITOR
  logs [--tail]           Show /tmp/opencues.log
  debug [on|off]          Toggle runtime debug-mode
  completion <shell>      Print shell completion script (bash | zsh | fish)
```

Three high-level surfaces:

**Setup** — manages installations across hosts. `install --all` sets up every detected integration in one shot; `update` pulls the repo and re-deploys to each existing install. `seed-configs` populates `~/.opencues/` from the shipped `defaults/` so you start with the same `cues.md` / `blanks.md` / `controls.md` that ship with the project.

**Authoring** — for users *building* their own cues. `init` scaffolds a `.opencues/` directory in any project. `new control hackernews-rss` (or `new cue legal`, `new blank math`) writes a starter file with comments. `validate` lints the configs across every search path before you start the host. `import gh:someone/cool-cues` pulls a community pack.

**Run / inspect** — day-to-day operations. `which` is the "where does X live?" answer (paths to every install, config, log, key file). `list` shows every cue/blank/control plus where it was loaded from (so you can see project-level overriding user-level). `show <name>` dumps one entry's full config. `doctor` walks every installation and points at fixable problems. `logs --tail` is for live debugging.

The CLI is the same whether you have one host installed or four — `opencues install --all` then `opencues update` keeps everything fresh in one command. Per-host installers (`integrations/<host>/bin/install.cjs`) still exist underneath; the CLI just orchestrates them.

---

## Stack

Two core packages + per-host integration glue:

- **`@opencues/core`** — Pure TypeScript. Parses config files, dispatches LLM requests, resolves results into per-word alternatives. No platform dependencies. *("What alternatives exist?")*
- **`@opencues/runtime`** — Host-agnostic. Owns Navigation / Cycling / BlankFill / DimRender / ConfigLoader, the per-host adapter contract, and the TS-implemented controls (HackerNews, Stocks, Weather, PromptImprover, OpenCuesSettings, …). *("How does the user interact with those alternatives?")*

Per-host integrations (under `integrations/`):

- **`integrations/claude-code/`** — `tweakcc` patches injected into Claude Code's `cli.js` at build time
- **`integrations/opencode/`** — Patches applied to a forked OpenCode source tree (`~/opencode-cues`)
- **`integrations/chrome/`** — MV3 extension; CSS Custom Highlight API for in-page rendering; bundle hot-reload via `.version` polling
- **`integrations/codex/`** — Alpha; TUI patches landed (Rust ↔ Node JSON-RPC bridge); pinned to codex-rs `d58d3cc`

Other:

- **Groq** — Default LLM provider (fast, free tier). Swap via `GROQ_API_KEY`. Other providers configurable via `cues.md` frontmatter.
- **Open-Meteo / Finnhub / HN RSS** — Free APIs used by the weather, stocks, and news controls.

The CLI (`opencues …`) wraps install / sync / validate / list / seed-configs / which / update / uninstall across every host. `pnpm exec opencues install <host>` is the one-command setup.
