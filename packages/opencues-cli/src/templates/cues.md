---
name: project-cues
domain: project
version: 1
---

# cues.md
#
# Project cue sources. Defines static word tips (for instant lookup)
# and LLM-backed cue sources (for dynamic alternatives).
#
# Files in .opencues/ are hot-reloaded — edit any of this and the next
# keystroke in claude-code / opencode / codex picks up the change
# within ~2s. No restart needed.
#
# ─────────────────────────────────────────────────────────────────────
# SECTION 1: Static tips (optional)
# ─────────────────────────────────────────────────────────────────────
#
# Per-word tips + alternatives loaded instantly (no LLM call). Use for
# a fixed domain vocabulary the user should see tips for.
#
# Two formats:
#   "words": { <word>: { tip, alts, speak? } }   — per-exact-word lookup
#   "groups": [ { synonyms: [...], tip, alts } ] — any synonym matches
#
# Uncomment + edit to use:

# ## Tips
#
# ```json
# [
#   {
#     "id": "tone",
#     "words": {
#       "happy": {
#         "tip": "Consider a warmer word for personal contexts",
#         "alts": ["glad", "cheerful", "content"],
#         "speak": false
#       },
#       "important": {
#         "tip": "Often vague — try a more specific word",
#         "alts": ["critical", "essential", "key"]
#       }
#     }
#   },
#   {
#     "id": "house-style",
#     "groups": [
#       {
#         "synonyms": ["quick", "fast", "rapid", "swift"],
#         "tip": "House style: prefer 'quick' in plain prose, 'rapid' in formal writing",
#         "alts": ["quick", "fast", "rapid", "swift"]
#       }
#     ]
#   }
# ]
# ```

# ─────────────────────────────────────────────────────────────────────
# SECTION 2: Ignore words (optional)
# ─────────────────────────────────────────────────────────────────────
#
# Words the runtime should NEVER suggest alternatives for. Plain list,
# one per line under `## Ignore`. Useful for proper nouns, branded
# terms, or any word you want left untouched.

# ## Ignore
#
# OpenCues
# London
# Anthropic

# ─────────────────────────────────────────────────────────────────────
# SECTION 3: LLM-backed cue sources
# ─────────────────────────────────────────────────────────────────────
#
# Each `### <name>` under `## Prompt` is one cue source. The runtime
# sends the section's PROMPT BODY + user's text to the LLM, parses
# per `parser:`. Multiple sources combine into a single LLM call when
# they all use the same parser (`alternatives` scope).
#
# Frontmatter fields per source (all inside the ```yaml``` block):
#
#   parser:      alternatives | compute | answer | raw   (REQUIRED)
#                - alternatives: comma-separated list of word options
#                - compute:      COMPUTE=<expression> → evaluated inline
#                - answer:       ANSWER=<text>         → single value
#                - raw:          the prompt returns a raw string verbatim
#
#   priority:    number (higher wins on merge conflicts; default 50)
#
#   match:       regex, word is only cued if the user's word matches
#                (instant — skips LLM call when unmatched)
#
#   keywords:    comma-separated keyword triggers (instant, OR'd with match)
#
#   scope:       word | document  (default: word)
#                word     → runs per highlighted word
#                document → runs once for the whole input
#
#   model:       override LLM model name (e.g. "openai/gpt-oss-120b")
#
#   tip:         status-line tip shown when a cued word is highlighted
#
#   speak:       bool — read tip aloud on navigation (default false)
#
# Example below. Uncomment + edit, or `opencues new cue <name>` to
# scaffold a separate folder-based cue source.

## Prompt

# ─────────────────────────────────────────────────────────────────────
# OUTPUT FORMAT — IMPORTANT FOR `parser: alternatives`
# ─────────────────────────────────────────────────────────────────────
#
# The runtime parses LLM responses in this exact form:
#
#     INDEX:alt1,alt2,alt3 | INDEX:alt1,alt2 | ...
#
# Where INDEX is the position (1-based) of the highlighted word in the
# input the LLM was given. For a single-word input the index is `1`.
#
# Multiple `alternatives` cue sources are COMBINED into one LLM call
# (one round trip = ~250ms instead of N × 250ms). The runtime appends
# `Output ONLY index:alternatives format` as the LAST line of the
# combined prompt — but you should still mention the format in your
# own prompt so the LLM doesn't drift mid-output.
#
# Example correct output for `1=happy` highlighted:
#   1:joyful,pleased,content
#
# Anything not in this shape gets dropped silently (no alts → no cycling).

# ### synonym
#
# ```yaml
# parser: alternatives
# priority: 50
# match: \b[a-z]{4,}\b
# ```
#
# Suggest 3 alternative words for the highlighted word that fit the
# surrounding sentence context.
#
# Format: INDEX:alt1,alt2,alt3
# Example: 1=happy → 1:joyful,pleased,content

# ### formal
#
# ```yaml
# parser: alternatives
# priority: 60
# keywords: therefore, however, moreover, furthermore
# tip: "more formal alternatives"
# ```
#
# Suggest 3 alternatives in a more formal register that preserve the
# meaning and fit the surrounding sentence.
#
# Format: INDEX:alt1,alt2,alt3
# Example: 1=however → 1:nevertheless,conversely,that said
