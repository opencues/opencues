---
# ─── Top-level scalars (current values) ────────────────────────────────
# Cycled by selector/satellite navigation; rewritten in place by the
# runtime when the user cycles a setting. Hand-edit allowed.
voice-mode: active
debug-mode: off
tips-mode: on
cursor-navigate: inactive

# Cue-surface enable flags. Opt-in: omit or set to anything other than
# "on" to disable. See packages/opencues-core/src/sources/build-sources.ts
# for what each one gates.
fluid-blank-mode: on
word-cues-mode: on

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
llm-provider: groq
llm-model: openai/gpt-oss-120b
# llm-endpoint: https://api.groq.com/openai/v1/chat/completions
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
cue at `defaults/cues/spelling.md` (was `defaults/words/spelling.md`
post-rename). It inherits per-cue frontmatter `provider:` / `model:`
overrides plus the `word-cues-*` and global tiers. To use a
different provider just for spelling, edit the cue file's
frontmatter.

**Per-cue / per-blank** overrides live in the individual cue.md /
BLANK.md frontmatter as `provider:` / `model:` fields.

---

## See also

- [`docs/guides/llm-providers.md`](../docs/guides/llm-providers.md) — full provider guide.
- [`docs/benchmarks/2026-05-08-provider-bench.md`](../docs/benchmarks/2026-05-08-provider-bench.md) — speed + quality bench results.
