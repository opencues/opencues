---
# ─── Top-level scalars (current values) ────────────────────────────────
# Cycled by selector/satellite navigation; rewritten in place by the
# runtime when the user cycles a setting. Hand-edit allowed.
voice-mode: active
debug-mode: off
tips-mode: on
cursor-navigate: inactive

# nav-keymap — modifier combo for word navigation (Left/Right) and
# alternative cycling (Up/Down).
#   auto       (default): resolves to ctrl-alt on every host.
#   ctrl-alt   : Ctrl+Alt+Arrow (Ctrl+Option+Arrow on macOS — in
#                Terminal.app enable "Use Option as Meta key" so the
#                combo survives).
#   ctrl-shift : for terminals that forward ctrl-shift but not
#                ctrl-alt. Chrome always uses ctrl-alt regardless
#                (ctrl-shift+arrow extends browser text selection).
nav-keymap: auto

# max-thinking — how hard reasoning-capable models think before
# answering. Each verified model has a bench-tuned CEILING (cerebras
# gpt-oss → medium, groq/openai/openrouter gpt-oss & gpt-5 → low) and a
# reduced OFF level (cerebras → low, the rest → none). See
# packages/opencues-core/src/model-thinking.ts.
#   on  (default): each model reasons up to its ceiling — identical to
#                  the pre-feature behaviour.
#   off          : each model drops to its reduced level for faster,
#                  cheaper cues + blanks ("thinking too much is too slow").
# Applies to word-cues, sentence-cues, fluid-blank, transform-blank, and
# agent-rewrite. The fluid-config classifier always reasons at `low`
# regardless. Non-reasoning providers (anthropic, gemini) ignore it.
max-thinking: on

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

# calendar-context-mode — let fluid-blank reason over your calendar
# (`am i free thursday _`, `where is my next event _`). ON by default,
# but INERT until you add a feed with `opencues calendar add <ics-url>`
# — adding a calendar IS the opt-in. Titles + locations are dehydrated
# to tokens hydrated locally; only anonymized busy-interval times reach
# the LLM. Set to `off` to disable even with a feed configured.
# See docs/architecture/calendar-context.md.
calendar-context-mode: on

# identity-context-mode — personal-data injection for fluid-blank.
# Pulls field data from ~/.cues/IDENTITY.md (your first name, email,
# work city, etc.) and offers it to FluidBlankSource so `_` lookups
# personalise without you re-typing the same info.
#   off          : IDENTITY.md never read; no personal data reaches any prompt.
#   safe (default): catalog of TOKENS + descriptions injected. The LLM
#                   emits `[FIRST NAME]` etc; a post-processor substitutes
#                   your real values AFTER the response. Your PII never
#                   reaches the LLM provider's logs.
# Users who never created an IDENTITY.md see no behavioural diff — the
# catalog is empty so no tokens reach the prompt.
# A `raw` mode (catalog values inlined into the prompt) is also
# implementation-complete but deferred to Phase 2 — set it directly
# here if you want, but it's intentionally not exposed in the
# selector-satellite menu to prevent accidental flips. See
# docs/architecture/identity-context.md § Future work.
identity-context-mode: safe

# fluid-config-mode — semantic `_` → settings-change classifier. When
# a `_` lookup phrases the surrounding text like a settings change
# ("enable debug logging _", "switch to cerebras _", "turn on voice
# mode _"), one LLM call classifies it against the FEATURES registry
# and applies the matched setting + drops a selector-satellite pair as
# visual confirmation. Routes ONLY to OPENCUES scalars, never user
# blanks (the routing layer's prompt enumerates only registry-cyclable
# values; runtime guard rejects anything else).
#   off          : `_` falls through to fluid-blank as a generic lookup.
#   on (default) : every `_` pays one extra ~200-300ms LLM call (Cerebras
#                  prefix-cached) to classify settings intent; on hit,
#                  setting is applied. Bench-validated at 100% precision.
# See docs/architecture/fluid-config.md.
fluid-config-mode: on

# undo-mode — natural-language undo/redo of OpenCues-applied changes.
# "undo _" reverts the last change OpenCues made (a blank fill, a
# transform rewrite, a settings write, a volume/brightness set);
# "redo _" re-applies it; "undo 3 _" reverts three. Language-invariant
# (classified by the same config-intent LLM call as fluid-config, so
# "元に戻して _" and "deshacer _" work too). Reverts are exact-match-
# or-refuse: if you've edited the text since, the stale part is
# skipped and reported, never guessed at. External effects of user-
# pack blanks (fetch/exec) are NOT reversible and are reported as such.
#   on (default) : `undo _` / `redo _` revert from the session journal.
#   off          : undo/redo verdicts cede; `_` falls through.
# See docs/architecture/undo.md.
undo-mode: on

# blank-context-mode — blanks expose their current values as ambient
# tokens for fluid-blank, so a `_` lookup can reach stock prices,
# weather, crypto rates etc. WITHOUT typing the keyword. e.g. "buy
# more apple if _" resolves AAPL even though the user didn't write
# "apple _". `safe` ships a tokens-only catalog to the LLM; the
# runtime post-processor substitutes live values AFTER the response.
# Values never reach the provider's logs.
#   off          : blanks only fire on the keyword-trigger path.
#   safe (default): catalog of context-eligible blanks injected as tokens.
# A `raw` mode (values inlined into the prompt) is implementation-
# complete but kept off the menu; requires identity-context-mode: raw too.
# See docs/architecture/blank-as-context.md.
blank-context-mode: safe

# Surface-availability flags. "on" means the surface is registered and
# ready to fire when matching input appears; "off" (or omitted) means the
# source is not built at all. The actual "is something running right now"
# state — e.g. is an agent task armed — is per-buffer runtime state and
# orthogonal to these flags.
# See packages/opencues-core/src/sources/build-sources.ts for what each gates.
word-cues-mode: on
transform-blank-mode: on
# contradiction-cues-mode — ON by default. Passive fact-check cues (weekday-date
# mismatch, split-the-bill math, and data-wired tiers) that flag a wrong claim
# you typed; they never edit the buffer. Set to `off` to disable.
contradiction-cues-mode: on
# sentence-cues-mode — ON by default. Whole-sentence cues (e.g. more-formal,
# which is allow-listed to LinkedIn + web email via on-site). Each cue self-
# scopes, so nothing fires on casual surfaces it opts out of. Set to `off` to
# disable the class.
sentence-cues-mode: on

# integration-weave-mode — let a blank with `integration-weave: true` weave
# its `integration:` output into the surrounding prose with one LLM call,
# instead of the static `{value}` template. The blank's REAL value is never
# sent to the provider: the LLM only sees the exemplar with `{value}` replaced
# by a sentinel token, and the runtime swaps the real value back in AFTER the
# response. Falls back to the static template on any failure, so a weave can
# never block the fill or corrupt the buffer.
#   off (default): `integration:` is a static `{value}` template, zero LLM.
#   on           : opted-in blanks pay one ~300-700ms LLM call per fill to
#                  weave the value into context (the static fill lands first,
#                  then the woven version merges in).
# See docs/architecture/blank-integration.md.
integration-weave-mode: off

# blank-trigger-mode — when `_` actually fires its blank.
#   immediate (default): blank fires the moment `_` is inserted —
#                        the original v0.1 behaviour, snappy but
#                        sometimes catches markdown italic typists
#                        on the first underscore.
#   spaced             : blank fires only after a confirming space
#                        follows `_`. Lets you type `_italic_` without
#                        the first `_` substituting. One extra keystroke
#                        (the space) for cases where you DID want a blank.
# See docs/features/blank-trigger-mode.md.
blank-trigger-mode: immediate

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

# The selector/satellite menu schema (tips + per-value descriptions
# for every setting above) is now owned by the @opencues/core
# FEATURES + MENU_TUNABLES registry — single source of truth shared
# across doctor, install, the runtime, and every host. Adding a new
# setting is one PR to packages/opencues-core/src/feature-registry.ts;
# no edit to this file is required. To customise the menu (different
# tips, hidden settings, custom value order), ship a `settings:` block
# below — the file-level block fully replaces the registry defaults
# when present.
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
rewrites the matching scalar in place. Hand-editing is allowed.

The cycling menu itself (tips + per-value descriptions for every
setting) lives in `@opencues/core`'s `FEATURES` + `MENU_TUNABLES`
registry, NOT in this file. To customise the menu (different tip
text, hide settings, custom value order), ship your own `settings:`
block in the frontmatter above — when present, it fully replaces
the registry defaults.

---

## Optional overrides

Uncomment in the frontmatter above to override patch-supplied
defaults:

```yaml
tts-rate: 2
tts-script: ~/.opencues/forks/claude-code/.cues/scripts/speak.sh
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

**`weather-location` (Tier 5 contradiction cues)** — the outdoor-plan-vs-rain
check auto-detects your location from the host timezone (e.g. `Europe/London`
→ London), so nothing is needed by default. To override, set a **city name**
(geocoded automatically) or `lat,lon`:

```yaml
weather-location: Manchester
# weather-location: 53.48,-2.24
```

Spelling has no dedicated provider key — it's a regular word-scope
cue at `defaults/cues/spelling/CUE.md`
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
