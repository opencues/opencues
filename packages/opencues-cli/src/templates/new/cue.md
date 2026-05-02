---
# ─────────────────────────────────────────────────────────────────────
# Cue source: {{NAME}}
# Created by `opencues new cue {{NAME}}`.
# ─────────────────────────────────────────────────────────────────────
#
# A folder-based cue source. The runtime merges this with the monolithic
# cues.md; folder wins on name conflicts. For a real reference, cat any
# of the shipped sources in ~/.opencues/cues/{legal,medical,financial}/.

# ─────────────────────────────────────────────────────────────────────
# REQUIRED FIELDS
# ─────────────────────────────────────────────────────────────────────
# name:    must match the folder name (the runtime uses this as the key)
# parser:  alternatives | raw
#
#   alternatives — comma-separated options the user cycles through.
#                  Output: INDEX:alt1,alt2,alt3 (1-based; |-separated batches
#                  for multi-word responses). Default for word-cue sources.
#   raw          — LLM's raw string is the output verbatim (rare).

name: {{NAME}}
parser: alternatives

# ─────────────────────────────────────────────────────────────────────
# SCOPE
# ─────────────────────────────────────────────────────────────────────
# scope: words | blanks | all
#   words   — runs per highlighted word (default for cues — what you want
#             for an alternatives source).
#   blanks  — runs only when the user types `_` (used by blank modes,
#             not normally a cue concern).
#   all     — runs in both contexts.

scope: words

# ─────────────────────────────────────────────────────────────────────
# TRIGGERS — required for word-cue sources
# ─────────────────────────────────────────────────────────────────────
# For `parser: alternatives` sources, you MUST set match: (regex) or
# keywords: (list). Sources without either are dropped at runtime.
#
#   match: regex             — only fires for words matching the regex.
#                              See defaults/cues/legal/cue.md for an
#                              example.
#   keywords: a, b, c        — case-insensitive word list.
#   match: .*                — explicit catch-all. If you really want a
#                              source that fires on every word, declare
#                              it explicitly so it's visible in tools.
#
# Routing per word: highest priority among matching sources wins. If
# nothing matches, the word gets no cue (not navigable).
#
# `opencues validate` warns when a word-cue source declares neither
# match: nor keywords:. See docs/features/word-cue-routing.md.

# match: \b(contract|agreement|clause|indemnify|warrant|liability|shall|herein|whereas)\b
# keywords: therefore, however, moreover

# ─────────────────────────────────────────────────────────────────────
# CLASSIFY (optional but recommended for DOMAIN sources)
# ─────────────────────────────────────────────────────────────────────
# Free-text description of this source's domain. The runtime injects it
# into the LLM prompt to keep responses tonally appropriate. Especially
# helpful for narrow domains where generic synonyms would be wrong.
#
# Defaults/cues/legal/cue.md:
#   classify: Legal terminology, contract drafting, statutory definitions
#
# Skip for broad catch-all sources (`match: .*`) — the LLM doesn't need extra framing.

# classify: Description of this source's domain

# ─────────────────────────────────────────────────────────────────────
# PRIORITY
# ─────────────────────────────────────────────────────────────────────
# priority: number (default 50)
#   Higher priority wins on merge conflicts (e.g. monolithic cues.md
#   with same name vs this folder source). Narrow domain sources usually
#   use 70-80, broad catch-alls 50, classifier 100.

priority: 50

# ─────────────────────────────────────────────────────────────────────
# OPTIONAL FIELDS
# ─────────────────────────────────────────────────────────────────────
# model:   override LLM model for this source only (e.g. "openai/gpt-oss-120b")
# tip:     statusline tip shown when a cued word is highlighted
# speak:   bool — read tip via TTS on navigation (default false)

# model: openai/gpt-oss-120b
# tip: "alternative word suggestions"
# speak: false

# ─────────────────────────────────────────────────────────────────────
# HOST COMPATIBILITY (advanced)
# ─────────────────────────────────────────────────────────────────────
# Most cues run on every integration (claude-code, opencode, codex,
# chrome). Pure LLM cues like this one have no host-specific dependencies
# — leave the fields below alone.
#
# When you need to declare:
#   on-host:     [chrome, claude-code, ...]   — allow-list (overrides auto)
#   not-on-host: [chrome]                     — deny-list (filters from auto / on-host)
#
# Host names: chrome, claude-code, codex, opencode.
# See docs/features/host-compat.md.

# on-host: chrome, claude-code, codex, opencode
# not-on-host: chrome
---
Suggest 3 alternatives for each highlighted word, considering the
surrounding sentence context.

# ── Output format (parser: alternatives) ───────────────────────────
# The runtime parses INDEX:alt1,alt2,alt3 — INDEX is the 1-based
# position of the highlighted word. For multi-word responses, separate
# batches with | (vertical bar). Example: 1=happy 3=fast → 1:joyful,
# pleased,content|3:quick,rapid,swift. Anything not in this format gets
# dropped silently. The runtime appends a final reminder to the combined
# prompt; include the format here too so the LLM doesn't drift.
Format: INDEX:alt1,alt2,alt3|INDEX:alt1,alt2

Examples:
- 1=happy → 1:joyful,pleased,content
- 1=fast 3=red → 1:quick,rapid,swift|3:crimson,scarlet,vermilion
