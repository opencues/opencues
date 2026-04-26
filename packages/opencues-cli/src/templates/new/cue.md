---
# ─────────────────────────────────────────────────────────────────────
# Cue source: {{NAME}}
# Created by `opencues new cue {{NAME}}`.
# ─────────────────────────────────────────────────────────────────────
#
# A folder-based cue source. The runtime merges this with the monolithic
# cues.md; folder wins on name conflicts. For a real reference, cat any
# of the shipped sources in ~/.opencues/cues/{grammar,legal,medical,financial}/.

# ─────────────────────────────────────────────────────────────────────
# REQUIRED FIELDS
# ─────────────────────────────────────────────────────────────────────
# name:    must match the folder name (the runtime uses this as the key)
# parser:  alternatives | compute | answer | raw
#
#   alternatives — comma-separated options the user cycles through.
#                  Output: INDEX:alt1,alt2,alt3 (1-based; |-separated batches
#                  for multi-word responses). Default for word-cue sources.
#   compute      — LLM returns COMPUTE=<js-expr>, runtime evaluates.
#                  e.g. COMPUTE=50*1.20 → "60". Used by math blanks.
#   answer       — LLM returns ANSWER=<text>, displayed verbatim.
#                  e.g. ANSWER=Paris. Used by factual blanks.
#   raw          — LLM's raw string is the output (no parsing).

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
# TRIGGERS — also decide DEFAULT vs DOMAIN routing
# ─────────────────────────────────────────────────────────────────────
# For `parser: alternatives` sources, the presence (or absence) of
# match:/keywords: classifies the source for per-word routing:
#
#   match: OR keywords: set    → DOMAIN source
#                                Only fires for words that match the
#                                regex / keyword list. Use for narrow
#                                vocabularies (legal, medical, formal).
#                                See defaults/cues/legal/cue.md for a
#                                production example.
#
#   neither match nor keywords → DEFAULT source
#                                Catches every word no domain claimed.
#                                Most projects want exactly ONE default
#                                (e.g. a general "synonyms" source).
#                                See defaults/cues/grammar/cue.md.
#
# Routing per word (highest priority wins within each tier):
#   1. Domain whose match/keyword hits the word → that source.
#   2. No domain hit → highest-priority default.
#   3. No default exists → no cue (word isn't navigable).
#
# `opencues validate` warns when a project has zero defaults or
# multiple defaults at the same priority. See docs/features/word-alt-routing.md.

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
# Skip for plain default sources (the LLM doesn't need extra framing).

# classify: Description of this source's domain

# ─────────────────────────────────────────────────────────────────────
# PRIORITY
# ─────────────────────────────────────────────────────────────────────
# priority: number (default 50)
#   Higher priority wins on merge conflicts (e.g. monolithic cues.md
#   with same name vs this folder source). Domain sources usually use
#   70-80, defaults 50, classifier 100.

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
