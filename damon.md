# OpenCues — Overview for Damon

OpenCues adds real-time word guidance to text editors. As you type, it dims words that have alternatives, lets you navigate between them, and cycles through suggestions with arrow keys — all without leaving the input.

It currently runs inside three hosts:

- **Claude Code** (the CLI) — patched via `tweakcc`
- **OpenCode** (terminal-based AI coding tool) — patched fork at `~/opencode-cues`
- **Chrome** — Manifest V3 browser extension (works in any `<textarea>` / `contenteditable`)

Same runtime, three host adapters. The architecture deliberately keeps the host glue thin so adding new editors is mostly a few hundred lines of bridge code.

---

## System Overview

Two interaction modes, one navigable system:

| Mode | Direction | Trigger | What happens |
|------|---|---|---|
| **Cues** | LLM → you | Type normally | Words with alternatives are dimmed. Navigate and cycle. |
| **Blanks** | you → system | Text containing `_` | A keyword next to `_` auto-populates from external state (volume, stocks…); a free-form lookup phrase next to `_` is answered by an LLM (`capital of france _`). |

The two surfaces have fundamentally different contracts — see `concept.md` at the repo root for the canonical writeup.

```
┌──────────────────────────────────────────────────────────────────┐
│  USER  (typing in Claude Code, OpenCode, or Chrome)              │
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
│  DynDefs · SpanFillState · TS blanks (HN, Stocks, Weather, …)  │
└──────────────────────────────────┬───────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  @opencues/core  (pure TypeScript — the brain)                   │
│  CueResolver · RoutedWordSourceGroup · BlankSource · FluidBlankSource     │
│  ConfigSource · SpellingSource · parsers (CUES.md, …)        │
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

- Configured in `cues/` folders or `CUES.md`
- LLM prompt determines what kind of alternatives are returned (synonyms, antonyms, style variants)
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

### 2. Fluid Blank (free-form `_` lookup)

Type `_` next to any natural-language lookup phrase and `FluidBlankSource` figures out the question, wipes the right span, and substitutes the answer. Two-pass pipeline: P1 SEGMENT identifies the lookup span, P3 ANSWER produces the canonical short answer. Works for math, factual, translation, unit conversion, codes, etc — no per-mode classifier needed.

Examples:
- `4 * 12 = _` → `48`
- `capital of France _` → `Paris`
- `unicode for em dash _` → `U+2014`
- `100 celsius in fahrenheit _` → `212`

Opt-in via `fluid-blank-mode: on` in `OPENCUES.md`. Slots already claimed by a keyword-bound blank (next section) win first — fluid only fires on unbound `_`.

```
USER TYPES
──────────────────────────────────────────────
  "the capital of France is _"

  state: { blanks: [5] }   ← _ at word index 5

  ... 300ms pause (or instant if `_` was just typed) ...
                        │
                        ▼
P1 SEGMENT
──────────────────────────────────────────────
  BlankSource → no keyword match → pass
  FluidBlankSource → P1: SPAN=the capital of France is _
  P3 ANSWER → LLM returns: "Paris"

                        │
                        ▼
FILLED
──────────────────────────────────────────────
  "the capital of France is [Paris]"
                              ~~~~~   ← dimmed

  state: { alts[5]: ["Paris"] }

  Single answer — no cycling. Navigate away to keep typing.
```

---

### 3. Keyword-Bound Blank (external state)

Type a keyword adjacent to `_` and `BlankSource` claims the slot, auto-populating it with a live value from a script or runtime class. Up/Down cycles the value and writes back via `blankScript set <value>` or `blankInvoke({action: 'set', ...})`. The script always receives and returns plain numbers — display formatting (like `%`) is handled by the `blankSuffix` config field.

Multiple keyword occurrences in the same input are handled correctly — the keyword nearest to `_` is used, so `spanish weather 15°C is warmer than london weather _` finds the second "weather".

Config fields: `blankKeywords`, `blankStep`, `blankSuffix`, `blankAutoPopulate`, `blankScript`, `blankReadOnly`, `blankProximity`. See `concept.md` § "What can be built" and `docs/guides/adding-a-cue-blank.md`.

```
USER TYPES
──────────────────────────────────────────────
  "volume _"

  BlankSource:
    "volume" is adjacent to _ → matched
    blankSuffix: %

  Reads: blanks/volume/state.txt → "50"
  displayValue = "50" + "%" = "50%"
                        │
                        ▼
AUTO-POPULATED
──────────────────────────────────────────────
  "volume [50%]"
           ~~~~   ← dimmed

  state: {
    alts[1]: ["50%"],
    metadata[1]: { blankName: "volume", blankStep: 6, blankSuffix: "%" }
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
    _blankValues: { volume: 56 }
  }

  Up → 62% → 68% ...   Down → 62% → 56% → 50% → floor: 0%
```

---

### 4. List Blank

A blank that cycles through an ordered list of values rather than stepping numerically. The list can be static (defined in `stepValues`) or dynamic — if the script returns multiple lines, each line becomes a cycling option.

With `blankDismissible: true`, `_` is appended as the last option. Cycling to it dismisses the blank. A dismissed blank won't re-populate until the text changes.

```
USER TYPES
──────────────────────────────────────────────
  "affirmation _"

  BlankSource:
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

### 5. Read-Only Blank (Live Data)

A blank that fetches live data from an external API but does not allow cycling. The matched keyword is passed to the script so one script can serve multiple lookups (e.g. "reddit" → RDDT → price).

Set `blankReadOnly: true` in the blank config.

```
USER TYPES
──────────────────────────────────────────────
  "Reddit stock _"

  BlankSource:
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

- **Navigation** — Ctrl+Alt+Left/Right moves between navigable words. Only words with alts, tips, or blank attribution are navigable.
- **Visual Cues** — Navigable words are dimmed. The selected word is underlined.
- **Status Line / Secondary Display** — Shows a tip (configured per blank or word) in the host's status surface (CC status bar, OC home footer, Chrome popup) when a word is selected.
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
- **Tip Priority** — When a word matches multiple tip sources, a fixed priority decides which one wins (selector > satellite > blank > cue-blank keyword > local cue > LLM).
- **Hot-Reload Config** — `.md` config files reload within ~2 seconds for native hosts (CC, OC). Chrome polls a content-addressable `.version` hash so `opencues sync chrome --watch` propagates edits into already-open tabs in the same window. No restart needed.

---

## Config Files

Lives at `~/.cues/` (user-level) and optionally `<cwd>/.cues/` (project-level — merged on top for native hosts; explicitly opt-in for Chrome via `opencues sync chrome --include`).

```
~/.cues/
├── OPENCUES.md     — System settings (voice-mode, tips-mode, debug-mode, cursor-navigate, opt-in flags)
├── CUES.md         — Tips (## Tips JSON block) + inline `### alternatives` sources + ignore list
├── cues/           — Folder-based word cue configs (grammar, legal, medical, financial)
│   └── grammar/cue.md
├── BLANKS.md       — Inline `## Blanks` JSON for keyword-bound blanks with no script (rare)
└── blanks/         — Folder-based blanks (one folder per blank)
    └── volume/
        ├── cue.md            — Config (type: blank, blankKeywords, blankStep, blankSuffix, etc.)
        ├── volume-blank.sh   — Blank script (get/set)
        └── state.txt         — Runtime state (gitignored)
```

The repo's `defaults/` directory ships the seed configs — the same files get baked into the Chrome extension at build time and copied to `~/.cues/` by `opencues seed-configs`. The repo no longer self-dogfoods via an in-tree `.cues/`.

Each cue / blank / cue or blank declares which hosts it works on (`on-host: [chrome, claude-code, …]`) so chrome doesn't try to spawn a `.sh` script and native hosts don't ignore a TS-only blank.

---

## Current Blanks

| Blank | Shape | Usage |
|---|---|---|
| Volume | Keyword-bound + step | `volume _` → `50%`, steps by 6, writes back to OS |
| Brightness | Keyword-bound + step | `brightness _` → `60%`, steps by 10 |
| Affirmations | List (dismissible) | `affirmation _` → cycles through positive affirmations |
| Stocks | Read-only (live) | `nvda _`, `Reddit stock _` → live share price (Finnhub) |
| Weather | Read-only (live) | `London weather _` → current forecast (Open-Meteo) |
| Hacker News | Dynamic list (dismissible) | `HN posts _` → live headlines from RSS feed |
| Crypto | Read-only (live) | `btc _`, `eth _` → live price (CoinGecko) |
| Countries | Read-only (live) | `population of france _` → fact (REST Countries API) |
| Dictionary | Read-only (live) | `define ephemeral _` → definition |
| OpenCues Settings | Selector + Satellite | `opencues settings _` → `<setting> <value>`; cycling writes to `OPENCUES.md` |
| Answer | Consume-all blank | Free-form Q&A (LLM round-trip) |
| Prompt Improver | Consume-all blank | Rewrites the surrounding prompt text in place |
| Fluid Blank | Free-form lookup | Any unbound `_` (e.g. `capital of france _`, `unicode for em dash _`) — handled by `FluidBlankSource`, no per-blank config required |

---

## The `opencues` CLI

Single front-door for managing every host integration. OpenCues spans three hosts with very different install models — CC patches `cli.js` via `tweakcc`, OpenCode patches a forked source tree, Chrome bundles configs into the extension. The `opencues` CLI normalizes "install / update / debug" so you don't have to remember each integration's quirks.

```
$ opencues --help

Setup:
  install <host>          Install a host integration (claude-code|opencode|chrome|--all)
  uninstall <host>        Roll back an installation
  seed-configs            Copy repo defaults into ~/.cues/
  update                  Pull, rebuild, redeploy installed integrations
  set-key <provider>      Store an API key in ~/.cues/.env
  check-keys              Verify configured API keys against provider endpoints

Authoring:
  init                    Scaffold <cwd>/.cues/ with templates
  new <kind> <name>       Scaffold a single cue / blank
  validate                Lint configs across search paths
  import <source>         Download a community config pack (gist/github/url/local)

Run / inspect:
  run <host>              Launch the patched host
  sync <host>             Bundle .cues/ into a host that doesn't auto-discover (chrome)
  which                   Print every relevant path (installs, configs, logs)
  version                 Print CLI version + per-integration versions/compat
  doctor                  Cross-host diagnostics + suggested fixes
  list                    List every defined cue / blank with source path
  show <name>             Print full config for one cue / blank by name
  edit <file>             Open ~/.cues/<file>.md in $EDITOR
  logs [--tail]           Show /tmp/opencues.log
  debug [on|off]          Toggle runtime debug-mode
  completion <shell>      Print shell completion script (bash | zsh | fish)
```

Three high-level surfaces:

**Setup** — manages installations across hosts. `install --all` sets up every detected integration in one shot; `update` pulls the repo and re-deploys to each existing install. `seed-configs` populates `~/.cues/` from the shipped `defaults/` so you start with the same `CUES.md` / `BLANKS.md` / `BLANKS.md` that ship with the project.

**Authoring** — for users *building* their own cues. `init` scaffolds a `.cues/` directory in any project. `new blank hackernews-rss` (or `new cue legal`) writes a starter file with comments. `validate` lints the configs across every search path before you start the host. `import gh:someone/cool-cues` pulls a community pack.

**Run / inspect** — day-to-day operations. `which` is the "where does X live?" answer (paths to every install, config, log, key file). `list` shows every cue/blank plus where it was loaded from (so you can see project-level overriding user-level). `show <name>` dumps one entry's full config. `doctor` walks every installation and points at fixable problems. `logs --tail` is for live debugging.

The CLI is the same whether you have one host installed or four — `opencues install --all` then `opencues update` keeps everything fresh in one command. Per-host installers (`integrations/<host>/bin/install.cjs`) still exist underneath; the CLI just orchestrates them.

---

## Stack

Two core packages + per-host integration glue:

- **`@opencues/core`** — Pure TypeScript. Parses config files, dispatches LLM requests, resolves results into per-word alternatives. No platform dependencies. *("What alternatives exist?")*
- **`@opencues/runtime`** — Host-agnostic. Owns Navigation / Cycling / BlankFill / DimRender / ConfigLoader, the per-host adapter contract, and the TS-implemented blanks (HackerNews, Stocks, Weather, PromptImprover, OpenCuesSettings, …). *("How does the user interact with those alternatives?")*

Per-host integrations (under `integrations/`):

- **`integrations/claude-code/`** — `tweakcc` patches injected into Claude Code's `cli.js` at build time
- **`integrations/opencode/`** — Patches applied to a forked OpenCode source tree (`~/opencode-cues`)
- **`integrations/chrome/`** — MV3 extension; CSS Custom Highlight API for in-page rendering; bundle hot-reload via `.version` polling

Other:

- **Groq** — Default LLM provider (fast, free tier). Swap via `GROQ_API_KEY`. Other providers configurable via `CUES.md` frontmatter.
- **Open-Meteo / Finnhub / HN RSS** — Free APIs used by the weather, stocks, and news blanks.

The CLI (`opencues …`) wraps install / sync / validate / list / seed-configs / which / update / uninstall across every host. `pnpm exec opencues install <host>` is the one-command setup.
