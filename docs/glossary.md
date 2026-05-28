---
last_updated: 2026-04-03
---

# Glossary

## OpenCues

**OpenCues** — An open-source system that provides real-time guidance as you type in any text input. It mirrors how humans give non-verbal cues during conversation — nudges, indications, and context — applied to text. OpenCues works on top of any text input: LLM prompts, word processors, mobile keyboards, and more.

OpenCues has three types of interaction:

| Type | Direction | What it does | Config file |
|------|-----------|-------------|-------------|
| **Cues** | System → User | Indicates alternatives, tips, and context for words | `CUES.md` + `cues/<name>/CUE.md` |
| **Blanks** | User → System | User places `_` to tell the system "fill this in" | `blanks/<name>/BLANK.md` |
| **Cue-Blanks** | User → External | Blanks bound to a keyword that pull external state (volume, stocks) | `blanks/<name>/BLANK.md` |

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

Defined in `blanks/<name>/BLANK.md` (one folder per blank).

---

## Cue-Blanks

**Cue-Blank** — A blank (`_`) that has been bound to a keyword via `blankKeywords`. When the user types a keyword adjacent to an underscore (e.g., `volume _`), the blank auto-populates with the blank's current value and Up/Down cycling changes the actual system state (calls a runtime `Blank` class or a `blankScript`). The keyword must be within `blankProximity` words of the `_` (default 0 = adjacent). All external-state interactions are `_`-gated — there is no word-cycling on plain text without `_`.

Configured in `blanks/{name}/BLANK.md` with `blankKeywords`, `blankStep`, `blankAutoPopulate`, `blankProximity`, `blankFormat`, `blankScript`, `blankTip`, `blankReadOnly`, `blankDismissible`, `blankSuffix`, `blankClearKeywords`, `blankClearOnEdit`, `blankConsumeAll`, and `blankConsumeContext`. Keywords can be multi-word phrases (e.g. `opencues settings` as one keyword). See `docs/features/cue-blanks.md` and `docs/guides/adding-a-cue-blank.md`.

**Blank-Bound Word** — Internal: a WordDef with `metadata.blankName` set. Indicates the position is owned by a cue-blank's auto-populated value and must not be overwritten by LLM/grammar merges. Only the user can clear it (by editing the word).

**Consume-All Blank** — A blank with `blankConsumeAll: true` that clears **all** surrounding text (not just keywords) when it auto-populates. The result is a multi-word span the user cycles through as a unit. Used when the entire input is the blank's input (e.g., a prompt to improve). Requires dedicated cycling storage because the standard WordDef array is overwritten by analysis. See `docs/features/consume-all-blanks.md`.

**Consume-Context Blank** — A blank with `blankConsumeContext: true` that clears words **between the keyword and blank** when it auto-populates, while preserving surrounding text. Used for factual lookups where context is the query and the answer replaces it (e.g., `what is the word for love in Japanese _` → `Ai`). Differs from consume-all in that text before the keyword and after the blank is kept. See `docs/features/consume-context-blanks.md`.

**Transform Blank** — A blank that accepts an **imperative instruction** and rewrites the surrounding text (or generates new content when no target exists). Triggered by inputs like `change boy to girl _`, `make this past tense _`, `translate to french _`, or — in generative mode — `write a poem _`, `compose an email _`. Implemented as `TransformBlankSource` (priority 93, between keyword-bound BlankSource at 95 and FluidBlankSource at 92). The pipeline is three passes: EXTRACT classifies and splits (instruction + target), APPLY rewrites, VERIFY checks for defects and repairs. The same source also routes agent-task commands (`agentically X _`, `add task _`, `stop task _`, `current task _`) via the TASK_ARM/ADD/STOP/SHOW verdicts. See `docs/features/transform-blank.md` and the canonical reference at `docs/architecture/transform-blank.md`.

---

## Config Files

OpenCues is configured via `.md` files in the project root. These files are the standard — all prompts, modes, and behaviour are defined here, not in code.

**OPENCUES.md** — The runtime system-settings file (user-level only — projects can't override). Holds scalars like `voice-mode`, `fluid-blank-mode`, `word-cues-mode`, `tips-mode`, `debug-mode`, `cursor-navigate`, `blank-trigger-mode`, `llm-provider`, plus numeric tunables (`agent-debounce-ms`, `max-concurrent-auditors`, …) — all in YAML frontmatter. Schema declared in `@opencues/core`'s `FEATURES` + `MENU_TUNABLES` registry. Body is human-readable description, not parsed. Lives at `~/.cues/OPENCUES.md` (overridable with `$OPENCUES_HOME`). Canonical filename exported as `CORE_SETTINGS_FILE`. Seeded from `defaults/OPENCUES.md` by `opencues seed-configs` and re-seeded if 0 bytes. Cycled live by `OpenCuesSettingsBlank`. See `docs/features/selector-satellite.md` and `docs/architecture/feature-registry.md`.

**CUES.md** — The cue master config (cue source declarations + project metadata). Frontmatter has `name` / `domain` / `version`. Body has `## Tips` (static word tips), `## Ignore` (words the runtime never suggests alts for), and `## Prompt` with `### <source-name>` LLM-backed cue sources. Lives at user-level (`~/.cues/CUES.md`) OR project-level (`<cwd>/.cues/CUES.md`); project wins on name conflicts. Parsed via `parseCuesMd` → wrapped in `RoutedWordSourceGroup`. **Does NOT carry runtime system settings** — those are in OPENCUES.md (despite the similar name). A pre-2026 design plan to merge the two files was abandoned.

**cues/{name}/CUE.md** — One folder per cue source. Folder name = source id. Static cues have a body JSON code block (the words map: `{"ultrathink": {"tip": "...", "alts": [...], "speak": true}}`). LLM cues declare `match:` or `keywords:` in frontmatter and put prompt text in the body. The runtime infers static-vs-LLM from data shape (no `type:` discriminator).

**blanks/{name}/BLANK.md** — One folder per blank. Defines `_`-gated cycling behaviour — script-triggered (volume, brightness), auto-populated (stock prices, weather), list (affirmations), read-only (live API values), and consume-all (prompt improver). Frontmatter holds the BlankConfig fields; scripts are colocated in the same folder. (Filename per the open standard at `spec/blank-spec.md`. Legacy `blank.md` and `cue.md` names are auto-migrated by `seed-configs`.)

**Folder-based config** — Each cue / blank is a self-contained folder: cues use `CUE.md`, blanks use `BLANK.md` (YAML frontmatter for config, body for prompt or words JSON), with optional colocated scripts. Folders in `cues/` and `blanks/` are auto-discovered.

**Host** — One of the OpenCues integrations: `claude-code`, `opencode`, `chrome`, `gemini-cli`. They share the same `.md` config format. Native hosts (CC, OC, gemini-cli) can spawn subprocesses + read the filesystem unconditionally. Chrome can too, but only when chrome-host (the native-messaging bridge) is installed — so chrome's spawn capability is runtime-detected, not a static property.

**Host Compat** — Per-entry declaration of which hosts a cue / blank runs on. Default: every entry advertises as compatible with every host; the runtime fails at runtime if the host genuinely can't fulfil the call (exit 127). Override via `on-host:` (allow-list) and `not-on-host:` (deny-list) frontmatter fields. Surfaced in `opencues list`, validated by `opencues validate`, used by `opencues sync chrome` to filter the bundle. See `docs/features/host-compat.md` for the full spec.

**Chrome Sync** — `opencues sync chrome` bundles `.cues/` configs into the browser extension's `dist/configs/`. Unlike the native hosts (which merge `~/.cues/` + `<cwd>/.cues/` automatically), chrome defaults to **user-level only** — projects are opted in with `--include <path>` (repeatable) or `--project`. Rationale: chrome is a global browser extension with no cwd, so inheriting cwd-based project discovery causes long-running `--watch` processes to bind to the wrong directory. Full spec: `docs/features/chrome-sync.md`.

---

## Cue Sources

A **cue source** is anything that provides alternatives for words. All cue sources implement the `CueSource` interface (`id`, `priority`, `supports()`, `getCues()`).

**Local Cues** — Alternatives computed locally on your machine, returning near-instantly (~0ms). The tips file is a local cue source — it provides both alternatives and cue-tips. In code: `LocalCueSource`.

**Remote Cues** — Alternatives computed externally using an LLM (~200-500ms). Each `cues/<name>/CUE.md` (or `blanks/<name>/BLANK.md`) becomes a config-driven source that sends a prompt to the LLM and parses the response. In code: `ConfigSource`.

**BlankSource** — Keyword-bound blank dispatcher. Watches every `_` and claims the slot when any registered blank's `blankKeywords` matches a phrase within `blankProximity` words of the `_`. Auto-populates with the blank's current value via `blankScript get` or runtime-class `blankInvoke`. Up/Down cycling writes back. Priority 95 (above fluid-blank).

**TransformBlankSource** — Imperative-instruction `_` source. Three-pass pipeline (EXTRACT → APPLY → VERIFY) plus a generative branch when the input has no target ("write a poem _"). Also routes agent-task commands via TASK_* verdicts. Priority 93 — between keyword-bound `BlankSource` (95) and `FluidBlankSource` (92). When `supports()` runs, it cedes to any keyword-bound match before claiming. See `docs/features/transform-blank.md`.

**FluidBlankSource** — Free-form `_` lookup. Single FUSED LLM call emits both SPAN and ANSWER in one breath; the call also optionally receives sanitized ambient field metadata (when `ambient-context-mode: on`) so the segmenter can use the field's label as the question source for meta-triggers like `_` / `answer _`. Also optionally receives user-context (when `user-context-mode: safe` or `: raw`) — `~/.cues/USER.md` frontmatter as a catalog of sentinel tokens (`[FIRST NAME]`, `[EMAIL]`, etc.) so lookups personalise; a runtime post-processor substitutes real values after the LLM responds (safe mode keeps PII off the provider's logs). Handles math, factual, translation, unit conversion, codes, etc. without per-mode classification. Fires on `_` slots that no `BlankSource` or `TransformBlankSource` claimed. Opt-in via `fluid-blank-mode: on`.

**RoutedWordSourceGroup** — Wraps multiple folder-based word-cue sources (each `cues/<name>/CUE.md`) and dispatches each highlighted word to ONE child source via per-word routing. Uses fast-path rules only — no LLM classifier. Every source MUST declare `match:` (regex) or `keywords:` (list); sources without either are dropped. Words that no source claims produce no cue (not navigable). Words destined for the same source are batched into one parallel LLM call. Replaces the old "combine all sources into one giant prompt" model. See `docs/features/word-cue-routing.md`.

**Word-Cue Source** — A `parser: alternatives` source with `match:` (regex) and/or `keywords:` (comma-separated list). Only fires for words that hit the regex or appear in the keyword list. Use for narrow vocabularies (legal, medical, formal connectors). Higher priority wins ties. Catch-all sources (no match, no keywords) are not supported — declare an explicit `match: .*` if you really want one.

**buildSourcesFromConfig** — Factory function that takes parsed `CUES.md` plus discovered `cues/<name>/CUE.md` and `blanks/<name>/BLANK.md` folders and returns `CueSource[]`. Wires:
- **Word cues**: Each `cues/<name>/CUE.md` becomes a `ConfigSource`; all of them wrap into ONE `RoutedWordSourceGroup` that dispatches per-word.
- **Blanks**: Keyword-bound entries from `blanks/<name>/BLANK.md` register with `BlankSource` (priority 95). `FluidBlankSource` (priority 92) catches unbound `_`. The shipped `defaults/cues/spelling/CUE.md` cue (priority 80) flags misspelled words on plain text — same `ConfigSource` path as legal/medical/etc.

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

---

## Host capability profiles

**Universal Integration profile** — A `HostAdapter` profile for hosts that can't paint a cycling band or intercept Ctrl+Alt+arrow (today: chrome's plain `<input>` / `<textarea>` attach mode). Adapters declare it by returning `false` from `HostAdapter.supportsCycling`. When that flag is false, every cue/blank whose `isCycleable` shape returns true (word-cues, selector/satellite blanks, list blanks, script-backed cycling like volume/brightness) gets pruned at registration; single-answer sources (fluid-blank, transform-blank, compute) survive. Filter applied symmetrically in `buildSourcesFromConfig` (core) and `BlankFill.matchKeyword` (runtime). Canonical reference: `docs/architecture/universal-integration.md`.

**Cycleable** — Property of a cue or blank: can the user step through alternatives via Ctrl+Alt+arrow? Inferred structurally from the config shape — `blankReadOnly: true` is not cycleable; a list of `stepValues:` IS cycleable; a `blankStep:` script IS cycleable. No frontmatter field — the inference reads `isCycleable` getter on each source / `isBlankConfigCycleable(def)` on each BlankConfig. Adapters that report `supportsCycling: false` (Universal Integration profile) get the cycleable entries pruned.

**Normal-input mode** — Chrome's attach branch for plain `<input>` and `<textarea>` (vs the contenteditable branch). Adds blank support (`_` triggers) to web forms while pruning cycling/dim/statusbar (which can't render against an `<input>`'s internal value). Combined with **Sensitive-field exclusion** (the cross-cutting password / CC / OTP / API-key gate) to prevent OpenCues from ever attaching to credential fields. See `docs/features/chrome-normal-inputs.md` and `chrome-security.md` Boundaries 10–11.

**Feature registry** — Single source of truth at `packages/opencues-core/src/feature-registry.ts` for every optional OpenCues feature (FEATURES), every non-feature cycling tunable (MENU_TUNABLES), every always-on config file (CORE_CONFIG_FILES), and every built-in blank (BUILTIN_BLANKS, sibling in opencues-runtime). Doctor, chrome-host, seed-configs, the runtime's menu definitions, and every host's blank registration all derive from these — adding a feature is one PR appending one entry. Pre-May-2026, the same data was hardcoded in 4–7 sites and silently drifted. Today drift is impossible at the structural level + caught by 71 drift-prevention tests for the residual seams. Canonical reference: `docs/architecture/feature-registry.md`.

**ValueSpec / exposeInMenu** — Each FEATURES entry's `values` array carries `{id, description, exposeInMenu?}` per value (not just a string list). `exposeInMenu: false` makes a value **parser-valid but absent from the cycling menu** — formal mechanism for hiding footgun modes (today's only user: `user-context-mode: raw`, which inlines PII into LLM prompts and shouldn't be flipped by a keystroke). Replaces the old "hidden by absence from OPENCUES.md `settings:` block" pattern.

**isSensitiveField** — The chrome bootstrap's gate that refuses attach + ambient + user-context on credential-adjacent fields. Three layers: input-type allow-list (`text` / `email` / `search` / `url` / `textarea`), autocomplete-token deny-list (`SENSITIVE_AUTOCOMPLETE_TOKENS`), and name/id heuristic (`SENSITIVE_FIELD_NAME_PATTERN`). Both lists are exported constants in `integrations/chrome/src/opencues-bootstrap.ts` — single source of truth; see `docs/architecture/chrome-security.md` § Sensitive-field gate for the full token enumeration. False positives accepted; never leak credentials.

---

## OPENCUES.md vs CUES.md — two different files

These names look similar but the files are unrelated. The distinction is the source of past confusion (a planned 2026 migration to merge them was started, never finished, and left contradictory comments behind that were finally cleaned in May 2026). Canonical filename for the runtime settings file is exported as `CORE_SETTINGS_FILE` from `@opencues/core`.

**`~/.cues/OPENCUES.md`** — runtime system settings (user-level only). Frontmatter holds scalars like `voice-mode`, `tips-mode`, `debug-mode`, `cursor-navigate`, `fluid-blank-mode`, `word-cues-mode`, `blank-trigger-mode`, `llm-provider`, plus numeric tunables (`agent-debounce-ms`, etc.). Schema owned by the runtime via the FEATURES + MENU_TUNABLES registry. A single value applies across every integration; projects can't override. `OpenCuesSettingsBlank` reads + writes this file.

**`~/.cues/CUES.md`** (or `<project>/.cues/CUES.md`) — cue master config. Frontmatter has project metadata (`name`, `domain`, `version`). Body has `## Tips` (static word tips), `## Ignore` (words the runtime never suggests alts for), and `## Prompt` with `### <source-name>` LLM-backed cue source declarations. Parsed via `parseCuesMd` → `RoutedWordSourceGroup`. Lives at user-level OR project-level; project wins on name conflicts.

### Lifecycle

- `opencues seed-configs` copies `defaults/OPENCUES.md` to `~/.cues/OPENCUES.md` (SEED) and re-seeds a 0-byte file (HEAL). CUES.md is seeded the same way separately.
- **A 0-byte `OPENCUES.md` is treated as missing** — `OpenCuesSettingsBlank` silently no-ops on null/empty content, which would otherwise break `opencues ___` / `config ___` blank-fills on every native host. Chrome falls back to the bake-time `__DEFAULT_OPENCUES_MD__` constant. The seed-configs HEAL phase ensures it's always non-empty.
- `ConfigLoader._loadOnce` reads settings from the explicit `settingsFile` option (each host passes `~/.cues/OPENCUES.md`); cue sources come from `parseCuesMd` on every CUES.md across the search paths.
