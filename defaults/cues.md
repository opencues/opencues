---
name: claude-code-cues
domain: claude-code
voice-mode: active
debug-mode: off
tips-mode: on
cursor-navigate: inactive
# All cue surfaces are opt-in. Flip to "on" to enable; missing/anything-else
# means off. See packages/opencues-core/src/sources/build-sources.ts for what
# each one gates.
fluid-blank-mode: on
spelling-mode: on
word-cues-mode: on
# Optional overrides — uncomment to override patch-supplied defaults.
# tts-rate: 2
# tts-script: ~/claude-code-cues/.opencues/scripts/speak.sh
# llm-model: openai/gpt-oss-120b
# llm-endpoint: https://api.groq.com/openai/v1/chat/completions
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
  spelling-mode:
    tip: Spell-checker — flags misspelled words in plain text, correction is the alternative
    values:
      on: Enabled — "the boy jumpved over the dog" cues "jumpved" → "jumped"
      off: Disabled
  word-cues-mode:
    tip: Per-word cues (RoutedWordSourceGroup) on plain text — domain alternatives, synonyms
    values:
      on: Enabled — words matching a cue source's match/keywords get cycled alternatives
      off: Disabled — no word-cue LLM calls fire
ignore: []
---

# cues.md

OpenCues master config. Settings + ignore list in frontmatter.
Per-source configs live as folders under cues/<name>/cue.md
(both static tip groups and LLM word-cue domains).
