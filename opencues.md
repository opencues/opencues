---
version: 1
voice-mode: active
debug-mode: off
tips-mode: on
cursor-navigate: inactive
output-format: rich markdown
display mode: split pane
# Optional overrides — uncomment to override patch-supplied defaults.
# tts-rate: 2
# tts-script: ~/.claude/actions/speak.sh
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
    tip: Controls tip display level
    values:
      on: All tips shown
      off: Tips hidden
  output-format:
    tip: Response format style
    values:
      plain text: Unformatted plain text output
      rich markdown: Formatted markdown with styling
      structured json: Machine-readable JSON output
  cursor-navigate:
    tip: Auto-highlight word at cursor
    values:
      active: Highlight follows cursor to navigable words
      inactive: Manual navigation only
  display mode:
    tip: Layout mode
    values:
      focus: Single-pane focused view
      split pane: Side-by-side split layout
      zen: Distraction-free minimal view
---
