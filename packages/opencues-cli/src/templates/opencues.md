---
version: 1

# ─────────────────────────────────────────────────────────────────────
# opencues.md — system settings (runtime-owned)
# ─────────────────────────────────────────────────────────────────────
#
# This file lives at user-level ONLY (~/.opencues/opencues.md). The
# schema (voice-mode, tips-mode, debug-mode, cursor-navigate, …) is
# defined by the OpenCues runtime — not by users or projects — and
# settings are system-wide: one voice-mode value applies across every
# integration (Claude Code, OpenCode, Chrome, Codex).
#
# The runtime auto-manages this file via OpenCuesSettingsControl: when
# you cycle a setting through the selector/satellite UI, the runtime
# rewrites the matching `name: value` line in place. `opencues
# seed-configs` (no flag) can also re-seed defaults if the file is
# missing or corrupted.
#
# You can hand-edit scalar values (voice-mode: active/inactive) if you
# prefer, but the settings block shape is NOT user-customisable — the
# runtime overwrites additions during state writes.
#
# Two sections:
#   TOP-LEVEL SCALARS — current values. Cycled by selector/satellite
#                       navigation ("voice-mode active" → Up cycles to
#                       "inactive"). The runtime writes updates back
#                       into this file when the user cycles.
#   SETTINGS BLOCK   — declarations + per-value tips for the selector/
#                      satellite system. Describes what each setting
#                      means; the scalar above is the current value.
#
# ─────────────────────────────────────────────────────────────────────
# STANDARD SCALARS
# ─────────────────────────────────────────────────────────────────────
#
# voice-mode:       active | inactive       gates TTS globally
# tips-mode:        on | off                hides tips in statusline
# debug-mode:       on | off                extra logging → /tmp/opencues.log
# cursor-navigate:  active | inactive       auto-highlight word at cursor
#
# Custom scalars can be added — any `<name>: <value>` pair that has a
# matching entry in `settings:` below becomes a navigable selector.

voice-mode: active
tips-mode: on
debug-mode: off
cursor-navigate: inactive

# Example custom scalars (uncomment + add matching settings block entries):
# output-format: rich markdown
# display-mode: split pane

# ─────────────────────────────────────────────────────────────────────
# OPTIONAL OVERRIDES
# ─────────────────────────────────────────────────────────────────────
# Uncomment to override the integration's built-in defaults.
#
# tts-rate: 2
# tts-script: ~/.opencues/scripts/speak.sh
# llm-model: openai/gpt-oss-120b
# llm-endpoint: https://api.groq.com/openai/v1/chat/completions

# ─────────────────────────────────────────────────────────────────────
# SETTINGS BLOCK — per-scalar tips + value enumeration
# ─────────────────────────────────────────────────────────────────────
#
# Shape:
#   settings:
#     <scalar-name>:
#       tip: <string>          selector tip shown when the setting's
#                              current value is highlighted
#       values:
#         <value>: <tip>       each value becomes a cycleable option;
#                              satellite tip shown when that value is highlighted
#
# The order of keys in `values:` determines the cycle order.
# Cycling past the last value wraps to the first.

settings:
  voice-mode:
    tip: Gates TTS globally
    values:
      active: TTS reads tips aloud on navigation
      inactive: TTS is silenced
  tips-mode:
    tip: Controls tip display level
    values:
      on: All tips shown in statusline
      off: Tips hidden
  debug-mode:
    tip: Enable debug logging output
    values:
      on: Debug output emitted to /tmp/opencues.log
      off: Debug logging suppressed
  cursor-navigate:
    tip: Auto-highlight word at cursor
    values:
      active: Highlight follows cursor to navigable words
      inactive: Manual navigation only (Ctrl+Alt+arrows)

  # Example custom setting — uncomment the matching scalar above to activate:
  # output-format:
  #   tip: Response format style
  #   values:
  #     plain text: Unformatted plain text output
  #     rich markdown: Formatted markdown with styling
  #     structured json: Machine-readable JSON output
---
