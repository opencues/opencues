---
name: project-cues
domain: project
version: 1
---

# CUES.md
#
# Project cue sources. Defines static word tips (for instant lookup)
# and LLM-backed cue sources (for dynamic alternatives).
#
# Files in .cues/ are hot-reloaded — edit any of this and the next
# keystroke in claude-code / opencode / gemini-cli picks up the change
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
# WORD-ALT ROUTING — DEFAULT vs DOMAIN SOURCES
# ─────────────────────────────────────────────────────────────────────
#
# Multiple `### alternatives` cue sources can coexist. The runtime
# routes each highlighted word to ONE source (not all of them) based
# on per-source `match:` (regex) / `keywords:` (list).
#
# Every source MUST set match: or keywords:. Sources with neither are
# dropped at runtime. If you really want a catch-all that fires on
# every word, declare it explicitly with `match: .*`.
#
# Routing per word:
#   1. Highest-priority source whose match-regex hits OR whose
#      keywords list contains the word wins.
#   2. If nothing matched → no cue. Word isn't navigable.
#
# Examples:
#   "contract" → keyword in legal → legal wins
#   "however"  → keyword in formal → formal wins
#   "happy"    → no source claims it → no cue
#
# See docs/features/word-cue-routing.md for the full spec.

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
# Each cue source's prompt runs as its OWN LLM call (one per source
# per text change, dispatched in parallel). Always include the format
# spec in your own prompt body so the LLM doesn't drift.
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
# # No match: AND no keywords: → this is the DEFAULT source. Catches
# # any word that no domain source claimed. Drop this section if you
# # want an opt-in project (only specific words get cued).
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
# # `keywords:` makes this a DOMAIN source. Fires only when the
# # highlighted word is in the keyword list.
# tip: "more formal alternatives"
# ```
#
# Suggest 3 alternatives in a more formal register that preserve the
# meaning and fit the surrounding sentence.
#
# Format: INDEX:alt1,alt2,alt3
# Example: 1=however → 1:nevertheless,conversely,that said
