---
last_updated: 2026-04-03
---

# Glossary

## OpenCues

**OpenCues** — An open-source system that provides real-time guidance as you type in any text input. It mirrors how humans give non-verbal cues during conversation — nudges, indications, and context — applied to text. OpenCues works on top of any text input: LLM prompts, word processors, mobile keyboards, and more.

OpenCues has three types of interaction:

| Type | Direction | What it does | Config file |
|------|-----------|-------------|-------------|
| **Cues** | System → User | Indicates alternatives, tips, and context for words | `cues.md` + `cues/<name>/cue.md` |
| **Blanks** | User → System | User places `_` to tell the system "fill this in" | `blanks/<name>/cue.md` |
| **Cue-Blanks** | User → External | Blanks bound to a keyword that pull external state (volume, stocks) | `blanks/<name>/cue.md` |

All three share the same navigable system — you move between words and interact with them in the text input.

---

## Cues

**Cue** — The complete package: a word that OpenCues has enriched with alternatives, a tip, linked behaviour, or other functionality. When someone says "I added a cue for ultrathink," they mean the word now appears indicated and has OpenCues functionality behind it.

**Indicated Cue** — The visual signal within the text that a cue exists. For example, a word appearing dimmed signals that alternatives and other information are available. The indicated cue is what the user sees; the cue is the full data behind it.

**Alternatives** — The set of values a word can be replaced with when the user cycles (e.g., "happy" → "sad", "excited", "content"). The original word is always at index 0.

**Cue-Tip** — Hint text displayed in the secondary display area when a word is highlighted. Provides context about what the word means or why an alternative was suggested. Sometimes shortened to "tip" in config files.

**Linked Words** — Words that must change together when any one of them cycles. For example, changing "boy" also changes "his" to "her" to maintain agreement. Part of the cues system.

**Multi-Word Group** — An alternative that consists of multiple words (e.g., "Sundar Pichai"). Tracked as a single unit that cycles together.

---

## Blanks

*"Never draw a blank."*

**Blank** — An underscore (`_`) placed by the user as a cue to the system: "fill this in." The direction is reversed compared to regular cues — the user is cueing the system, not the other way around.

Blanks are automatically computed and **re-evaluated on every edit**. When the surrounding text changes, the blank's value updates. This means a blank is never permanently filled — it can always return to `_` and be re-evaluated in its new context.

Blanks come in two flavours: **keyword-bound** (a registered keyword next to `_` claims the slot — `volume _`, `nvda _`, `define X _`) and **fluid** (no keyword match — `FluidBlankSource` segments the lookup phrase and answers it: `capital of france _` → `Paris`, `4 * 12 = _` → `48`, `unicode for em dash _` → `U+2014`).

**Think of blanks as user-placed autocomplete.** Unlike traditional autocomplete that guesses what comes next, blanks let you decide *where* the completion appears. This works anywhere — LLM prompts, documents, mobile text fields — and enables new interaction paradigms where the user and system collaborate fluidly before submission.

Defined in `blanks/<name>/cue.md` (one folder per blank).

---

## Cue-Blanks

**Cue-Blank** — A blank (`_`) that has been bound to a keyword via `blankKeywords`. When the user types a keyword adjacent to an underscore (e.g., `volume _`), the blank auto-populates with the blank's current value and Up/Down cycling changes the actual system state (calls a runtime `Blank` class or a `blankScript`). The keyword must be within `blankProximity` words of the `_` (default 0 = adjacent). All external-state interactions are `_`-gated — there is no word-cycling on plain text without `_`.

Configured in `blanks/{name}/cue.md` with `blankKeywords`, `blankStep`, `blankAutoPopulate`, `blankProximity`, `blankFormat`, `blankScript`, `blankTip`, `blankReadOnly`, `blankDismissible`, `blankSuffix`, `blankClearKeywords`, `blankClearOnEdit`, `blankConsumeAll`, and `blankConsumeContext`. Keywords can be multi-word phrases (e.g. `opencues settings` as one keyword). See `docs/features/cue-blanks.md` and `docs/guides/adding-a-cue-blank.md`.

**Blank-Bound Word** — Internal: a WordDef with `metadata.blankName` set. Indicates the position is owned by a cue-blank's auto-populated value and must not be overwritten by LLM/grammar merges. Only the user can clear it (by editing the word).

**Consume-All Blank** — A blank with `blankConsumeAll: true` that clears **all** surrounding text (not just keywords) when it auto-populates. The result is a multi-word span the user cycles through as a unit. Used when the entire input is the blank's input (e.g., a prompt to improve). Requires dedicated cycling storage because the standard WordDef array is overwritten by analysis. See `docs/features/consume-all-blanks.md`.

**Consume-Context Blank** — A blank with `blankConsumeContext: true` that clears words **between the keyword and blank** when it auto-populates, while preserving surrounding text. Used for factual lookups where context is the query and the answer replaces it (e.g., `what is the word for love in Japanese _` → `Ai`). Differs from consume-all in that text before the keyword and after the blank is kept. See `docs/features/consume-context-blanks.md`.

**Transform Blank** — A blank that accepts an **imperative instruction** and rewrites the surrounding text (or generates new content when no target exists). Triggered by inputs like `change boy to girl _`, `make this past tense _`, `translate to french _`, or — in generative mode — `write a poem _`, `compose an email _`. Implemented as `TransformBlankSource` (priority 93, between keyword-bound BlankSource at 95 and FluidBlankSource at 92). The pipeline is three passes: EXTRACT classifies and splits (instruction + target), APPLY rewrites, VERIFY checks for defects and repairs. The same source also routes agent-task commands (`agentically X _`, `add task _`, `stop task _`, `current task _`) via the TASK_ARM/ADD/STOP/SHOW verdicts. See `docs/features/transform-blank.md` and the canonical reference at `docs/architecture/transform-blank.md`.

---

## Config Files

OpenCues is configured via `.md` files in the project root. These files are the standard — all prompts, modes, and behaviour are defined here, not in code.

**cues.md** — The single top-level config file. Holds **system settings** (voice-mode, fluid-blank-mode, word-cues-mode, tips-mode, debug-mode, cursor-navigate), the nested `settings:` block (declarations for selector/satellite cycling: each setting's `tip:`, `values:`, and per-value tips), and the `ignore:` array — all in YAML frontmatter. Body is human-readable description, not parsed for cue data. Lives at user-level ONLY for the system-settings half (`~/.cues/cues.md`; overridable with `$OPENCUES_HOME`). Seeded from `defaults/cues.md` by `opencues seed-configs` and re-seeded if 0 bytes (`OpenCuesSettingsBlank` silently no-ops on empty content, which would otherwise break `opencues ___` / `config ___` blank-fills on native hosts). Cycled live by `OpenCuesSettingsBlank`. See `docs/features/selector-satellite.md` and `docs/features/tip-priority.md`.

**cues/{name}/CUE.md** — One folder per cue source. Folder name = source id. Static cues have a body JSON code block (the words map: `{"ultrathink": {"tip": "...", "alts": [...], "speak": true}}`). LLM cues declare `match:` or `keywords:` in frontmatter and put prompt text in the body. The runtime infers static-vs-LLM from data shape (no `type:` discriminator).

**blanks/{name}/BLANK.md** — One folder per blank. Defines `_`-gated cycling behaviour — script-triggered (volume, brightness), auto-populated (stock prices, weather), list (affirmations), read-only (live API values), and consume-all (prompt improver). Frontmatter holds the BlankConfig fields; scripts are colocated in the same folder. (Filename per the open standard at `spec/blank-spec.md`. Legacy `blank.md` and `cue.md` names are auto-migrated by `seed-configs`.)

**Folder-based config** — Each cue / blank is a self-contained folder: cues use `CUE.md`, blanks use `BLANK.md` (YAML frontmatter for config, body for prompt or words JSON), with optional colocated scripts. Folders in `cues/` and `blanks/` are auto-discovered.

**Host** — One of the three OpenCues integrations: `claude-code`, `opencode`, `chrome`. They share the same `.md` config format but differ in runtime capabilities. Native hosts (CC, OC) can spawn subprocesses + read the filesystem; chrome can't.

**Host Compat** — Per-entry declaration of which hosts a cue / blank runs on. Auto-detected from `script:` / `blankScript:` extension (`.sh` etc. → not chrome) and overridable via `on-host:` (allow-list) and `not-on-host:` (deny-list) frontmatter fields. Surfaced in `opencues list`, validated by `opencues validate`, used by `opencues sync chrome` to filter the bundle. See `docs/features/host-compat.md` for the full spec.

**Chrome Sync** — `opencues sync chrome` bundles `.cues/` configs into the browser extension's `dist/configs/`. Unlike the native hosts (which merge `~/.cues/` + `<cwd>/.cues/` automatically), chrome defaults to **user-level only** — projects are opted in with `--include <path>` (repeatable) or `--project`. Rationale: chrome is a global browser extension with no cwd, so inheriting cwd-based project discovery causes long-running `--watch` processes to bind to the wrong directory. Full spec: `docs/features/chrome-sync.md`.

---

## Cue Sources

A **cue source** is anything that provides alternatives for words. All cue sources implement the `CueSource` interface (`id`, `priority`, `supports()`, `getCues()`).

**Local Cues** — Alternatives computed locally on your machine, returning near-instantly (~0ms). The tips file is a local cue source — it provides both alternatives and cue-tips. In code: `LocalCueSource`.

**Remote Cues** — Alternatives computed externally using an LLM (~200-500ms). Each `cues/<name>/cue.md` (or `blanks/<name>/cue.md`) becomes a config-driven source that sends a prompt to the LLM and parses the response. In code: `ConfigSource`.

**BlankSource** — Keyword-bound blank dispatcher. Watches every `_` and claims the slot when any registered blank's `blankKeywords` matches a phrase within `blankProximity` words of the `_`. Auto-populates with the blank's current value via `blankScript get` or runtime-class `blankInvoke`. Up/Down cycling writes back. Priority 95 (above fluid-blank).

**TransformBlankSource** — Imperative-instruction `_` source. Three-pass pipeline (EXTRACT → APPLY → VERIFY) plus a generative branch when the input has no target ("write a poem _"). Also routes agent-task commands via TASK_* verdicts. Priority 93 — between keyword-bound `BlankSource` (95) and `FluidBlankSource` (92). When `supports()` runs, it cedes to any keyword-bound match before claiming. See `docs/features/transform-blank.md`.

**FluidBlankSource** — Free-form `_` lookup. Two-pass pipeline: P1 SEGMENT identifies the lookup span, P3 ANSWER produces the canonical short answer. Handles math, factual, translation, unit conversion, codes, etc. without per-mode classification. Fires on `_` slots that no `BlankSource` or `TransformBlankSource` claimed. Opt-in via `fluid-blank-mode: on`.

**RoutedWordSourceGroup** — Wraps multiple folder-based word-cue sources (each `cues/<name>/cue.md`) and dispatches each highlighted word to ONE child source via per-word routing. Uses fast-path rules only — no LLM classifier. Every source MUST declare `match:` (regex) or `keywords:` (list); sources without either are dropped. Words that no source claims produce no cue (not navigable). Words destined for the same source are batched into one parallel LLM call. Replaces the old "combine all sources into one giant prompt" model. See `docs/features/word-cue-routing.md`.

**Word-Cue Source** — A `parser: alternatives` source with `match:` (regex) and/or `keywords:` (comma-separated list). Only fires for words that hit the regex or appear in the keyword list. Use for narrow vocabularies (legal, medical, formal connectors). Higher priority wins ties. Catch-all sources (no match, no keywords) are not supported — declare an explicit `match: .*` if you really want one.

**buildSourcesFromConfig** — Factory function that takes parsed `cues.md` plus discovered `cues/<name>/cue.md` and `blanks/<name>/cue.md` folders and returns `CueSource[]`. Wires:
- **Word cues**: Each `cues/<name>/cue.md` becomes a `ConfigSource`; all of them wrap into ONE `RoutedWordSourceGroup` that dispatches per-word.
- **Blanks**: Keyword-bound entries from `blanks/<name>/cue.md` register with `BlankSource` (priority 95). `FluidBlankSource` (priority 92) catches unbound `_`. The shipped `defaults/cues/spelling.md` cue (priority 80) flags misspelled words on plain text — same `ConfigSource` path as legal/medical/etc.

> **Terminology note**: "cue source" is the general concept. `CueSource` is the TypeScript interface. `ConfigSource` and `LocalCueSource` are specific implementations.

---

## Response Parsers

How LLM responses are interpreted. Set via `parser` field in `.md` config. See `docs/guides/parser-types.md` for full details with examples.

**alternatives** — Parses `INDEX:alt1,alt2,alt3` format. Default parser. Used for word alternatives and grammar blanks.

**compute** — Extracts `COMPUTE=expression` and evaluates as JavaScript math. Used for math blanks.

**answer** — Extracts `ANSWER=value` as a single result. Used for factual blanks.

**raw** — Uses the full LLM response verbatim as one alternative.

> **Terminology note**: "Response parser" refers to these four LLM output formats. `parseCuesMd()` is the config file parser — a different thing.

---

## Display

**Secondary Display** — Where additional information (cue-tips) is shown. It is not in the text input box. The integration decides what this is — a status bar, tooltip, hover panel, sidebar, etc.
