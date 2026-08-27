---
last_updated: 2026-07-06
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

**Cue** — The complete package: a word that OpenCues has enriched with alternatives, a tip, or other functionality. When someone says "I added a cue for ultrathink," they mean the word now appears indicated and has OpenCues functionality behind it.

**Indicated Cue** — The visual signal within the text that a cue exists. For example, a word appearing dimmed signals that alternatives and other information are available. The indicated cue is what the user sees; the cue is the full data behind it.

**Alternatives** — The set of values a word can be replaced with when the user cycles (e.g., "happy" → "sad", "excited", "content"). The original word is always at index 0.

**Cue-Tip** — Hint text displayed in the secondary display area when a word is highlighted. Provides context about what the word means or why an alternative was suggested. Sometimes shortened to "tip" in config files.

**Multi-Word Group** — An alternative that consists of multiple words (e.g., "Sundar Pichai"). Tracked as a single unit that cycles together.

**Passive Cue** — A cue that never changes the text on its own. It marks a span and offers a rewrite, which applies only when the user presses `Ctrl+Alt+↑`. Sentence-cues, contradiction cues, session-contradiction cues and ask-cues are all passive; word-cues are too. The distinction matters because the runtime *can* splice (blanks do), so "passive" is a promise about consent, not a description of what is technically possible.

**Session-Contradiction Cue** — A passive cue that flags a draft going against a decision made earlier in the same coding session ("we agreed on Bun" … "switch this to node"). Two stages: a background producer distils the session transcript into a **commitments watchlist**, and a matcher checks each draft against it. Distinct from **contradiction cues**, which check a claim against computable fact (a real weekday, arithmetic, live weather) rather than against something the user said. Off by default; needs a host with a session transcript. See [`docs/features/session-contradiction.md`](features/session-contradiction.md).

**Commitments Watchlist** — The distilled record of decisions a session has established (stack, architecture, constraint, scope, …), scoped per working directory. It accumulates as the session runs rather than being rebuilt from the transcript tail each time, so an early decision doesn't age out.

**Ask-Cue** — A passive cue that turns a vague sentence into an inline question with cyclable answers, populated from a coding assistant's own clarifying-question prompt. Options that carry a concrete rewrite change the sentence when chosen; advisory ones only inform. Off by default. See [`docs/features/ask-cues.md`](features/ask-cues.md).

---

## Blanks

*"Never draw a blank."*

**Blank** — An underscore (`_`) placed by the user as a cue to the system: "fill this in." The direction is reversed compared to regular cues — the user is cueing the system, not the other way around.

Blanks come in two flavours: **keyword-bound** (a registered keyword next to `_` claims the slot — `volume _`, `nvda _`, `define X _`) and **fluid** (no keyword match — `FluidBlankSource` segments the lookup phrase and answers it: `capital of france _` → `Paris`, `4 * 12 = _` → `48`, `unicode for em dash _` → `U+2014`).

**Think of blanks as user-placed autocomplete.** Unlike traditional autocomplete that guesses what comes next, blanks let you decide *where* the completion appears. This works anywhere — LLM prompts, documents, mobile text fields — and enables new interaction paradigms where the user and system collaborate fluidly before submission.

Defined in `blanks/<name>/BLANK.md` (one folder per blank).

---

## Cue-Blanks

**Cue-Blank** — A blank (`_`) that has been bound to a keyword via `blankKeywords` (or an explicit `blankShapes` grammar). When the user types a command leading the sentence (e.g., `volume _`), the blank auto-populates with the blank's current value and Up/Down cycling changes the actual system state (calls a runtime `Blank` class or a `blankScript`). Routing is sentence-scoped: the keyword/shape must lead the sentence containing `_` (the segment after the last sentence terminator (`.`/`!`/`?` + whitespace, or CJK `。！？．`) or newline before `_` — so `let me check. volume _` fires just like `notes\nvolume _`), with `_` at the trailing edge — prose that merely mentions a keyword mid-sentence does not fire. All external-state interactions are `_`-gated — there is no word-cycling on plain text without `_`.

Configured in `blanks/{name}/BLANK.md` with `blankKeywords` (or `blankShapes`), `blankStep`, `blankScript`, `blankSuffix`, `integration`, `tip`, `blankDismissible`, `blankClearKeywords`, `blankClearOnEdit`, `blankSatellite`. Keywords can be multi-word phrases (e.g. `opencues settings` as one keyword), and desugar to anchored shapes. See `docs/architecture/blank-integration.md`, `docs/features/cue-blanks.md`, and `docs/guides/adding-a-cue-blank.md`.

**Blank-Bound Word** — Internal: a WordDef with `metadata.blankName` set. Indicates the position is owned by a cue-blank's auto-populated value and must not be overwritten by LLM/grammar merges. Only the user can clear it (by editing the word).

**Note collection blank** — Prototype (issue #210) user-curated snippet store: `note add/recall/delete _` over `~/.cues/NOTES.md` (`note _` browses recent). Save a snippet once, recall it by a couple of words, tweak in place. Fully local + deterministic — notes never reach an LLM (`as-context: off`). A runtime-class blank (`NoteBlank` in `@opencues/runtime`) served through injected `readFile`/`writeFile`; writes are **line surgery** (one bullet appended/removed, your own headers untouched) through the `validateNoteWrite` chokepoint (256 notes, 1024 chars/entry, control-char reject, duplicate idempotency). Optional `label: body` entries recall the body only. Ships on all 5 hosts. See `docs/features/note.md`.

**Transform Blank** — A blank that accepts an **imperative instruction** and rewrites the surrounding text (or generates new content when no target exists). Triggered by inputs like `change boy to girl _`, `make this past tense _`, `translate to french _`, or — in generative mode — `write a poem _`, `compose an email _`. Implemented as `TransformBlankSource` (priority 93, between keyword-bound BlankSource at 95 and FluidBlankSource at 92). The pipeline is a single fused LLM call that classifies and rewrites in one pass (emitting a VERDICT, the instruction, the target, and the full rewritten buffer), then a whole-buffer three-way merge into the live text. The same source also routes agent-task commands (`agentically X _`, `add task _`, `stop task _`, `current task _`) via the TASK_ARM/ADD/STOP/SHOW verdicts. See `docs/features/transform-blank.md` and the canonical reference at `docs/architecture/transform-blank.md`.

---

## Config Files

OpenCues is configured via `.md` files in the project root. These files are the standard — all prompts, modes, and behaviour are defined here, not in code.

**OPENCUES.md** — The runtime system-settings file (user-level only — projects can't override). Holds scalars like `voice-mode`, `word-cues-mode`, `tips-mode`, `debug-mode`, `cursor-navigate`, `blank-trigger-mode`, `llm-provider`, plus numeric tunables (`agent-debounce-ms`, `max-concurrent-auditors`, …) — all in YAML frontmatter. Schema declared in `@opencues/core`'s `FEATURES` + `MENU_TUNABLES` registry. Body is human-readable description, not parsed. Lives at `~/.cues/OPENCUES.md` (overridable with `$OPENCUES_HOME`). Canonical filename exported as `CORE_SETTINGS_FILE`. Seeded from `defaults/OPENCUES.md` by `opencues seed-configs` and re-seeded if 0 bytes. Cycled live by `OpenCuesSettingsBlank`. See `docs/features/selector-satellite.md` and `docs/architecture/feature-registry.md`.

**CUES.md** — The cue master config (cue source declarations + project metadata). Frontmatter has `name` / `domain` / `version`. Body has `## Tips` (static word tips), `## Ignore` (words the runtime never suggests alts for), and `## Prompt` with `### <source-name>` LLM-backed cue sources. Lives at user-level (`~/.cues/CUES.md`) OR project-level (`<cwd>/.cues/CUES.md`); project wins on name conflicts. Parsed via `parseCuesMd` → wrapped in `RoutedWordSourceGroup`. **Does NOT carry runtime system settings** — those are in OPENCUES.md (despite the similar name). A pre-2026 design plan to merge the two files was abandoned.

**BLANKS.md** — The blank master config, mirroring CUES.md's role for the blanks surface: project metadata + a top-level `disable: [<id>, ...]` list that subtracts blank ids from this layer's composition. Parsed via `parseBlanksSection`, populates `ConfigLoader`'s `result.blanks`.

**AUDITORS.md** — The auditor master config: project metadata + `disable: [<id>, ...]` to exclude auditors at the project layer without touching the user-level library. See `docs/guides/adding-an-auditor.md`.

**cues/{name}/CUE.md** — One folder per cue source. Folder name = source id. Static cues have a body JSON code block (the words map: `{"ultrathink": {"tip": "...", "alts": [...], "speak": true}}`). LLM cues declare `match:` or `keywords:` in frontmatter and put prompt text in the body. The runtime infers static-vs-LLM from data shape (no `type:` discriminator).

**blanks/{name}/BLANK.md** — One folder per blank. Defines `_`-gated cycling behaviour — script-triggered (volume, brightness), auto-populated (stock prices, weather), list (affirmations), read-only (live API values), and consume-all. Frontmatter holds the BlankConfig fields; scripts are colocated in the same folder. (Filename per the open standard at `spec/blank-spec.md`. Legacy `blank.md` and `cue.md` names are auto-migrated by `seed-configs`.)

**Folder-based config** — Each cue / blank is a self-contained folder: cues use `CUE.md`, blanks use `BLANK.md` (YAML frontmatter for config, body for prompt or words JSON), with optional colocated scripts. Folders in `cues/` and `blanks/` are auto-discovered.

**Host** — One of the OpenCues integrations: `claude-code`, `opencode`, `gemini-cli`, `shell`, `windows`, `chrome`, `dsh` (`terminal` is a deprecated back-compat alias for `shell`; `deepseek` / `deepseek-harness` alias `dsh`). They share the same `.md` config format. **Native hosts** (CC, OC, gemini-cli, shell, windows) can spawn subprocesses + read the filesystem unconditionally. **Browser hosts** (chrome, dsh — ask `isBrowserHost()`, never `=== 'chrome'`) render inside a web page and so share a DOM, the browser's own keybindings, and page-derived colours; chrome can also spawn subprocesses, but only when chrome-host (the native-messaging bridge) is installed, so that capability is runtime-detected rather than a static property.

**Host Compat** — Per-entry declaration of which hosts a cue / blank runs on. Default: every entry advertises as compatible with every host; the runtime fails at runtime if the host genuinely can't fulfil the call (exit 127). Override via `on-host:` (allow-list) and `not-on-host:` (deny-list) frontmatter fields. Surfaced in `opencues list`, validated by `opencues validate`, used by `opencues sync chrome` to filter the bundle. See `docs/features/host-compat.md` for the full spec.

**Chrome Sync** — `opencues sync chrome` bundles `.cues/` configs into the browser extension's `dist/configs/`. Unlike the native hosts (which merge `~/.cues/` + `<cwd>/.cues/` automatically), chrome defaults to **user-level only** — projects are opted in with `--include <path>` (repeatable) or `--project`. Rationale: chrome is a global browser extension with no cwd, so inheriting cwd-based project discovery causes long-running `--watch` processes to bind to the wrong directory. Full spec: `docs/features/chrome-sync.md`.

---

## Cue Sources

A **cue source** is anything that provides alternatives for words. All cue sources implement the `CueSource` interface (`id`, `priority`, `supports()`, `getCues()`).

**Local Cues** — Alternatives computed locally on your machine, returning near-instantly (~0ms). The tips file is a local cue source — it provides both alternatives and cue-tips. In code: `LocalCueSource`.

**Remote Cues** — Alternatives computed externally using an LLM (~200-500ms). Each `cues/<name>/CUE.md` (or `blanks/<name>/BLANK.md`) becomes a config-driven source that sends a prompt to the LLM and parses the response. In code: `ConfigSource`.

**BlankSource** — Keyword-bound blank dispatcher. Watches every `_` and claims the slot when any registered blank's shape (or synthesized keyword shape) matches the sentence containing `_`. Auto-populates with the blank's current value via `blankScript get` or runtime-class `blankInvoke`. Up/Down cycling writes back. Priority 95 (above fluid-blank).

**TransformBlankSource** — Imperative-instruction `_` source. A single fused LLM call (classify + rewrite in one pass) emits the full rewritten buffer, which is three-way-merged into the live text; a generative branch handles inputs with no target ("write a poem _"). Also routes agent-task commands via TASK_* verdicts. Priority 93 — between keyword-bound `BlankSource` (95) and `FluidBlankSource` (92). When `supports()` runs, it cedes to any keyword-bound match before claiming. See `docs/features/transform-blank.md`.

**FluidBlankSource** — Free-form `_` lookup. Single FUSED LLM call emits both SPAN and ANSWER in one breath; the call also optionally receives sanitized ambient field metadata (when `ambient-context-mode: on`) so the segmenter can use the field's label as the question source for meta-triggers like `_` / `answer _`. Also optionally receives identity context (when `identity-context-mode: safe` or `: raw`) — `~/.cues/IDENTITY.md` frontmatter as a catalog of sentinel tokens (`[FIRST NAME]`, `[EMAIL]`, etc.) so lookups personalise; safe mode is bidirectional: typed catalog values are dehydrated to tokens before dispatch, and a runtime post-processor (hydration) substitutes real values after the LLM responds — PII stays off the provider's logs in both directions (see § Identity context below). Handles math, factual, translation, unit conversion, codes, etc. without per-mode classification. Fires on `_` slots that no `BlankSource` or `TransformBlankSource` claimed. Always on — the base layer every unclaimed `_` falls through to (no mode scalar).

**Replace Parse** — Transform-blank's optional splice fast-path (`replace-parse-mode: on | off`, on by default). A small detector LLM call runs in parallel with the fused call and proposes a COMMAND / TARGET / VALUE triple for single-substring edits ("her name is Sarha fix the spelling _"); the runtime verifies every claim as a verbatim buffer substring (plus uniqueness, ordering, and whole-body guards) before the result takes the resolver's deterministic bounded-splice branch. Anything unverified falls back to the fused whole-buffer merge unchanged. See `docs/features/replace-parse.md` and `docs/architecture/transform-blank.md` § Replace-parse.

**RoutedWordSourceGroup** — Wraps multiple folder-based word-cue sources (each `cues/<name>/CUE.md`) and dispatches each highlighted word to ONE child source via per-word routing. Uses fast-path rules only — no LLM classifier. Every source MUST declare `match:` (regex) or `keywords:` (list); sources without either are dropped. Words that no source claims produce no cue (not navigable). Words destined for the same source are batched into one parallel LLM call. Replaces the old "combine all sources into one giant prompt" model. See `docs/features/word-cue-routing.md`.

**Word-Cue Source** — A `parser: alternatives` source with `match:` (regex) and/or `keywords:` (comma-separated list). Only fires for words that hit the regex or appear in the keyword list. Use for narrow vocabularies (formal connectors, filler words, jargon you want tightened). Higher priority wins ties. Catch-all sources (no match, no keywords) are not supported — declare an explicit `match: .*` if you really want one.

**buildSourcesFromConfig** — Factory function that takes parsed `CUES.md` plus discovered `cues/<name>/CUE.md` and `blanks/<name>/BLANK.md` folders and returns `CueSource[]`. Wires:
- **Word cues**: Each `cues/<name>/CUE.md` becomes a `ConfigSource`; all of them wrap into ONE `RoutedWordSourceGroup` that dispatches per-word.
- **Blanks**: Keyword-bound entries from `blanks/<name>/BLANK.md` register with `BlankSource` (priority 95). `FluidBlankSource` (priority 92) catches unbound `_`. The shipped `defaults/cues/spelling/CUE.md` cue (priority 10 — the lowest of any shipped source, deliberately, so other cues win first) flags misspelled words on plain text — same `ConfigSource` path as any word cue.

> **Terminology note**: "cue source" is the general concept. `CueSource` is the TypeScript interface. `ConfigSource` and `LocalCueSource` are specific implementations.

---

## LLM dispatch routing

**Bucket scalar** — A persistent provider/model pair stored in `~/.cues/OPENCUES.md` that gates one TRIO of surfaces. Three buckets (`cues-llm-*`, `auditors-llm-*`, `blanks-llm-*`); each writes to disk and survives every keystroke until the user changes it. The settings-flip syntax (`change to opus _`, `switch to cerebras _`, plus the satellite cycling menu) writes bucket scalars. See `docs/architecture/llm-routing.md`.

---

## Identity context — hydration & dehydration

**Dehydration** — The outbound half of `identity-context-mode: safe` (the default): before any buffer-derived text ships in an LLM request, identity catalog values (`~/.cues/IDENTITY.md` frontmatter) that the user typed into the buffer are replaced with their canonical `[TOKEN]`s. Covers every LLM-bound channel (9 today) plus a defense-in-depth floor at `dispatchChat`. Produces outbound copies only — the buffer is never mutated. Canonical reference: `docs/architecture/hydration-dehydration.md`.

**Hydration** — The inbound half: the runtime post-processor (`postProcessContext` in `@opencues/core`'s `identity-context.ts`, retroactively named) that binds `[TOKEN]`s in LLM output back to real values locally, after the response and before the text reaches the user's buffer. Existed before dehydration (it's how `safe` mode's catalog direction has always worked); the name pairs it with its new inverse. See `docs/architecture/hydration-dehydration.md`.

---

## Response Parsers

How LLM responses are interpreted. Set via `parser` field in `.md` config. Only two exist in the reference implementation today (`BlankParser` type in `cues-md.ts` is `'alternatives' | 'raw'`) — see `docs/guides/parser-types.md` for full details with examples.

**alternatives** — Parses `INDEX:alt1,alt2,alt3` format. Default parser. Used for word alternatives and grammar blanks.

**raw** — Uses the full LLM response verbatim as one alternative.

> **`compute`/`answer` parsers do not exist.** A `parser: answer` or `parser: math` declaration in a `.md` config's frontmatter is silently ignored by `ConfigSource.parseResponse` (its `switch` falls through to `default: return []` for anything other than `alternatives`/`raw`) — the source produces zero cues at runtime. Math/factual lookups today go through **FluidBlankSource** (a `_`-triggered fused LLM call handling math, facts, translation, etc. without per-mode classification — see § Cue Sources below), not a dedicated response-parser format.
>
> **Terminology note**: "Response parser" refers to these LLM output formats. `parseCuesMd()` is the config file parser — a different thing.

---

## Display

**Secondary Display** — Where additional information (cue-tips) is shown. It is not in the text input box. The integration decides what this is — a status bar, tooltip, hover panel, sidebar, etc.

**Status-bar position** — Chrome-only setting (`statusbar-position` scalar: `bottom` default / `top` / `right`) for where Chrome's in-page floating status bar sits, since Chrome has no host statusline to render into and the bar can occlude page content. `bottom`/`top` are full-width bands; `right` is a compact bottom-right panel. A real FEATURE (not a tunable) so the fluid-config classifier can route to it (`move the status bar to the top _`), host-scoped so it never appears in the CLI hosts' menus. See `docs/features/statusbar-position.md`.

---

## Host capability profiles

**Universal Integration profile** — A `HostAdapter` profile for hosts that can't paint a cycling band or intercept Ctrl+Alt+arrow (today: chrome's plain `<input>` / `<textarea>` attach mode). Adapters declare it by returning `false` from `HostAdapter.supportsCycling`. When that flag is false, every cue/blank whose `isCycleable` shape returns true (word-cues, selector/satellite blanks, list blanks, script-backed cycling like volume/brightness) gets pruned at registration; single-answer sources (fluid-blank, transform-blank, compute) survive. Filter applied symmetrically in `buildSourcesFromConfig` (core) and `BlankFill.matchKeyword` (runtime). Canonical reference: `docs/architecture/universal-integration.md`.

**Cycleable** — Property of a cue or blank: can the user step through alternatives via Ctrl+Alt+arrow? Inferred structurally from the config shape — a blank is cycleable IFF it declares how to cycle (`blankSatellite`, a list of `stepValues:`, or a numeric `blankStep:`); everything else (fetch blanks, plain scripts) is read-only by default. No frontmatter field — the inference reads `isCycleable` getter on each source / `isBlankConfigCycleable(def)` on each BlankConfig. Adapters that report `supportsCycling: false` (Universal Integration profile) get the cycleable entries pruned.

**Normal-input mode** — Chrome's attach branch for plain `<input>` and `<textarea>` (vs the contenteditable branch). Adds blank support (`_` triggers) to web forms while pruning cycling/dim/statusbar (which can't render against an `<input>`'s internal value). Combined with **Sensitive-field exclusion** (the cross-cutting password / CC / OTP / API-key gate) to prevent OpenCues from ever attaching to credential fields. See `docs/features/chrome-normal-inputs.md` and `chrome-security.md` Boundaries 10–11.

**Feature registry** — Single source of truth at `packages/opencues-core/src/feature-registry.ts` for every optional OpenCues feature (FEATURES), every non-feature cycling tunable (MENU_TUNABLES), every always-on config file (CORE_CONFIG_FILES), and every built-in blank (BUILTIN_BLANKS, sibling in opencues-runtime). Doctor, chrome-host, seed-configs, the runtime's menu definitions, and every host's blank registration all derive from these — adding a feature is one PR appending one entry. Pre-May-2026, the same data was hardcoded in 4–7 sites and silently drifted. Today drift is impossible at the structural level + caught by 71 drift-prevention tests for the residual seams. Canonical reference: `docs/architecture/feature-registry.md`.

**ValueSpec / exposeInMenu** — Each FEATURES entry's `values` array carries `{id, description, exposeInMenu?}` per value (not just a string list). `exposeInMenu: false` makes a value **parser-valid but absent from the cycling menu** — formal mechanism for hiding footgun modes (today's only user: `identity-context-mode: raw`, which inlines PII into LLM prompts and shouldn't be flipped by a keystroke). Replaces the old "hidden by absence from OPENCUES.md `settings:` block" pattern.

**Host-scoped setting** — A FEATURE (or MENU_TUNABLE) whose `hostScope: [...]` field restricts it to specific hosts. Two paths derive from the one field so they can't drift: (1) the settings/cycling menu only lists it on those hosts, and (2) the fluid-config intent classifier's per-host prompt (built by `buildFeatureBlock(hostName)`) only includes it in the classifier's choice space on those hosts — so an intent phrase can't resolve to a no-op setting on a host where it does nothing. Today's user: `statusbar-position` (`hostScope: ['chrome']`). Use for knobs whose effect only exists on certain hosts.

**isSensitiveField** — The chrome bootstrap's gate that refuses attach + ambient + sentinels on credential-adjacent fields. Three layers: input-type allow-list (`text` / `email` / `search` / `url` / `textarea`), autocomplete-token deny-list (`SENSITIVE_AUTOCOMPLETE_TOKENS`), and name/id heuristic (`SENSITIVE_FIELD_NAME_PATTERN`). Both lists are exported constants in `integrations/chrome/src/opencues-bootstrap.ts` — single source of truth; see `docs/architecture/chrome-security.md` § Sensitive-field gate for the full token enumeration. False positives accepted; never leak credentials.

---

## Katas

**Kata** — A guided, in-editor scenario that walks the user through a workflow step by step (`start kata 1 _`), with a live LLM coach on the status line telling them the next micro-action and detecting progress from what they type and press. Experimental; runs on all five hosts. Authored as `.cues/katas/<name>/KATA.md`. User-facing: `docs/features/kata.md`; architecture: `docs/architecture/kata.md`.

**KATA.md** — The kata file format: frontmatter (`name` / `id` / `title` / optional `next:` curriculum link) + `## Step` sections whose bodies (plus `coach:` notes) ride into the coach's system prompt verbatim. Hot-loaded at `start` — no restart. Candidate for the open standard (file-format only); not yet a spec surface.

**Coach** — The kata's one debounced LLM call per pause. Judges progress on the current step and emits one line of guidance (`STEP:` / `STATUS:` / `COACH:`, optional `CONTROL: STOP`). **Display-only** — feeds the status line and a bounds-clamped step counter, never the buffer and never a side-effect channel. The model owns judgement; the runtime owns the safety floors and every deterministic path.

**Kata mode (modal suppression)** — While a kata runs, normal OpenCues LLM behaviour (word-cues, fluid/transform blanks, config-intent, sentence-cues) is suppressed via the Resolver's `externallySuppressed` predicate so nothing races the lesson. Local features a kata might teach (navigation, cycling, keyword blanks) keep working. Stop is instant and writes nothing — the mode is one in-memory predicate.

**Trace** — The bounded (10-entry) ring of the user's activity the coach sees: `typed` (buffer snapshots, attempt-preserving), `submitted` (a submit — inferred from buffer-clear on CLI hosts OR an Enter keypress on a non-empty buffer on newline hosts like Chrome/Gmail/Shell, deduped), and `pressed` (salient keys only). Wiped on start/stop.

**Escape ladder** — The guaranteed exit, weakest assumption first: **Esc ×3** (deterministic, no key/network/language needed) → `stop kata _` (deterministic phrase) → "please stop this kata" (coach-honoured, any language) → `skip _` (per-step relief). Three Escs so a host's normal double-Esc can't exit by accident.

**Degraded mode** — When no LLM is available (missing key immediately; network failure after 2 consecutive failed calls), a kata degrades **loudly** to a labelled self-guided checklist — the status line says "coach offline (no LLM key)". Everything deterministic (start/stop/next/skip, step counter, Esc ×3) keeps working; live coaching resumes automatically on recovery.

**Lesson journal** — One line per completed step (with the evidence that closed it), kept in context for every coach/nudge check-in so guidance builds on the whole lesson, not just the last few keystrokes. Persists to `~/.cues/kata-progress.json` so a mid-way kata resumes where the user left off.

---

## OPENCUES.md vs CUES.md — two different files

These names look similar but the files are unrelated. The distinction is the source of past confusion (a planned 2026 migration to merge them was started, never finished, and left contradictory comments behind that were finally cleaned in May 2026). Canonical filename for the runtime settings file is exported as `CORE_SETTINGS_FILE` from `@opencues/core`.

**`~/.cues/OPENCUES.md`** — runtime system settings (user-level only). Frontmatter holds scalars like `voice-mode`, `tips-mode`, `debug-mode`, `cursor-navigate`, `word-cues-mode`, `blank-trigger-mode`, `llm-provider`, plus numeric tunables (`agent-debounce-ms`, etc.). Schema owned by the runtime via the FEATURES + MENU_TUNABLES registry. A single value applies across every integration; projects can't override. `OpenCuesSettingsBlank` reads + writes this file.

**`~/.cues/CUES.md`** (or `<project>/.cues/CUES.md`) — cue master config. Frontmatter has project metadata (`name`, `domain`, `version`). Body has `## Tips` (static word tips), `## Ignore` (words the runtime never suggests alts for), and `## Prompt` with `### <source-name>` LLM-backed cue source declarations. Parsed via `parseCuesMd` → `RoutedWordSourceGroup`. Lives at user-level OR project-level; project wins on name conflicts.

### Lifecycle

- `opencues seed-configs` copies `defaults/OPENCUES.md` to `~/.cues/OPENCUES.md` (SEED) and re-seeds a 0-byte file (HEAL). CUES.md is seeded the same way separately.
- **A 0-byte `OPENCUES.md` is treated as missing** — `OpenCuesSettingsBlank` silently no-ops on null/empty content, which would otherwise break `opencues ___` / `config ___` blank-fills on every native host. Chrome falls back to the bake-time `__DEFAULT_OPENCUES_MD__` constant. The seed-configs HEAL phase ensures it's always non-empty.
- `ConfigLoader._loadOnce` reads settings from the explicit `settingsFile` option (each host passes `~/.cues/OPENCUES.md`); cue sources come from `parseCuesMd` on every CUES.md across the search paths.
