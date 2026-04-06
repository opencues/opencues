---
last_updated: 2026-04-03
---

# Glossary

## OpenCues

**OpenCues** — An open-source system that provides real-time guidance as you type in any text input. It mirrors how humans give non-verbal cues during conversation — nudges, indications, and context — applied to text. OpenCues works on top of any text input: LLM prompts, word processors, mobile keyboards, and more.

OpenCues has three types of interaction:

| Type | Direction | What it does | Config file |
|------|-----------|-------------|-------------|
| **Cues** | System → User | Indicates alternatives, tips, and context for words | `cues.md` |
| **Blanks** | User → System | User places `_` to tell the system "fill this in" | `blanks.md` |
| **Cue-Controls** | User → External | Words that trigger actions outside the text (volume, brightness) | `controls.md` |

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

Blanks can be math (`4 * 12 = _` → `48`), factual (`capital of France is _` → `Paris`), grammar (`The _ dog` → `big, small, brown`), or anything an LLM or external source can resolve (stock prices, addresses, lookups).

**Think of blanks as user-placed autocomplete.** Unlike traditional autocomplete that guesses what comes next, blanks let you decide *where* the completion appears. This works anywhere — LLM prompts, documents, mobile text fields — and enables new interaction paradigms where the user and system collaborate fluidly before submission.

Defined in `blanks.md`.

---

## Cue-Controls

**Cue-Control** — A word that triggers an action outside of the text when the user cycles it. For example, "volume" runs a volume control script instead of cycling through text alternatives. The user navigates to the word and presses Up/Down like any other cue, but the effect is external to the text.

Cue-controls always trigger scripts — they don't have text alternatives. They share the same navigation system as cues and blanks.

Defined in `controls.md`. See `docs/guides/adding-a-cue-control.md`.

**Control-Bound Blank** — A blank (`_`) that is bound to a cue-control via `blankKeywords`. When the user types a keyword adjacent to an underscore (e.g., `volume _`), the blank auto-populates with the control's current value and cycling changes the actual system state. The keyword must be within `blankProximity` words of the `_` (default 0 = adjacent). This bridges blanks and cue-controls — the blank is how you enter the interaction, the control is what executes. Configured in `controls/{name}/cue.md` with `blankKeywords`, `blankStep`, `blankAutoPopulate`, `blankProximity`, `blankRange`, `blankFormat`, `blankScript`, and `blankTip`. See `docs/features/control-blanks.md`.

---

## Config Files

OpenCues is configured via `.md` files in the project root. These files are the standard — all prompts, modes, and behaviour are defined here, not in code.

**cues.md** — The primary config file. Defines word tips (`## Tips`) and LLM prompt sources (`## Prompt`) for word alternatives (synonyms, opposites, creative variations). Each `### section` under `## Prompt` becomes a cue source — grammar is the default. Domain sources can also be folder-based: `cues/{name}/cue.md` with YAML frontmatter config.

**blanks.md** — Blank fill-in config. Defines how underscores (`_`) are resolved. Each `### section` under `## Prompt` is a mode with its own prompt and response parser type. `### classifier` is special — its prompt selects which mode to use when fast heuristics (regex/keywords) don't match. Also holds the `## Ignore` word list.

**controls.md** — Cue-controls config. Defines words that trigger external scripts. Contains `## Controls` with JSON configuration. Controls can also be folder-based: `controls/{name}/cue.md` with a colocated script.

**Folder-based config** — An alternative to monolithic `.md` files. Each cue is a self-contained folder with a `cue.md` file (YAML frontmatter for config, body for prompt) and optional colocated scripts. Folders in `cues/`, `blanks/`, `controls/` are auto-discovered. Folder configs merge with monolithic files — folders win on name conflict.

---

## Cue Sources

A **cue source** is anything that provides alternatives for words. All cue sources implement the `CueSource` interface (`id`, `priority`, `supports()`, `getCues()`).

**Local Cues** — Alternatives computed locally on your machine, returning near-instantly (~0ms). The tips file is a local cue source — it provides both alternatives and cue-tips. In code: `LocalCueSource`.

**Remote Cues** — Alternatives computed externally using an LLM (~200-500ms). Each `### section` in `cues.md` or `blanks.md` becomes a config-driven source that sends a prompt to the LLM and parses the response. In code: `ConfigSource`.

**ClassifiedSourceGroup** — Wraps multiple config-driven sources for blanks. Picks one mode per input via fast heuristics (regex/keywords) or LLM classifier fallback. Blank modes are **mutually exclusive** — an input is math OR factual OR grammar, so classifying and routing to one source is correct.

**buildSourcesFromConfig** — Factory function that takes parsed `cues.md` and `blanks.md` configs and returns `CueSource[]`. Uses two strategies:
- **Words**: Combines all word-scoped alternatives sources into ONE `ConfigSource` with a merged prompt. Domains (legal, medical) can overlap in a single input, so the LLM handles all domains in one pass.
- **Blanks**: Routes to one mode via `ClassifiedSourceGroup` (modes are mutually exclusive).

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
