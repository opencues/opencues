---
# ─────────────────────────────────────────────────────────────────────
# Cue source: {{NAME}}
# Created by `opencues new cue {{NAME}}`.
# ─────────────────────────────────────────────────────────────────────
#
# A folder-based cue source. The runtime merges this with
# monolithic cues.md; folder wins on name conflicts.
#
# ─────────────────────────────────────────────────────────────────────
# REQUIRED FIELD
# ─────────────────────────────────────────────────────────────────────
# parser:  alternatives | compute | answer | raw
#
#   alternatives — comma-separated options the user cycles through
#                  e.g. "happy, joyful, content"
#   compute      — LLM returns COMPUTE=<js-expr>, runtime evaluates
#                  e.g. COMPUTE=50*1.20 → "60"
#   answer       — LLM returns ANSWER=<text>, displayed verbatim
#                  e.g. ANSWER=Paris
#   raw          — LLM's raw string is the output (no parsing)

parser: alternatives

# ─────────────────────────────────────────────────────────────────────
# TRIGGERS (at least one recommended; if both omitted, source runs on
# every word in document scope)
# ─────────────────────────────────────────────────────────────────────
# match:     regex — only fires when the highlighted word matches
# keywords:  comma-separated — instant trigger (OR'd with match:)
#
# Examples:
#   match: \b[a-z]{4,}\b                        # 4+ letter lowercase words only
#   match: \b(happy|sad|angry|excited)\b        # specific words of interest
#   keywords: therefore, however, moreover      # formal connectors

# match: \b[a-z]{4,}\b
# keywords: foo, bar

# ─────────────────────────────────────────────────────────────────────
# PRIORITY + MERGE
# ─────────────────────────────────────────────────────────────────────
# priority: number (default 50)
#   Higher priority wins on merge conflicts between this source and
#   others (e.g. the monolithic cues.md ### section with same name).
#   Project-level always wins over user-level regardless of priority.

priority: 50

# ─────────────────────────────────────────────────────────────────────
# SCOPE
# ─────────────────────────────────────────────────────────────────────
# scope: word | document
#   word     — runs per highlighted word (default; most sources)
#   document — runs once for the whole input (rare; e.g. consume-all
#              blanks, summarisation sources)

# scope: word

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
# Auto-detect: a `script: ./X.sh` field implies "not chrome" (no
# subprocess in browsers). Override with `on-host:` if you have a
# runtime-class implementation that handles chrome separately.
# See docs/features/host-compat.md.

# on-host: chrome, claude-code, codex, opencode
# not-on-host: chrome
---
Suggest 3 alternatives for the highlighted word, considering the
surrounding sentence context. Output as a comma-separated list.

Example: "happy" → "joyful, pleased, content"
