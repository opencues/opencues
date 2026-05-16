---
# ─── Top-level scalars (current values) ────────────────────────────────
# Cycled by selector/satellite navigation; rewritten in place by the
# runtime when the user cycles a setting. Hand-edit allowed.
voice-mode: active
debug-mode: off
tips-mode: on
cursor-navigate: inactive

# Forwards a low-fan-out, sanitized snapshot of the focused field
# (label, placeholder, aria-*, input type, page title, page url
# origin+path, meta description) to the fluid-blank LLM call ONLY,
# for disambiguation ("destination" on flights.google.com vs
# airbnb.com). OFF by default. No sibling field labels, no field
# values, no env / cwd / agent state. Sensitive fields (password,
# CC, OTP) get null even when on. Today only the chrome integration
# gathers ambient context; native hosts return null. See
# docs/architecture/ambient-context.md.
ambient-context-mode: off

# Surface-availability flags. "on" means the surface is registered and
# ready to fire when matching input appears; "off" (or omitted) means the
# source is not built at all. The actual "is something running right now"
# state — e.g. is an agent task armed — is per-buffer runtime state and
# orthogonal to these flags.
# See packages/opencues-core/src/sources/build-sources.ts for what each gates.
fluid-blank-mode: on
word-cues-mode: on
transform-blank-mode: on

# Agent tuning. Debounce after the last keystroke before AgentRewrite
# fires (ms). Misparses or non-positive values fall back to 1000.
agent-debounce-ms: 1000

# Cap on parallel auditor calls per agent tick. Auditors run in
# isolated mode (one LLM call per auditor; results diff-merged by
# priority). 0 = uncapped. Set a positive number to bound LLM cost
# when many auditors are active. See spec/auditor-spec.md § Composition.
max-concurrent-auditors: 0

# Visual feedback while a `_` blank waits for its source (LLM call,
# script invocation, HTTP fetch). The slot's character animates through
# a short progression so the user can see "something is happening" —
# crucial for slow sources like LLM-backed answer / prompt / weather
# blanks. Set to `off` to disable.
#   bounce          →  `_` `-` `‾` `-` `_` …            vertical pulse, returns to `_`
#   braille-rotate  →  `_` once, then `⠁` `⠈` `⠐` `⠠` `⠄` `⠂` looping  (single dot clockwise)
#   flipper         →  `_` `\` `|` `/` `_` …             a mark flipping through orientations
#   custom          →  user-defined frames, see `blank-loading-frames` below
blank-loading-animation: bounce

# Custom animation frames. Comma-separated, up to 5 items. Only used
# when `blank-loading-animation: custom`. Each item is one frame —
# typically a single character but multi-char frames are allowed
# (e.g. for dot-walk style: `., .., ..., ...., .....`). Empty / invalid
# config silently falls back to `braille-rotate` so a misconfiguration
# can never produce a dead loading slot.
#
# Examples:
#   blank-loading-frames: ·,•,●,•,·          # pulse
#   blank-loading-frames: ◐,◓,◑,◒            # spinner
#   blank-loading-frames: .,..,...,....,..... # dot-walk
blank-loading-frames: ·,•,●,•,·

# Per-frame colour overrides. Two parallel lists — the host picks the
# one its terminal/UI can render:
#   blank-loading-colors-rgb   for hosts that render full colour
#                              (chrome). Accepts `#rrggbb`, `#rgb`, or
#                              `rgb(r,g,b)`. Up to 5 colours.
#   blank-loading-colors-ansi  for terminal hosts (CC / OC / gemini).
#                              Accepts named colours (`red`,
#                              `bright_cyan`, …) or 256-colour indices
#                              (`0`-`255`). Up to 5 colours.
# colour[i] is applied to frame[i]; frames past the colours-array length
# render with the host default (no colour override). Empty / invalid
# lists fall back to default rendering. Both lists can be set
# simultaneously — each host picks the relevant one.
#
# Defaults below cycle red → amber → green → cyan → blue (parallel to
# the 5-frame `blank-loading-frames` default). If the scalar is missing,
# empty, or fails to parse, the runtime falls back to this same shipped
# palette — there's no way to render the loading glyph without colour.
# (To make the colour invisible against your background, set the scalar
# to a single colour matching your terminal/editor bg.)
blank-loading-colors-rgb:  #ef4444,#f59e0b,#10b981,#06b6d4,#3b82f6
blank-loading-colors-ansi: red,yellow,green,cyan,blue
blank-loading-interval-ms: 150

# ─── settings: declarations + per-value tips ───────────────────────────
# Schema for the selector/satellite UI. Describes what each setting
# means + the tip shown for each value. Schema is owned by the runtime;
# additions get overwritten on state writes.
settings:
  voice-mode:
    tip: Gates TTS globally
    values:
      active: TTS reads tips aloud on navigation
      inactive: TTS is silenced
  debug-mode:
    tip: Enable debug logging output
    values:
      on: Debug output emitted to console
      off: Debug logging suppressed
  tips-mode:
    tip: Toggles tip display
    values:
      on: All tips shown
      off: Tips hidden
  cursor-navigate:
    tip: Auto-highlight word at cursor
    values:
      active: Highlight follows cursor to navigable words
      inactive: Manual navigation only
  ambient-context-mode:
    tip: Share focused-field label/placeholder/page-title with fluid-blank for disambiguation. No sibling field values; no system data. Sensitive fields excluded. Chrome only.
    values:
      on: Enabled — ambient block injected into fluid-blank prompt
      off: Disabled (default) — host returns null; ambient block never built
  fluid-blank-mode:
    tip: Free-form `_` lookups (P1+P3 LLM pipeline)
    values:
      on: Enabled — `_` next to a lookup phrase auto-substitutes the answer
      off: Disabled — fluid-blank ignored
  word-cues-mode:
    tip: Per-word cues (RoutedWordSourceGroup) on plain text — domain alternatives, synonyms
    values:
      on: Enabled — words matching a cue source's match/keywords get cycled alternatives
      off: Disabled — no word-cue LLM calls fire
  transform-blank-mode:
    tip: Imperative `_` slots + agent-task lifecycle (`agentically X _`, `add task X _`, `stop task _`)
    values:
      on: Enabled — `_` reaches transform-blank's classifier; agent tasks can be armed
      off: Disabled — `_` skips classification; `agentically X _` falls through to fluid-blank as a lookup
  agent-debounce-ms:
    tip: Pause after last keystroke before AgentRewrite fires (ms). Misparse → 1000.
    values:
      "150": Twitchy — fires almost immediately; great with cached rewrites, costly on cache misses
      "250": Snappy — fires before most users finish a word; noticeably more responsive than the default
      "500": Aggressive — fires shortly after each pause
      "1000": Default — balanced
      "2000": Relaxed — only fires after a clear stop
  max-concurrent-auditors:
    tip: Cap on parallel auditor calls per tick. 0 = uncapped. Bound LLM cost when many auditors are active.
    values:
      "0": Uncapped — all enabled auditors fire each tick
      "3": Bounded — top-3 priority-desc only
      "5": Bounded — top-5 priority-desc only
  blank-loading-animation:
    tip: Glyph progression shown at `_` while its source resolves. Stays in one column; restores to `_` on complete.
    values:
      bounce: `_` `-` `‾` `-` — vertical pulse, returns to `_` (default)
      braille-rotate: `_` once, then loops `⠁ ⠈ ⠐ ⠠ ⠄ ⠂` clockwise
      flipper: `_` `\` `|` `/` — a mark flipping through orientations
      custom: Use the user-defined frames from `blank-loading-frames`
      off: No animation — `_` stays static until substitution
  blank-loading-colors-rgb:
    tip: Per-frame RGB/HEX colours (chrome). Up to 5. Empty → host default.
  blank-loading-colors-ansi:
    tip: Per-frame ANSI colours (terminal hosts). Named or 256-index. Up to 5.
  blank-loading-interval-ms:
    tip: Per-frame duration in ms. Lower = snappier, higher = each colour stays visible longer.
    values:
      "75": Rapid — 75ms per frame, blurs into motion
      "150": Snappy (default) — 150ms per frame
      "300": Slow — 300ms per frame, each colour holds twice as long
---

# OPENCUES.md — Runtime Configuration

System-wide settings owned by the OpenCues runtime. Lives at
**user-level only** (`~/.cues/OPENCUES.md`, or
`$OPENCUES_HOME/OPENCUES.md` when set). Project-level overrides are
intentionally not supported — settings here apply across every
integration (Claude Code, OpenCode, Chrome).

The runtime hot-reloads this file: edit any scalar above and the next
keystroke picks it up within ~2s.

The runtime auto-manages this file via `OpenCuesSettingsBlank`: when
you cycle a setting through the selector/satellite UI, the runtime
rewrites the matching scalar in place. Hand-editing is allowed; the
`settings:` block schema is NOT user-customisable (additions get
overwritten).

---

## Optional overrides

Uncomment in the frontmatter above to override patch-supplied
defaults:

```yaml
tts-rate: 2
tts-script: ~/claude-code-cues/.opencues/scripts/speak.sh
```

---

## LLM provider selection

OpenCues ships with **six built-in providers**: groq (default),
openrouter, gemini, openai, anthropic, cerebras. The runtime picks
the right API key by provider:

| Provider | Env var |
|---|---|
| groq | `GROQ_API_KEY` |
| openrouter | `OPENROUTER_API_KEY` |
| gemini | `GEMINI_API_KEY` |
| openai | `OPENAI_API_KEY` |
| anthropic | `ANTHROPIC_API_KEY` |
| cerebras | `CEREBRAS_API_KEY` |

Set the env-var matching the provider you choose. If both
`GROQ_API_KEY` and `CEREBRAS_API_KEY` are set, OpenCues
auto-falls-back between them on transient errors.

**Global default** — applies to every LLM-driven surface unless a
more specific tier overrides it. Add to the frontmatter above:

```yaml
llm-provider: cerebras
llm-model: gpt-oss-120b
# llm-endpoint: https://api.cerebras.ai/v1/chat/completions
```

**Auto-route (default behavior)** — when NO `llm-provider:` is set,
OpenCues inspects which `<PROVIDER>_API_KEY` env-vars you've supplied
and picks the best provider you actually have, in this order:

```
cerebras > groq > gemini > anthropic > openai
```

Ranking is from the May 2026 5-provider benchmark sweep (see
`tests/benchmarks/BENCHMARKS.md`). Examples:

- `CEREBRAS_API_KEY` only → cerebras everywhere (fastest gpt-oss path)
- `CEREBRAS_API_KEY` + `GROQ_API_KEY` (typical) → cerebras primary,
  groq as transient-error fallback via the auto-fallback pair
- `GEMINI_API_KEY` only → gemini everywhere
- `ANTHROPIC_API_KEY` only → claude-haiku everywhere
- no keys → silent no-op, boot warns once

Set `llm-provider:` explicitly to override the auto-route.

**OpenAI defaults to `gpt-5.4-mini` + `reasoning_effort: low`** (cheapest
tier that performs well on rewrite tasks — `gpt-5.4-nano` was too
small, dropping multi-paragraph rewrites to 0%). For users with a
ChatGPT subscription, `chat-latest` (the gpt-5.5 Instant alias used in
ChatGPT) is bundled into some API tiers and is competitive on
accuracy (86–90% on transform-blank, 99–100% on fluid-blank) — opt in
per-feature:

```yaml
transform-blank-provider: openai
transform-blank-model:    chat-latest   # gpt-5.5 Instant
# subscriptions: Plus/Team plans include API credit for chat-latest;
# Enterprise plans bundle it. Listed price is $5/$30 per M tokens, so
# only worth it via subscription credit OR when no other provider is
# available. Cerebras / Gemini / Groq are ~30× cheaper per correct
# answer at near-equal accuracy.
```

**Per-feature overrides.** Each replaces the global pair for that
one surface. Provider and model are paired — a model setting only
applies when its tier's provider matches the resolved one.

```yaml
word-cues-provider: openrouter
word-cues-model:    openai/gpt-oss-120b:free

fluid-blank-provider: cerebras
fluid-blank-model:    gpt-oss-120b

transform-blank-provider: groq
transform-blank-model:    openai/gpt-oss-120b

agent-provider: cerebras
agent-model:    gpt-oss-120b
```

Spelling has no dedicated provider key — it's a regular word-scope
cue at `defaults/cues/spelling.md`
post-rename). It inherits per-cue frontmatter `provider:` / `model:`
overrides plus the `word-cues-*` and global tiers. To use a
different provider just for spelling, edit the cue file's
frontmatter.

**Per-cue / per-blank** overrides live in the individual CUE.md / BLANK.md
BLANK.md frontmatter as `provider:` / `model:` fields.

---

## See also

- [`docs/guides/llm-providers.md`](../docs/guides/llm-providers.md) — full provider guide.
- [`docs/benchmarks/2026-05-08-provider-bench.md`](../docs/benchmarks/2026-05-08-provider-bench.md) — speed + quality bench results.
