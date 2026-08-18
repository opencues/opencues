# @opencues/runtime — reference-implementation extensions

> **This document is NOT part of the open standard.** It describes settings and behaviours specific to the OpenCues *reference runtime* (`@opencues/runtime`). Other implementations of the standard are free to ignore everything here.
>
> If you're building a third-party runtime conformant to the standard at [`spec/`](../../spec/), stop reading — start at [`spec/README.md`](../../spec/README.md). The standard is what you implement; this doc is what one specific runtime (ours) happens to do on top.

This file lives under `packages/opencues-runtime/` rather than `spec/` deliberately. Reference-implementation docs colocated with the spec muddle the standard/implementation boundary; every peer open standard (MCP, OpenAPI, JSON Schema, CommonMark) keeps the two cleanly separated. This file is the reference-impl side of that split.

As of the current spec version (`0.4-alpha` — see `spec/CHANGELOG.md`), the OpenCues reference runtime is the only runtime that exists; this doc keeps that fact from contaminating the standard. The forward-looking framing throughout ("other runtimes MAY", "another runtime could ship") is structural — the standard is designed so a second runtime could ship, even though none does today.

---

## Why this exists

The standard ([`cue-spec.md`](../../spec/cue-spec.md), [`blank-spec.md`](../../spec/blank-spec.md), [`core.md`](../../spec/core.md)) describes only the file formats and their runtime contracts. Anything that's purely an OpenCues-the-runtime concern — TTS voice selection, debug logging, cursor behavior — lives here, in a separate file that other implementations don't have to honor.

A future "VimCues" or "EmacsCues" reads `CUE.md`, `BLANK.md`, and `AUDITOR.md` and works. It can ignore `OPENCUES.md` entirely and park its own knobs in `VIMCUES.md` / wherever fits its conventions.

---

## File location

**User-level only** — `~/.cues/OPENCUES.md` (or `$OPENCUES_HOME/OPENCUES.md` when the env override is set).

Unlike the standard masters `CUES.md` / `BLANKS.md` / `AUDITORS.md`, `OPENCUES.md` is **not resolved through the project search path**. Settings here apply across every integration (Claude Code, OpenCode, Chrome) and across every project — they're properties of the runtime install, not of any one project. A project-level override would silently change behaviour for any other project the user opens, which is a class of bug worth designing out.

If a runtime needs project-scoped overrides for any of these knobs, it SHOULD promote the relevant fields to `CUES.md` / `BLANKS.md` / `AUDITORS.md` (which DO support project override) via the [promotion path in core.md](../../spec/core.md#promotion-path--runtime-specific-to-standard).

---

## Recognised settings

All of these live in the frontmatter of `~/.cues/OPENCUES.md`. Body content is documentation only.

```yaml
---
name: opencues-runtime
description: OpenCues runtime settings
spec: opencues/0.1-alpha

# Text-to-speech
voice-mode: active          # active | inactive
voice: en-us-default        # platform voice id

# Debug logging
debug-mode: off             # on | off

# Cursor behavior
cursor-navigate: inactive   # active | inactive — auto-highlight the word under the cursor

# Global LLM provider routing (least-specific tier; see § Settings hierarchy)
llm-provider: groq
llm-model: openai/gpt-oss-120b

# Per-bucket LLM routing (cues / auditors / blanks — see § Multi-provider routing)
cues-llm-provider: inherit
cues-llm-model: default
auditors-llm-provider: inherit
auditors-llm-model: default
blanks-llm-provider: inherit
blanks-llm-model: default

# Per-model reasoning-effort ceiling (default on — off is the only state that changes anything)
max-thinking: on

# Feature gates (all opt-in / off by default unless noted)
word-cues-mode: off
transform-blank-mode: off
sentence-cues-mode: off
fluid-config-mode: off
ambient-context-mode: off        # chrome-only
identity-context-mode: safe      # off | safe | raw — default flipped off -> safe in PR #161 (2026-06-18)
blank-context-mode: safe         # off | safe | raw — same PR

# Agent (AgentRewrite) tuning
agent-debounce-ms: 1000     # ms after last keystroke before AgentRewrite ticks. Misparse → 1000.
agent-window-words: 0       # 0 = full-buffer; N>0 = sliding window of ~N words around cursor
---
```

None of these affect file format or routing — they all sit downstream of the standard's contracts. This is a representative sample, not the full set — see `packages/opencues-core/src/feature-registry.ts`'s `FEATURES` + `MENU_TUNABLES` for the single source of truth on every scalar the reference runtime recognises.

> **Fluid-blank has no mode toggle.** Unlike every other feature above, fluid-blank is the ALWAYS-ON base layer — every `_` not claimed by a blank shape resolves through it (`enableFluidBlank: true` is hardcoded in `Resolver.rebuildResolver`). An earlier `fluid-blank-mode` scalar was retired when the static-resolution design shipped; don't look for it.

---

## Multi-provider routing

The OpenCues runtime ships eleven built-in LLM providers and routes each LLM call through a settings hierarchy. This is **runtime-specific** — other implementations of the standard are free to ship one provider, ten, or zero, and to use any settings shape.

### Built-in providers

The runtime supports `groq`, `openrouter`, `gemini`, `openai`, `openai-subscription`, `anthropic`, `cerebras`, `claude-code-cli`, `opencode-zen`, `ollama`, `kimi` (`PROVIDER_IDS` in `packages/opencues-core/src/llm-provider.ts`). Each is selected by name; the runtime maps the name to:

- the API endpoint URL,
- the auth header shape (`Authorization: Bearer …` for OpenAI-compatible hosts; `x-api-key` + `anthropic-version` for Anthropic; `?key=…` query string for Gemini),
- the request/response shape (OpenAI chat-completions for the four OpenAI-compatible providers; `contents`/`parts` for Gemini; Messages API `content[].text` for Anthropic),
- the env-var name for the API key (`<PROVIDER>_API_KEY` — e.g. `GROQ_API_KEY`, `CEREBRAS_API_KEY`).

A conformant *OpenCues* install is expected to honour every selectable name. A conformant *standard* implementation is free to honour any subset.

### Settings hierarchy (most → least specific)

Per-call resolution walks five tiers; the first one that specifies a provider wins. Model resolution is paired — a tier's `model:` only counts when the same tier's `provider:` set the active provider, OR when the tier is at-least as specific as the one that did:

1. **Per-cue / per-blank** frontmatter: `provider:`, `model:`, `endpoint:` on a single source file.
2. **Per-feature** root-frontmatter keys: `<feature>-provider:`, `<feature>-model:`, `<feature>-endpoint:` for each LLM-driven feature the runtime exposes. The OpenCues runtime currently exposes:
    - `word-cues-*` — domain word-cue sources
    - `fluid-blank-*` — free-form `_` lookups
    - `transform-blank-*` — imperative-instruction blanks
    - `fluid-config-*` — semantic `_` → settings-change classifier
    - `sentence-cues-*` — whole-sentence rewrite cues
    - `agent-*` — full-buffer agent rewrite (reads the auditors bucket, tier 3 below)
3. **Bucket default**: `cues-llm-provider:`/`cues-llm-model:`, `auditors-llm-provider:`/`auditors-llm-model:`, `blanks-llm-provider:`/`blanks-llm-model:` — one scalar pair per trust-class surface (cues, auditors, blanks). A bucket value of `inherit`/`default` collapses to "fall through to the next tier." See `docs/architecture/llm-routing.md` for the full design (this three-bucket simplification replaced a larger set of per-aspect scalars as the primary menu-level knob; per-feature scalars above still work as file-edit-only advanced overrides).
4. **Global default**: `llm-provider:`, `llm-model:`, `llm-endpoint:` in `OPENCUES.md` frontmatter.
5. **Runtime built-in default** (currently `groq` + `openai/gpt-oss-120b`).

Prose-bearing surfaces (word-cues, sentence-cues, auditors, agent-rewrite) refuse to dispatch through a provider with `trainsOnInput: true` (today only `opencode-zen`) regardless of which tier picked it; only the blanks bucket exposes `opencode-zen` in its menu, since the `_` keystroke itself is the user's consent gate.

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
| `cursor-navigate` | The cursor-cycling state machine isn't part of the file format spec. Cursor-offset preservation across a substitution (docs/features/cursor-preservation.md) is unconditional runtime behavior, not a setting — there is no toggle for it. |
| `llm-provider`, `llm-model`, `llm-endpoint`, `<feature>-provider`, `<feature>-model`, `<feature>-endpoint`, `cues-llm-*`, `auditors-llm-*`, `blanks-llm-*` | LLM provider config is a per-runtime concern. The list of recognised providers, their wire formats, and their env-var conventions are runtime-specific; another runtime could ship a single provider with a hardcoded model and conform to the standard equally. |
| `word-cues-mode`, `transform-blank-mode`, `sentence-cues-mode`, `fluid-config-mode`, `undo-mode`, `ambient-context-mode`, `max-thinking` | Per-feature enable gates + reasoning-effort budget are reference-runtime knobs — a second runtime could ship any subset always-on. |
| `identity-context-mode`, `blank-context-mode` | Mode-gates for the sentinel-catalog machinery ARE spec-mandated (see [`core.md` § Spec-mandated scalars](../../spec/core.md#spec-mandated-scalars)) — listed here for completeness since they live in the same `OPENCUES.md` file as the runtime-only settings, not because they're runtime-specific. |

Any of these could be promoted to the standard if multiple runtimes adopt them. See [`core.md`](../../spec/core.md) § Promotion path.

---

## Defensive parsing

A 0-byte `CUES.md`, `BLANKS.md`, `AUDITORS.md`, or `OPENCUES.md` MUST be treated as missing rather than as a parse error. The `OpenCuesSettingsBlank` silently no-ops on empty content; without this rule a truncated file would silently break `opencues ___` / `config ___` blank-fills on every native host.

---

## Settings written by the runtime

Some settings can be modified by the user from inside text — e.g. typing `opencues voice-mode _` in a buffer and accepting the alternative flips the in-file value. The OpenCues runtime ships a built-in `OpenCuesSettingsBlank` that targets this file.

When the runtime writes to `OPENCUES.md`, it MUST honor the [hot-reload write-race guard](../../spec/core.md#hot-reload) by suppressing its own re-read for at least 2 seconds after the write completes.

Other runtimes are free to omit this self-mutation behavior entirely.

---

## Fluid blank — runtime implementation

The blank spec defines a runtime-side fallback when `_` matches no `blankKeywords`: see [`blank-spec.md` § Fluid-blank fallback](../../spec/blank-spec.md). Implementing the fallback is OPTIONAL for conformance; this section describes how the OpenCues runtime implements one. Other runtimes may mirror, replace, or omit.

### What it is

When the user types `_` and no `blankKeywords` match, OpenCues attempts a free-form LLM lookup. The blank source `FluidBlankSource` (`packages/opencues-core/src/sources/fluid-blank-source.ts`) catches anything that looks like a natural-language lookup query: `capital of france _`, `unicode for em dash _`, `weather in london _`, `what is 4 * 12 _`.

It registers at **priority 92** — below keyword-bound blanks (95) and below transform blank (93), so explicit bindings always win.

### Fused single-call pipeline

**As of June 2026, fluid-blank is a single fused LLM call** — the earlier two-pass P1 SEGMENT → P3 ANSWER pipeline (still described in some older docs/comments) was replaced. One call, `FUSED_SYSTEM_PROMPT` in `fluid-blank-source.ts`, both segments the lookup phrase AND produces the answer AND decides FILL-vs-WIPE, returning three labelled lines:

```
SPAN: <the contiguous substring of the input including _, OR the literal word NONE>
ANSWER: <the value that should replace the SPAN; empty when SPAN=NONE>
MODE: <WIPE if the whole input is a terse lookup phrase the ANSWER replaces; FILL if the ANSWER fills a gap in a sentence and the surrounding words stay>
```

Why fused: cerebras/claude/gemini are tied-or-better on accuracy and ~2x faster (one round-trip instead of two), and the segmenter can now see ambient field metadata directly — so meta-triggers like bare `_` / `answer _` no longer bail to NONE when the field's label carries the actual question. Bench: `tests/benchmarks/fluid-blank-ambient/fused-bench.ts` — 175/176 (99.4%) on cerebras, matching the prior 2-pass's 99.4% on the same suite. Any edit to `FUSED_SYSTEM_PROMPT` MUST re-run that bench plus `tests/benchmarks/fluid-blank/run.ts --mode fused`.

### Variant-pool caching

Unlike a stateless per-call design, the runtime keeps a **module-level variant pool** (`FluidBlankSource._variantPool`, a static `Map`) keyed on `(buffer + provider + model + maxThinking + ambient + context-modes)`. State machine (mirrors `TransformBlankSource._variantPool`):

- **Building** (pool size < 3): every trigger dispatches fresh, accumulates into the pool.
- **Cycling** (pool full): re-triggers on the same lookup serve from the cached pool instead of re-dispatching.
- **Refreshing**: one fresh dispatch, FIFO-evicts the oldest cached entry.

The cache key deliberately OMITS identity/blank-context VALUES (in `safe` mode the LLM only ever sees token names; values substitute post-LLM), so a cached answer carrying `[FIRST NAME]` re-substitutes against whatever the identity value currently is on each hit. Ambient context IS part of the key — the same lookup phrase in different field contexts must not collide.

### FILL by default; field-declared WIPE

The fused prompt still asks the model for a `MODE:` line, but the runtime
**ignores it** — the model does NOT get to decide whether to destroy the
buffer. Fluid is **FILL by default**: the answer substitutes only the `_`
token; every surrounding word the user typed stays.

```
the capital of france is _   →   the capital of france is Paris
4 * 12 = _                   →   4 * 12 = 48
capital of france _          →   capital of france Paris   (FILL — a CC prompt, no field declaration)
```

**WIPE — replace the whole field — fires in exactly two host-declared cases,
both data-loss-free:**

1. `AmbientContext.disposable` — the host declares the field's content is a
   transient query/command (an omnibox, a launcher, a command palette);
   replace it wholesale.
2. `AmbientContext.singleLine` **and** the buffer is exactly the lookup
   (`bufferIsExactlyTheLookup` — trimmed buffer === trimmed span, no
   paragraph break); a single-line search box holding nothing but the query.

```
reddit com _   (omnibox, singleLine, buffer===query)   →   https://www.reddit.com   (WIPE)
my tax pdfs _  (Explorer search, singleLine)           →   *.pdf                    (WIPE)
```

On WIPE the result carries `spanStart=0`/`spanEnd=len`; the resolver replaces
the whole field. On FILL there is no span and only the `_` is replaced.

> **History (do not re-introduce the retired form).** An earlier *unscoped*
> WIPE — a heuristic that guessed FILL/WIPE from sentence shape — was retired
> in the July-2026 blank-API slim-down (commit `f62dcd28`) because it
> destroyed content it couldn't prove was disposable (an English-anchored
> regex collapsed foreign-language sentences; multi-paragraph buffers were
> flattened). The successor above never guesses: it acts only on the host's
> explicit field declaration + the `buffer === span` proof (the shape first
> shipped in `a534a99e`, "standalone-value WIPE"). Any future WIPE MUST route
> through `bufferIsExactlyTheLookup` or a host `disposable` declaration — never
> a sentence-shape heuristic.

### Task-trigger guard

Fluid blank's `supports()` refuses any input whose tail matches a transform-blank **task-trigger keyword**, in canonical *or* reversed-order forms:

| Keyword | Canonical | Also matches (typo'd) |
|---|---|---|
| arm | `agentically <X> _` | — |
| add | `add task <X> _` | `task add <X> _` |
| stop | `stop task _` | `task stop _` |
| show | `current task _` / `show task _` | `task current _` / `task show _` |

Pattern (source of truth, `fluid-blank-source.ts`):

```js
const TASK_TRIGGER_GUARD = /\b(?:agentically|(?:stop|add|current|show)\s+task|task\s+(?:stop|add|current|show))\b/i;
```

**Rationale.** Without this guard, a mistyped trigger like `task stop _` falls through transform-blank's classifier (which only recognises canonical orderings), reaches fluid-blank, and gets hallucinated as a lookup query — the LLM might substitute the entire surrounding sentence with `"yes"` or similar. The guard ensures the buffer stays literal when the user intent is clearly task-lifecycle, even if the keyword order doesn't parse. The user can correct the order and retry; the alternative (silent prose-eating) was a real production bug.

**False-positive avoidance.** The guard requires the trigger keyword as a whole word AND immediately adjacent to `task` (or, for `agentically`, as a standalone word). Sentences containing `task` in normal prose ("I have a task to finish _", "the task force was deployed _") still flow through fluid-blank as lookups.

### Settings

Fluid blank has **no enable/disable toggle** — `enableFluidBlank: true` is hardcoded in `Resolver.rebuildResolver`; it's the always-on base layer every unclaimed `_` falls through to (an earlier `fluid-blank-mode` scalar was retired when this static-resolution design shipped). `fluid-blank-provider:`/`fluid-blank-model:` (per-feature tier) still select which model to use, per the settings hierarchy in § Multi-provider routing.

---

## Transform blank — runtime implementation

A second runtime-only blank source (sibling to fluid blank, above). Where fluid blank handles **interrogative** patterns ("what is X?"), transform blank handles **imperative** ones ("change X to Y", "make this past tense", "translate to French"). Like fluid, it's a runtime feature with no `BLANK.md` configurable.

`TransformBlankSource` (`packages/opencues-core/src/sources/transform-blank-source.ts`) registers at **priority 93** — above fluid (92), below keyword-bound blanks (95). When a `_` slot is up for grabs, the source chain races: keyword blank → transform blank → fluid blank.

### Single fused call

**As of June 2026, transform blank is a SINGLE fused LLM call** on every provider — the earlier three-pass EXTRACT → APPLY → VERIFY pipeline (groq-only) was retired (`docs/architecture/transform-blank.md`, EXPERIMENTS.md § Experiment 10: groq fused benched at parity, ~35% faster). One call, `FUSED_SYSTEM` in `transform-blank-source.ts`, classifies AND rewrites AND handles agent-task commands together, returning labelled lines:

```
VERDICT: TRANSFORM | NONE | TASK_ARM | TASK_ADD | TASK_STOP | TASK_SHOW
INSTRUCTION: <the imperative phrase OR task prompt, _ removed; or empty>
FULL_REWRITE: <the ENTIRE final buffer with the instruction applied AND the instruction
               phrase + _ removed. Contains ONLY what the user should see. Empty when
               VERDICT is NONE / TASK_*>
```

(A `TARGET:` field existed in an earlier iteration of this prompt; it was dropped from the requested output in June 2026 — debug-only now, per EXPERIMENTS.md Experiment 13. The parser still defensively looks for it, but the shipping prompt doesn't ask for it.)

If VERDICT is `NONE`, the source bails immediately and fluid blank gets its turn — unless the buffer is long (>~800 chars), in which case a `NONE` isn't trusted (it might be budget-pressure truncation) and the source cedes without acting on it. If VERDICT is `TRANSFORM` with an empty TARGET/body, the source routes to a generative fallback (`write a poem _` → the generated content lands in `FULL_REWRITE`). Composed "X and Y" instructions (`make past tense and remove pronouns _`) pipe-join in `INSTRUCTION` and are applied TOGETHER in the same `FULL_REWRITE` — there is no separate sequential per-instruction call. There is no VERIFY step at all; the parsed result carries a vestigial `verifyVerdict: 'SKIPPED'` field for event-shape back-compat only.

### Agent-task lifecycle keywords

The fused call also recognises four task-lifecycle commands, in the same VERDICT enum as above. These leave `FULL_REWRITE` empty — they mutate `AgentTaskState` directly via `metadata.taskAction` and strip just the trigger phrase from the buffer (the `trimTriggerFromText` helper in `resolver.ts`):

| Verdict | Canonical trigger | Effect |
|---|---|---|
| `TASK_ARM` | `agentically <X> _` | Arm a fresh task with prompt = `<X>`. AgentRewrite starts ticking. |
| `TASK_ADD` | `add task <X> _` | Append `<X>` to the active task prompt. |
| `TASK_STOP` | `stop task _` | Clear the task. AgentRewrite stops. |
| `TASK_SHOW` | `current task _` | Substitute the current prompt at `_` for inspection. Inserted text is registered as a `task-show` DynDef span. |

The classifier matches **canonical orderings only**. Reversed-order typos (e.g. `task stop _` instead of `stop task _`) are rejected and would normally fall through to fluid-blank — but fluid-blank's task-trigger guard refuses those too (see § Task-trigger guard above), so the buffer stays literal. The user can correct the order and retry.

#### TASK_SHOW span and the atomic-delete rule

When `TASK_SHOW` substitutes the current prompt at `_`, the runtime registers a DynDef on the inserted text with `blankName: 'task-show'`, alternatives `['', <promptText>]`, and `currentIndex: 1`. Two consequences:

1. **Cycling Down** on the prompt span reverts to alternatives[0] (empty) — removes the substitution as a unit.
2. **Editing any character** of the span (typing inside it, backspacing into it) triggers `Navigation.onTextChange`'s atomic-delete path: the whole span splices out of the buffer in one runtime-source edit, surrounding prose preserved.

This atomic-delete behaviour is **scoped to defs whose `blankName` starts with `task-`** — fluid-blank and transform-blank substitutions are NOT covered, because their results are intended as drop-in answers the user might tweak in place. The rule is built in to the runtime; it isn't user-configurable, and no `OPENCUES.md` flag exposes it.

#### Agent-task statusline indicator

While a task is armed, `Statusline.buildPayload` populates `agentTask: <truncated prompt>` (last ~40 chars, `…`-prefixed when longer) on every render — irrespective of whether a word is currently highlighted. Hosts render this as a stable badge alongside the regular tip:

```
[task: <prompt>]
```

Stable display is the contract. There is **no in-flight spinner** — the badge does not flicker as ticks fire, because that would jitter on every keystroke pause. Reference renderers: `integrations/claude-code/patches/highlight-statusline.sh` (bash, reads the JSON file) and `integrations/opencode/patches/opencuesBootstrap.ts`'s `statusSnapshotHook` (in-process, feeds a SolidJS signal).

### Retired: three-pass EXTRACT/APPLY/VERIFY design

Earlier iterations of this pipeline (pre-June-2026, groq-only) ran three separate calls — EXTRACT (classify + split into instruction/target), APPLY (rewrite), VERIFY (defect-check + repair) — with a deliberate minimal-EXTRACT/verbose-APPLY prompt asymmetry, N-sequential-APPLY-calls composition for "X and Y" instructions, and a set of skip-VERIFY heuristics. All of that was retired in favour of the single fused call described above (`docs/architecture/transform-blank.md` § Experiment 10 has the accuracy-parity benchmark that justified the retirement; `EXPERIMENTS.md` in the same directory has the full experiment log, including the historical numbers from the 3-pass era, if you need the "why" behind a specific design choice that carried forward).

### Parser quirks worth knowing

The output parser uses `[ \t]*` (not `\s*`) for the single-line `VERDICT:`/`INSTRUCTION:` fields. Reason: `\s*` matches newlines, which lets a lazy `.*?` regex extend across lines and accidentally capture the next field's label as the current value. `FULL_REWRITE:` is the last field in the output and is captured to end-of-string with `[\s\S]*?` so multi-paragraph rewrites (which contain their own newlines) parse correctly.

These look like nit-picks; they were real production bugs in an earlier iteration of this parser.

### Where it sits in the pipeline

```
user types: "<text> _"
       │
       ▼
[ keyword blank (95)?  ] ── matches blankKeywords ───▶ run binding (script/list/impl)
       │ no
       ▼
[ transform blank (93)? ] ── fused call: VERDICT=TRANSFORM ──▶ FULL_REWRITE emitted
       │ fused call: VERDICT=NONE
       ▼
[ fluid blank (92)    ] ── always supports ──▶ fused call: SPAN+ANSWER+MODE ──▶ FILL or WIPE
       │ disabled
       ▼
[ leave _ literal ]
```

Transform blank and fluid blank are independently disable-able (`transform-blank-mode: on|off`; fluid blank has no toggle — see § Recognised settings above). With transform blank off, every `_` not claimed by a keyword blank falls straight to fluid blank.

### Reference

The architecture document at `docs/architecture/transform-blank.md` is the canonical implementation reference. The benchmark log at `tests/benchmarks/transform-blank/EXPERIMENTS.md` records every design decision with its accuracy delta.

---

## Future surfaces

### Provider routing — `provider:` / `model:` / `endpoint:` for blanks

`cue-spec.md` already accepts `provider:` / `model:` / `endpoint:` on per-source frontmatter. `blank-spec.md` does not yet — adding the same trio to `BLANK.md` is the obvious next promotion. Low-risk: identical wire format to cues, same resolution hierarchy, no new validation rules.

### Promotion candidates from this file

`voice-mode` and `debug-mode` are universal in every implementation we have. They are good candidates for promotion to the standard once a second runtime ships, but neither is in scope yet.
