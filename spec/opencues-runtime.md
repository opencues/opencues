# opencues-runtime — non-standard knobs for the OpenCues runtime

> **This document is NOT part of the open standard.** It describes settings that the OpenCues runtime honors but that other implementations of the standard are free to ignore. If you're building a third-party runtime that conforms to [`cue-spec.md`](./cue-spec.md) and [`blank-spec.md`](./blank-spec.md), you can stop reading here.

---

## Why this exists

The standard ([`cue-spec.md`](./cue-spec.md), [`blank-spec.md`](./blank-spec.md), [`core.md`](./core.md)) describes only the two file formats and their runtime contracts. Anything that's purely an OpenCues-the-runtime concern — TTS voice selection, debug logging, cursor behavior — lives here, in a separate file that other implementations don't have to honor.

A future "VimCues" or "EmacsCues" reads `CUE.md`, `BLANK.md`, and `AUDITOR.md` and works. It can ignore `OPENCUES.md` entirely and park its own knobs in `VIMCUES.md` / wherever fits its conventions.

---

## File location

**User-level only** — `~/.cues/OPENCUES.md` (or `$OPENCUES_HOME/OPENCUES.md` when the env override is set).

Unlike the standard masters `CUES.md` / `BLANKS.md` / `AUDITORS.md`, `OPENCUES.md` is **not resolved through the project search path**. Settings here apply across every integration (Claude Code, OpenCode, Chrome) and across every project — they're properties of the runtime install, not of any one project. A project-level override would silently change behaviour for any other project the user opens, which is a class of bug worth designing out.

If a runtime needs project-scoped overrides for any of these knobs, it SHOULD promote the relevant fields to `CUES.md` / `BLANKS.md` / `AUDITORS.md` (which DO support project override) via the [promotion path in core.md](./core.md#promotion-path--runtime-specific-to-standard).

---

## Recognised settings

All of these live in the frontmatter of `~/.cues/OPENCUES.md`. Body content is documentation only.

```yaml
---
name: opencues-runtime
description: OpenCues runtime settings
spec: opencues/0.1-alpha

# Text-to-speech
voice-mode: on              # on | off | active
voice: en-us-default        # platform voice id

# Debug logging
debug-mode: off             # on | off | verbose

# Cursor behavior
cursor-navigate: on         # whether arrow keys navigate cues
cursor-preservation: on     # restore cursor after blank fill

# LLM provider routing (default for sources that don't pin a model)
default-provider: groq
default-model: claude-haiku-4-5

# Resolver tuning
resolver-skip-filter: on    # skip already-displayed words on subsequent passes
resolver-cache-ttl: 300     # seconds
---
```

None of these affect file format or routing — they all sit downstream of the standard's contracts.

---

## Multi-provider routing

The OpenCues runtime ships six built-in LLM providers and routes each LLM call through a settings hierarchy. This is **runtime-specific** — other implementations of the standard are free to ship one provider, six, or zero, and to use any settings shape.

### Built-in providers

The runtime supports `groq`, `openrouter`, `gemini`, `openai`, `anthropic`, `cerebras`. Each is selected by name; the runtime maps the name to:

- the API endpoint URL,
- the auth header shape (`Authorization: Bearer …` for OpenAI-compatible hosts; `x-api-key` + `anthropic-version` for Anthropic; `?key=…` query string for Gemini),
- the request/response shape (OpenAI chat-completions for the four OpenAI-compatible providers; `contents`/`parts` for Gemini; Messages API `content[].text` for Anthropic),
- the env-var name for the API key (`<PROVIDER>_API_KEY` — e.g. `GROQ_API_KEY`, `CEREBRAS_API_KEY`).

A conformant *OpenCues* install is expected to honour every selectable name. A conformant *standard* implementation is free to honour any subset.

### Settings hierarchy (most → least specific)

Per-call resolution walks four tiers; the first one that specifies a provider wins. Model resolution is paired — a tier's `model:` only counts when the same tier's `provider:` set the active provider, OR when the tier is at-least as specific as the one that did:

1. **Per-cue / per-blank** frontmatter: `provider:`, `model:`, `endpoint:` on a single source file.
2. **Per-feature** root-frontmatter keys: `<feature>-provider:`, `<feature>-model:`, `<feature>-endpoint:` for each LLM-driven feature the runtime exposes. The OpenCues runtime currently exposes:
    - `word-cues-*` — domain word-cue sources
    - `fluid-blank-*` — free-form `_` lookups
    - `transform-blank-*` — imperative-instruction blanks
    - `agent-*` — full-buffer agent rewrite
3. **Global default**: `llm-provider:`, `llm-model:`, `llm-endpoint:` in `OPENCUES.md` frontmatter.
4. **Runtime built-in default** (currently `groq` + `openai/gpt-oss-120b`).

### API keys

The runtime reads keys from `process.env` at boot (or from the host's settings UI on Chrome) and resolves the right one based on the active provider's env-var name. Multiple keys may be configured simultaneously; only the resolved provider's key is consulted per call.

### Auto-fallback

When a call's resolved provider has a wire-compatible peer (currently `groq` ↔ `cerebras`, both OpenAI chat-completions shape) and that peer's API key is also configured, the runtime automatically retries against the peer on transient failure — HTTP 429 (rate limit), 5xx (server overload), network errors, empty response body. The retry rewrites the request URL, swaps the bearer auth header to the peer's key, and translates the model-name field (e.g. `openai/gpt-oss-120b` ↔ `gpt-oss-120b`).

400-class client errors are **never** retried — those mean the request itself is malformed and would fail the same way on the peer.

This is OpenCues-specific; standard implementations are free to skip fallback or implement their own.

### `reasoning_effort` handling

OpenAI's gpt-5 / o-series, Groq's gpt-oss-* line, and Cerebras's gpt-oss-* models accept a `reasoning_effort` knob with values `low`/`medium`/`high` (some models add `none` and `xhigh`). Other providers don't. The runtime detects reasoning-capable models by name and forwards the field only where it's supported; for OpenAI's chat-completions endpoint, the runtime also strips `temperature` and renames `max_tokens` → `max_completion_tokens` for gpt-5 / o-series (those model variants reject the legacy fields).

These are wire-format quirks, not protocol features — they get encoded once in the provider adapter and forgotten by callers.

---

## Why these aren't in the standard (yet)

| Setting | Reason it's runtime-specific |
|---|---|
| `voice-mode`, `voice` | Browser hosts can't access OS TTS; native hosts can. Universal but heterogeneous. |
| `debug-mode` | Every runtime debugs differently. |
| `cursor-navigate`, `cursor-preservation` | The cursor-cycling state machine isn't part of the file format spec. |
| `default-provider`, `default-model`, `llm-provider`, `llm-model`, `llm-endpoint`, `<feature>-provider`, `<feature>-model`, `<feature>-endpoint` | LLM provider config is a per-runtime concern. The list of recognised providers, their wire formats, and their env-var conventions are runtime-specific; another runtime could ship a single provider with a hardcoded model and conform to the standard equally. |
| `resolver-*` | Caching strategy is implementation-private. |

Any of these could be promoted to the standard if multiple runtimes adopt them. See [`core.md`](./core.md) § Promotion path.

---

## Defensive parsing

A 0-byte `CUES.md`, `BLANKS.md`, `AUDITORS.md`, or `OPENCUES.md` MUST be treated as missing rather than as a parse error. The `OpenCuesSettingsBlank` silently no-ops on empty content; without this rule a truncated file would silently break `opencues ___` / `config ___` blank-fills on every native host.

---

## Settings written by the runtime

Some settings can be modified by the user from inside text — e.g. typing `opencues voice-mode _` in a buffer and accepting the alternative flips the in-file value. The OpenCues runtime ships a built-in `OpenCuesSettingsBlank` that targets this file.

When the runtime writes to `OPENCUES.md`, it MUST honor the [hot-reload write-race guard](./core.md#hot-reload) by suppressing its own re-read for at least 2 seconds after the write completes.

Other runtimes are free to omit this self-mutation behavior entirely.

---

## Fluid blank — runtime implementation

The blank spec defines a runtime-side fallback when `_` matches no `blankKeywords`: see [`blank-spec.md` § Fluid-blank fallback](./blank-spec.md). Implementing the fallback is OPTIONAL for conformance; this section describes how the OpenCues runtime implements one. Other runtimes may mirror, replace, or omit.

### What it is

When the user types `_` and no `blankKeywords` match, OpenCues attempts a free-form LLM lookup. The blank source `FluidBlankSource` (`packages/opencues-core/src/sources/fluid-blank-source.ts`) catches anything that looks like a natural-language lookup query: `capital of france _`, `unicode for em dash _`, `weather in london _`, `what is 4 * 12 _`.

It registers at **priority 92** — below keyword-bound blanks (95) and below transform blank (93), so explicit bindings always win.

### Two-pass pipeline

Each unmatched `_` triggers two LLM calls in sequence:

| Pass | Name | Input | Output | Token budget |
|---|---|---|---|---|
| P1 | SEGMENT | full input text | `SPAN: <substring>` + `CONTEXT: <surrounding text>` | 256 |
| P3 | ANSWER | SPAN + CONTEXT from P1 | `ANSWER: <terse value>` | 200 |

P1 uses 9 extraction rules (A–H in the source, with ~12 worked examples) to identify what part of the input is the lookup phrase. P3 receives that phrase plus context, applies 7 terseness/disambiguation rules, and returns a canonical short answer.

The runtime performs **no caching** — each `_` triggers fresh P1+P3 calls. Latency cost is two round-trips; the runtime budgets this against the spec's "sub-second" expectation for blanks (see [`concept.md` § Why the split matters](../concept.md)) by using a fast model.

### FILL vs WIPE

After ANSWER returns, the runtime decides how the result substitutes. The decision is **deterministic** (no LLM call) — see `determineReplaceMode()` in `fluid-blank-source.ts`.

- **FILL** — the input ends with a copula/equation/question marker immediately before `_` (`is _`, `= _`, `? _`). The answer substitutes only the `_` token; the surrounding sentence is preserved.

  ```
  the capital of france is _   →   the capital of france is Paris
  4 * 12 = _                   →   4 * 12 = 48
  ```

- **WIPE** — the input is a bare lookup phrase. The entire span (lookup phrase + `_`) is wiped and replaced with the answer alone.

  ```
  capital of france _          →   Paris
  weather in london _          →   13°C Partly cloudy
  ```

The runtime emits character-offset `spanStart`/`spanEnd` on the resulting `CueResult` so the editor knows how much to replace.

### Settings

Fluid blank is opt-in per integration via the `enableFluidBlank` flag passed to `buildSourcesFromConfig()`. The `OPENCUES.md` setting `fluid-blank-mode: on|off` toggles it at runtime; `fluid-blank-provider:` selects which model to use (defaults to the runtime's `default-provider`).

A future spec version may promote `fluid-blank-mode` to `BLANKS.md` if multiple runtimes adopt the same toggle.

---

## Transform blank — runtime implementation

A second runtime-only blank source. Where fluid blank handles **interrogative** patterns ("what is X?"), transform blank handles **imperative** ones ("change X to Y", "make this past tense", "translate to French"). Like fluid, it's a runtime feature with no `BLANK.md` configurable.

`TransformBlankSource` (`packages/opencues-core/src/sources/transform-blank-source.ts`) registers at **priority 93** — above fluid (92), below keyword-bound blanks (95). When a `_` slot is up for grabs, the source chain races: keyword blank → transform blank → fluid blank.

### Three-pass pipeline — EXTRACT, APPLY, VERIFY

| Pass | Purpose | Output shape |
|---|---|---|
| EXTRACT | Classify the input. Is it actually a transform? Split it into instruction + target. | `VERDICT: TRANSFORM\|NONE\|TASK_*`, `INSTRUCTION: …`, `TARGET: …` |
| APPLY | Execute the instruction on the target. Rewrite. | `REWRITE: <rewritten target>` |
| VERIFY | Check the rewrite for defects across four categories (agreement, coverage, structural completeness, concept-swap propagation). Repair if needed. | `VERDICT: OK\|REPAIR`, optional corrected rewrite |

If EXTRACT returns `NONE`, the source bails immediately and fluid blank gets its turn. If EXTRACT returns `TRANSFORM` with an empty TARGET, the source routes to a generative fallback.

### Prompt design — minimal EXTRACT, verbose APPLY

A deliberate asymmetry, validated by experiment:

- **EXTRACT** is minimal: one semantic question + 4 layout-spanning examples. Stripping verbose rule lists improved EXTRACT accuracy from 83% → 88–90% because the model was over-pattern-matching against enumerated shapes and bailing on borderline imperatives.
- **APPLY** is verbose: ~25 worked examples covering concept-swap propagation, role preservation, conditional instructions. Stripping APPLY to minimal rules dropped accuracy from 83% → 81%.

The principle: **classification benefits from openness; execution benefits from explicit rules.**

### Sequential composition for "X and Y"

When a user writes `make past tense and remove pronouns _`, EXTRACT outputs the instructions pipe-joined:

```
INSTRUCTION: make past tense | remove pronouns
```

The resolver then runs APPLY **N times sequentially** — output of step 1 becomes the target of step 2. VERIFY sees the original "X and Y" form (not the pipe-joined version) so it can check both transforms applied to the starting text.

This matters: a single APPLY call asked to "pluralize AND make past tense" simultaneously benchmarked at 47% accuracy. Splitting into two sequential calls jumped to 73%.

### Skip-VERIFY rules

VERIFY is skipped when **all** of these hold:

- Draft length within ±15% of target.
- No `\n\n` in target or draft (multi-paragraph rewrites need VERIFY).
- Single instruction (composed `X | Y` always needs VERIFY for cross-step agreement).
- Instruction matches a known low-stakes pattern: literal swap or BrE↔AmE.

Broadening the skip rules (e.g. to all case changes or simple tense flips) HURT accuracy by 2.3pp in benchmarks — those patterns have ambiguous interpretations VERIFY catches.

### Parser quirks worth knowing

The output parser uses `[ \t]*` (not `\s*`) for single-line fields. Reason: `\s*` matches newlines, which lets a lazy `.*?` regex extend across lines and accidentally capture the next field's label as the current value. The TARGET field intentionally does NOT use the multiline `m` flag — multi-paragraph targets span newlines and need lazy `[\s\S]*?` to run to the next labeled field.

These look like nit-picks; they were both real production bugs.

### Where it sits in the pipeline

```
user types: "<text> _"
       │
       ▼
[ keyword blank (95)?  ] ── matches blankKeywords ───▶ run binding (script/list/impl)
       │ no
       ▼
[ transform blank (93)? ] ── EXTRACT returns TRANSFORM ──▶ APPLY → maybe VERIFY → emit
       │ EXTRACT returns NONE
       ▼
[ fluid blank (92)?    ] ── always supports ──▶ SEGMENT → ANSWER → FILL or WIPE
       │ disabled
       ▼
[ leave _ literal ]
```

The three runtime sources are independently disable-able. With all three off, `_` stays literal.

### Reference

The architecture document at `docs/architecture/transform-blank.md` is the canonical implementation reference. The benchmark log at `tests/benchmarks/transform-blank/EXPERIMENTS.md` records every design decision with its accuracy delta.

---

## Future surfaces

### Provider routing — `provider:` / `model:` / `endpoint:` for blanks

`cue-spec.md` 0.1-alpha already accepts `provider:` / `model:` / `endpoint:` on per-source frontmatter. `blank-spec.md` does not yet — adding the same trio to `BLANK.md` is the obvious next promotion. Low-risk: identical wire format to cues, same resolution hierarchy, no new validation rules.

### Promotion candidates from this file

`voice-mode` and `debug-mode` are universal in every implementation we have. They are good candidates for promotion to the standard once a second runtime ships, but neither is in scope for `0.1-alpha`.
