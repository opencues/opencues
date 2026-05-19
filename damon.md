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

> **★ NEW this week:** **Sentence Cues** (§ 21) extend the cue surface from word-scope to whole sentences (`scope: sentence`); **Fluid Config** (§ 20) adds a new flavour of `_`-blank that routes natural-language settings phrasing to OPENCUES.md; **Blank Trigger Mode** (§ 17) makes `_` markdown-friendly. See the *Updates — May 2026 (week 3)* section near the bottom for details.

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

---

## Updates — May 2026

A lot has landed since the last pass. Headline changes:

- **A fourth host**: Gemini CLI joined CC, OC, and Chrome.
- **A new cue type**: Transform Blank — imperative in-place rewrites driven from `_`.
- **A third surface**: Auditors — buffer-wide rewrite concerns (grammar, clarity, tone) running in parallel with diff-merge.
- **A capability model**: third-party blanks can ship as TypeScript with declared `network:` / `llm:` / `secrets:` permissions, gated by `opencues review`.
- **Chrome got a native-messaging host**: live `~/.cues/` sync into open tabs, subprocess blanks (`volume _`, `brightness _`), and mid-session API-key swaps with no reload.

---

### 6. Transform Blank (imperative rewrite)

Same `_` trigger, opposite direction from FluidBlank. Instead of asking a question and getting an answer, you give an instruction and the surrounding text gets rewritten in place. The `_` slot is bidirectional now — lookup vs imperative is detected, not configured.

Examples:
- `change boy to girl _ the boy ran fast` → `the girl ran fast`
- `the cat ran home pluralize and make past tense _` → `the cats ran home`
- `remove pronouns _ the cat sat on the mat` → `sat on the mat`

Three-pass pipeline — EXTRACT (is this imperative? what's the instruction span?) → APPLY (rewrite the body) → VERIFY (catch agreement bugs, partial translations, charset coverage). The 3-pass design beats one-shot by ~70pp on the benchmark; the canonical writeup is `docs/architecture/transform-blank.md` (1000+ lines including the experiment log).

Two subtleties worth knowing:

- **Cursor-aware "here"** — instructions like `add a comma here _` use a shared `[CURSOR]` sentinel passed through every pass so APPLY knows what "here" points at.
- **Claim-and-bail** — if EXTRACT verdicts an instruction but APPLY can't apply it, TransformBlank still *claims* the slot. Without this, FluidBlank would try to treat the instruction phrase as a free-form lookup and vandalise the input.

---

### 7. Auditors — buffer-wide rewrite concerns

Auditors are the third surface (cues, blanks, auditors). Each auditor is a single concern — grammar, clarity, tone, PII removal — that runs whenever an agentic rewrite fires. Configured the same way as a cue, in `~/.cues/auditors/<name>/AUDITOR.md`, with a priority and a prompt body.

```yaml
---
name: grammar
description: Fix grammar and style errors
priority: 50
---
Check for grammar errors. Fix subject-verb disagreement, comma
splices, dropped articles. Preserve voice and intentional fragments.
```

**Isolated dispatch by default.** One LLM call per auditor, fired in parallel, results diff-merged by priority — highest priority wins on overlapping spans. Total latency is `max(N)` not `sum(N)`, and the per-item dispatch property (same one that makes word-routing safe) means one auditor's prompt body can't steer the LLM calls for other auditors. No cross-auditor injection.

Two-tier cache fronts every call: a skip-on-stable check (no LLM round-trip if the buffer hasn't changed since the last rewrite) plus an LRU on `(snapshot, task, cursor, windowWords, auditorSignature)`. Canonical doc: `docs/architecture/agent-rewrite-cache.md`.

---

### 8. User-blanks (capability-gated TypeScript)

Authors can now ship custom blanks as TypeScript/JavaScript modules. The runtime loads them in a constrained context — `vm.Context` on Node, Web Worker on Chrome — and grants only the capabilities the blank declares in its frontmatter.

```yaml
---
name: gh-issues
blankKeywords: [gh]
network: [api.github.com]
secrets: [GITHUB_TOKEN]
secret-hosts:
  GITHUB_TOKEN: [api.github.com]
storage: gh-issues
---
```

```js
export default {
  async get(ctx, args) {
    const repo = args[1] ?? 'opencues/opencues';
    const r = await ctx.fetch(`https://api.github.com/repos/${repo}`);
    return `${(await r.json()).open_issues_count} open`;
  }
};
```

User types `gh opencues/opencues _` → API hit → answer injected.

The interesting work is in the **capability model**, not the loader:

- **Secret host-binding** — every named secret MUST declare which hosts it can be sent to. The runtime scans every outbound request body + headers for bound secrets; if `GITHUB_TOKEN` shows up in a fetch to anywhere other than `api.github.com`, the call is refused. Exfil is structurally blocked even if the JS is malicious.
- **Output sanitization by default** — HTML, zero-width chars, bidi overrides stripped. Opt-in `output: rich` for legitimate markdown/emoji.
- **OS sandbox for shell-script blanks** — `bwrap` confines `.sh`-backed blanks on Linux; mac sandbox-exec equivalent. Opt-in, off-by-default to keep the warm path warm; see `docs/architecture/sandbox.md`.

The built-in Stocks / Weather / Answer / PromptImprover blanks were migrated onto this format too — they're now user-blanks with the same capability declarations every third-party blank uses. Canonical writeup: `docs/architecture/user-blanks.md`.

---

### 9. `opencues review` — pre-install pack audit

Reviewing a third-party cue pack before it lands in `~/.cues/`:

```
$ opencues review ~/downloaded-pack.zip [--llm]
```

Two layers, both run in a sandbox:

- **Static (always)** — secrets without `secret-hosts` bindings (error), `network:` wildcards / IPs (error), `output: rich` (warn), AST-level pattern checks for `eval` / `Function` / dynamic `import()` after stripping comments + strings. Static checks are authoritative.
- **LLM (opt-in)** — text-in/text-out only, no tool use, untrusted source wrapped in XML delimiters, strict-JSON schema, malformed → fail. The LLM can downgrade severity but cannot upgrade past a static verdict.

Surfaces every finding with file:line, capability summary, and a one-line "what this blank would be allowed to do if installed." Threat model lives in `docs/architecture/security-audit.md`.

---

### 10. Universal Integration profile (no-cycling hosts)

Some hosts can't paint colour or intercept Ctrl+Alt+Arrow — Chrome's normal `<input>` / `<textarea>` is the live example today (vs. contenteditable, where the highlight overlay does work). The adapter advertises `supportsCycling: false`, and every cycleable cue or blank is filtered out at registration: word-cues, selector/satellite blanks, list blanks, anything script-backed (`volume`, `brightness`).

The check is **structural, not annotation-driven** — `isBlankConfigCycleable` reads each definition's shape, so blank authors don't need to add `on-host: …` lists. Read-only blanks (stocks, weather, dictionary) keep firing because they don't need cycling. FluidBlank and TransformBlank keep firing because their result is single-shot.

Two filter points (resolver-side and BlankFill-side) live in different files and MUST stay in sync — the canonical doc (`docs/architecture/universal-integration.md`) is the contract.

Chrome additionally **refuses sensitive inputs** — `autocomplete="current-password"`, names containing `password` / `cvv` / `ssn`, and a `type` allowlist (text/email/search/url only). Errs toward blocking: false positives lose OpenCues for that input; false negatives would leak credentials through the LLM.

---

### 11. Chrome native-messaging host

Chrome now has an optional local daemon (`opencues install chrome-host`) that does two things the extension sandbox can't:

- **Live `~/.cues/` sync.** Filesystem watch → framed JSON over native-messaging → `chrome.storage.local.set` → `onChanged` broadcast → every open tab reloads config. ~300ms end-to-end. The bake-time bundle is still the fallback if the host isn't installed.
- **Subprocess execution.** Script-backed blanks (`volume _`, `brightness _`, anything with `blankScript: ./x.sh`) work in Chrome by routing through the host. Path-confined to `~/.cues/` — absolute paths outside `CUE_ROOT` are refused.

Bonus: **API keys are now mutable mid-session.** `BootResult.updateApiKeys` lets the host push fresh keys into a running tab without a reload — the runtime live-mutates `Resolver.options.apiKeys` and re-audits providers. Useful when you rotate Groq / OpenAI / Anthropic keys mid-flow. The boot-time path also probes every configured provider once and surfaces missing/typo'd keys as a single warning instead of silently failing on the next analysis pulse. Canonical doc: `docs/architecture/chrome-llm-keys.md`.

---

### 12. Site scoping + Chrome trust gate

Two related additions on the "where does this cue fire?" axis.

**Site scoping** — any cue, blank, or auditor can declare an `on-site:` / `not-on-site:` list. Entries can be platform names (`chrome`, `claude-code`), hostnames (`reddit.com`), wildcards (`*.reddit.com`), or hostname + path prefix (`reddit.com/r/claudeai`). `not-on-site` is checked first; if `on-site` is non-empty, at least one entry must match. Native hosts have null hostname/path, so platform-name entries still match while hostname-only entries cleanly drop.

```yaml
on-site: [chrome, reddit.com/r/claudeai]
not-on-site: [twitter.com, *.evil.example]
```

SPA navigation re-runs the filter via `popstate` + monkey-patched `pushState` / `replaceState`, so route changes inside Gmail / Slack / Linear don't strand a cue that should have unloaded.

**Trust gate** — Chrome refuses to run cue packs from origins the user hasn't explicitly trusted. First time a pack appears, the popup prompts; trust is stored per-origin. Combined with the capability model + `opencues review`, the three layers cover: *can I read the code*, *what is the code allowed to do*, *do I trust this source at all*.

---

### 13. Markdown inline rendering

LLM-substituted text gets light markdown styling rendered inline — `**bold**`, `*italic*`, `` `code` ``, `~~strike~~`, `# heading`, `- list`. ANSI on terminals (CC, OC, gemini-cli), CSS Custom Highlight ranges on Chrome. The buffer keeps the raw markdown; the styling is overlay metadata.

Parse-once cache: the parser runs only when the LLM lands new text (blank fill, transform completed, agent rewrite tick). User typing invalidates the cache; runtime cycling and ZWS toggles don't. Ranges include the markers themselves so the renderer can dim the `*` in `*italic*` rather than hide it.

Blank-slot suppression: `_` characters inside a pending italic/code/strike span are stripped from the styling so an in-flight blank animation doesn't accidentally trigger markdown markup.

---

### 14. Blank loading animation

While a `_` is waiting for its source (LLM round-trip, HTTP fetch), the slot animates. Default braille-rotate plays `_` once and then spins through `⠁⠂⠄⡀⢀⠠⠐⠈`. Bounce, flipper, and arbitrary custom frames are also available.

Configured per-host via `~/.cues/OPENCUES.md`:

```
blank-loading-animation: bounce | braille-rotate | flipper | custom | off
blank-loading-colors-rgb: #ef4444,#f97316,#22c55e,#06b6d4,#3b82f6
blank-loading-colors-ansi: red,amber,green,cyan,blue
blank-loading-interval-ms: 150
```

Per-frame colours cycle through the palette. Hot-reloadable within ~2s — animations in flight keep their captured interval; the next frame reads the fresh palette. Malformed colours fall back to the shipped defaults instead of breaking the animation.

---

### 15. Strict JSON mode for LLMs

Groq's `gpt-oss-20b` / `gpt-oss-120b` support constrained-decoding for structured outputs. We now use it across every prompt-parsing surface: TransformBlank (P1 / APPLY / VERIFY), FluidBlank (SEGMENT / ANSWER), WordCues (alternatives / raw), AgentRewrite. JSON schema is enforced server-side; parse errors basically vanish.

A single `useStrictJson(provider, model)` gate decides per-call. Non-Groq providers (Claude, Gemini, OpenRouter) still go through the legacy label-based parsers (`REWRITE: …`, `ANSWER: …`) — backward compatible, no migration needed.

Eliminated failure classes: missing prefix tokens, preamble leakage (`"Sure, here's …"`), refusals smuggled as content.

---

### 16. Gemini CLI integration (4th host)

OpenCues now patches Google's Gemini CLI (`0.41.x`) the same way it patches OpenCode — fork the source, apply patches, build. `opencues run gemini-cli` launches the patched host with full cues/blanks/transform/auditors. Setup is idempotent (substring-anchored patches survive minor version bumps).

Gemini CLI is the **first React/Ink host** in the lineup, and the integration uncovered two non-obvious things worth pinning here:

- **Render-kick from every wrapped setter.** React only re-renders on state change. Every wrapped `setText` / `setCursor` / `pushText` / `forceRender` MUST call `host.forceRender?.()` to bump a useState tick. Without it, the UI freezes mid-operation and only un-freezes when the user moves the cursor.
- **Code-point ↔ UTF-16 cursor conversion.** Gemini's buffer indexes by Unicode code points; OpenCues indexes by UTF-16 code units. Boundary conversions at every seam — without them, a single emoji in the input drifts every highlight by one position.

Adding a fifth host now mostly means handling whatever the host's own quirks are; the host-agnostic contract has held.

---

### Other notable improvements

- **`opencues review` + capability model + sandboxes** form a security baseline that lets third-party blanks ship without each user reading the code. The threat model + remaining follow-ups are tracked in `docs/architecture/security-audit.md`.
- **`opencues doctor` and `opencues check-keys`** now probe every supported provider (was: Groq + Finnhub only), surface install drift across hosts, and detect the chrome native-messaging host.
- **`seed-configs` got a SHIPPED-MD REFRESH phase** so updates to the shipped defaults overlay onto user values without clobbering customisations.
- **`blankReplace` unified field** (`keep` / `wipe` / `wipe-all` / `auto`) replaces the older per-blank patchwork. `auto` runs a deterministic copula/equation/question heuristic — see `docs/architecture/blank-replace-modes.md`.
- **AgentRewrite two-tier cache** — skip-on-stable + LRU keyed on `(snapshot, task, cursor, windowWords, auditorSignature)` — keeps the agentic rewrite path warm. `docs/architecture/agent-rewrite-cache.md`.

---

## Updates — May 2026 (week 3)

A second wave landed since the May write-up above. **★ NEW** highlights — three features any user will notice:

- **★ NEW · Sentence Cues** — cues can now operate on whole sentences (`scope: sentence`), not just words. Cycle through alternative phrasings of the highlighted sentence. First shipped cue: `more-formal` (informal → formal rewrites). § 21.
- **★ NEW · Fluid Config** — type natural English next to `_` to flip OpenCues settings: `enable debug logging _` flips `debug-mode: on` and pre-populates the standard settings menu. § 20.
- **★ NEW · Blank Trigger Mode** — `blank-trigger-mode: spaced` makes `_` defer firing until followed by a space, so markdown `_italic_` works without first `_` auto-substituting. § 17.

Plus infrastructure that supports them:

- **Feature registry as single source of truth** — adding any new OPENCUES.md scalar is now a one-PR change. § 18.
- **Thinking-budget bench + per-provider reasoning/max_tokens pairing** — measured how much reasoning each provider can afford on each pipeline; production routing tunes both knobs together per provider. § 19.

---

### 17. ★ NEW · Blank trigger mode — `_italic_` markdown friendly

Adding `blank-trigger-mode: spaced` to OPENCUES.md tells the runtime to defer firing a blank until `_` is followed by a space. Markdown italics (`_italic_`) typists can keep their formatting habits without the first `_` immediately substituting.

```yaml
# ~/.cues/OPENCUES.md
blank-trigger-mode: spaced       # markdown-friendly (no auto-fire on bare `_`)
blank-trigger-mode: immediate    # default — fires on insertion (v0.1 behaviour)
```

Cycleable from the OpenCues settings cue-blank (`opencues settings _` → cycle to `blank-trigger-mode` → cycle satellite to `spaced`). User-facing summary: `docs/features/blank-trigger-mode.md`.

---

### 18. Feature registry — single source of truth for optional features

Every OpenCues feature gated on an OPENCUES.md scalar (voice-mode, debug-mode, fluid-blank-mode, transform-blank-mode, …) used to require coordinated edits across four files (parser + chrome-host file-push + doctor wiring + seed-configs templates). Drift between them produced silent "feature looks shipped but is inert" bugs.

Now there's a single `FEATURES` registry at `packages/opencues-core/src/feature-registry.ts`. Every consumer (parser, doctor, host.cjs, seed-configs) iterates the registry instead of hardcoding its own copy. **Adding a feature is one PR appending one entry.** Three more registries follow the same pattern: `MENU_TUNABLES` for numeric/glyph settings (`agent-debounce-ms`, `blank-loading-animation`), `BUILTIN_BLANKS` for shipped blank classes, and `CORE_CONFIG_FILES` for the always-on config files.

The drift-prevention test suite (71 tests across 6 files) catches anything that bypasses the registry. Canonical writeup: `docs/architecture/feature-registry.md`.

---

### 19. Thinking-budget bench + paired reasoning / max_tokens per provider

A new bench at `tests/benchmarks/thinking-budget/` answers "how much reasoning can each provider afford before per-case latency exceeds OpenCues's use-case threshold?" 40-case fluid-blank stride sample × 4 providers × 4 reasoning levels.

Output: a per-provider × per-reasoning-level latency + accuracy grid that pinpoints the **knee** — the max reasoning each provider supports while staying under each pipeline's target (word-cue 500ms, fluid-blank 1500ms, transform 1000ms).

The grid uncovered a deceptive failure mode: `reasoning: high` on gpt-oss-120b looked catastrophic (98% → 20% accuracy) under the default 512-token budget. Re-running with `MAX_TOKENS=2048` recovered to 95-98% — the reasoning tokens were starving the output budget, not the model failing. Production now pairs per-provider reasoning defaults with proportional max_tokens (commit `132fd3d`):

```
groq, cerebras, openai → reasoning: low + max_tokens 512
                          reasoning: medium + max_tokens 1024
                          reasoning: high + max_tokens 2048
```

**Headline finding:** Cerebras is the only provider that hits all three pipelines green with `medium` reasoning enabled (244-358ms p50). It's also the only one that fits the word-cue 500ms budget AT ALL with reasoning beyond `none`. The throughput advantage that was "nice-to-have" is structurally load-bearing for any feature that needs reasoning on the inline word-cue surface.

Full matrix + cross-bench landing page now at `tests/benchmarks/BENCHMARKS.md`. Bench source: `tests/benchmarks/thinking-budget/run.ts`.

---

### 20. ★ NEW · Fluid Config — semantic `_` → settings change

A new optional source (`fluid-config-mode: on`) at priority 94 that classifies a `_` against the FEATURES registry when no keyword matched. Type `enable debug logging _` and OpenCues flips `debug-mode: on` in OPENCUES.md, wipes the summon words, and leaves the standard `opencues settings _` selector-satellite menu pre-positioned at the now-current state. Backspace deletes the satellite pair as one span (`clearOnEdit: true`).

```
You type:        "stop showing tip popups _"
You see:          tips-mode off              ← satellite cycling active here
OPENCUES.md gets: tips-mode: off
```

Five examples that work:

| You type | Buffer becomes | OPENCUES.md changes |
|---|---|---|
| `enable debug logging _` | `debug-mode on` | `debug-mode: on` |
| `stop showing tip popups _` | `tips-mode off` | `tips-mode: off` |
| `I want to hear the tips read aloud _` | `voice-mode active` | `voice-mode: active` |
| `let it use my personal info _` | `user-context-mode safe` | `user-context-mode: safe` |
| `make blanks wait for a space before firing _` | `blank-trigger-mode spaced` | `blank-trigger-mode: spaced` |

**Trust boundary** — and the design's load-bearing decision — is that the classifier routes ONLY to FEATURES registry scalars, NEVER to user blanks (volume / brightness / weather / stocks / etc.). User blanks can shell out, fetch, or exec; auto-applying them from semantic intent would widen the prompt-injection blast radius. FEATURES scalars have bounded enum codomains; flipping one cannot exec or fetch. Three structural defences enforce this: (a) classifier prompt only enumerates registry-cyclable values, (b) runtime `validateAgainstRegistry` rejects unknown setting / unlisted value / `exposeInMenu: false` footgun modes, (c) apply path reuses the same `applyOpenCuesScalar` (write + 2.5s reload-suppression) the satellite cycling has used since v0.1.

Bench: `tests/benchmarks/fluid-config/` validated v2.1 prompt across 5 providers — **100% precision** (210 reject decisions, zero false positives) + **90-100% holdout recall**. User-facing summary: `docs/features/fluid-config.md`. Canonical architecture + threat model: `docs/architecture/fluid-config.md`.

---

### 21. ★ NEW · Sentence Cues — `scope: sentence` cue declarations

A cue can now declare `scope: sentence` in its CUE.md frontmatter and operate on whole sentences instead of individual words. Sentence-cues behave exactly like word-cues, just at sentence span granularity: the buffer is left alone, the sentence is marked as having alternatives, and Ctrl+Alt+Up at any word inside the sentence swaps in the next rewrite. Default priority 85 — higher than typical word-cues (60-80) so an overlapping word-cue gets suppressed outright (sentence wins). Sentence-cues cede to `_`-gated sources (BlankSource, ConfigIntent, TransformBlank, FluidBlank).

Shipped canonical cue: `defaults/cues/more-formal/CUE.md` — rewrites informal sentences to formal register.

```
You type:    "thanks a bunch for the help."     ← buffer stays exactly as typed
Ctrl+Alt+Up: "Thank you very much for your assistance."
Ctrl+Alt+Up: "I am grateful for your help."
Ctrl+Alt+Up: "Many thanks for your assistance."
Ctrl+Alt+Down → cycles back to the original.
```

Implementation: `SentenceCueSource` segments the buffer (regex-based v1), one LLM call per cue per buffer per resolve, emits one CueResult per sentence with `alternatives = [original, ...rewrites]` + char-range spans. The resolver registers a DynDef at `currentIndex: 0` (passive — the buffer continues to show the original sentence; cycling Up advances through the rewrites via the existing `applyAltCycle` path that word-cues use). Earlier May-2026 prototype builds auto-spliced `alts[1]` the moment the LLM returned — that was agent-like behaviour and was retired; sentence-cues are CUES, not agents. Multi-sentence buffers in v1 cap at one cue per resolve (v2 will batch). The resolver also drops the cue if its sentence span overlaps an active selector/satellite pair or other span-bound DynDef, so cycling never mid-overwrites a managed span.

Bench: `tests/benchmarks/sentence-cues/` validated 100% precision (CEDE on fragments / code / already-formal) + 91-100% recall across 5 providers. Same trust property as fluid-config: every reject decision rejected by every provider; only false-negative failures.

Adding a second sentence-cue (`more-concise`, `active-voice`, `plain-english`, `more-empathetic`) is one CUE.md file — no source-class changes. User-facing summary: `docs/features/sentence-cues.md`. Canonical architecture: `docs/architecture/sentence-cues.md`.

---

### Other (week 3) notable improvements

- **`FluidBlankSource` typed-hint precedence** — when a fluid-blank has both a `tip:` (typed) and a catalog-sentinel match, the typed hint now takes precedence. Closes a class of confused-output cases on user-context-aware lookups.
- **`OpenCuesSettings.set()` registry default for unset keywords** — cycling through a scalar that didn't yet exist in OPENCUES.md now appends the new key to the frontmatter rather than silently dropping the write. Pinned by `registry-persistence.drift.test.ts`.
- **vitest workspace** at the repo root — `npx vitest run` from the top-level now executes every package's suite cleanly without per-package config gymnastics. Makes the cross-package test surface coherent.
- **Cross-host repo docs catch-up** — ~30 places in the docs that said `CUES.md` when they meant `OPENCUES.md` got fixed; cross-link from `user-context` and `ambient-context` docs to the feature registry doc landed; CLAUDE.md key-references list was refreshed for the new feature surface.

---

*Last updated: 2026-05-18.*
