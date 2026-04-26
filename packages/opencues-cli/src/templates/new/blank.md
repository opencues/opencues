---
# ─────────────────────────────────────────────────────────────────────
# Blank-fill mode: {{NAME}}
# Created by `opencues new blank {{NAME}}`.
# ─────────────────────────────────────────────────────────────────────
#
# A folder-based blank mode. The runtime merges this with modes
# declared in monolithic blanks.md (`### name` sections); folder wins
# on name conflicts. NOTE: all shipped blank modes today live in the
# monolithic defaults/blanks.md — folder-based blanks work but aren't
# in production use yet, so review your output against `### math`,
# `### factual`, etc. there for the canonical patterns.
#
# Blank modes fire when the user types `_`. Mode selection cascades:
#   1. `match:` regex     (instant — any mode whose regex matches wins)
#   2. `keywords:` list   (instant — OR'd with match:)
#   3. LLM classifier     (fallback — blanks.md `### classifier` picks)

# ─────────────────────────────────────────────────────────────────────
# REQUIRED FIELDS
# ─────────────────────────────────────────────────────────────────────
# name:    must match the folder name
# parser:  alternatives | math | compute | answer | raw
#
#   alternatives — comma-separated options the user cycles through
#                  (rare for blanks; usually controls do this via stepValues)
#   math         — numeric expressions; LLM returns COMPUTE=<expr>;
#                  runtime evaluates with safe sandbox. Used by `### math`
#                  for "4 * 12 = _" style inputs.
#   compute      — generic COMPUTE=<expr> form (math is the common case)
#   answer       — LLM returns ANSWER=<text>, displayed verbatim
#                  e.g. ANSWER=Paris. Used by `### factual`.
#   raw          — LLM's raw string is the output (no parsing).

name: {{NAME}}
parser: answer

# ─────────────────────────────────────────────────────────────────────
# SCOPE
# ─────────────────────────────────────────────────────────────────────
# scope: words | blanks | all
#   blanks  — fills a single `_` blank (default for blank modes — what
#             you want).
#   words   — runs per highlighted word (cue mode; not normally a blank
#             concern).
#   all     — runs in both contexts.

scope: blanks

# ─────────────────────────────────────────────────────────────────────
# TRIGGERS (optional but recommended — otherwise relies on classifier)
# ─────────────────────────────────────────────────────────────────────
# match:     regex — instant trigger when input matches
# keywords:  comma-separated — instant trigger (OR'd with match:)
#
# Examples (lifted from defaults/blanks.md):
#   ### math:    match: \d+\s*[+\-*/^%]\s*\d+|\d+%
#                keywords: factorial, average, half of, double, triple,
#                          square root, sqrt, power of, tip, tax, ...
#
#   ### factual: match: the (capital|ceo|founder|author|inventor|...) of .+ is
#                keywords: capital of, ceo of, founder of, who is, who was

# match: <regex>
# keywords: <comma,separated>

# ─────────────────────────────────────────────────────────────────────
# PRIORITY
# ─────────────────────────────────────────────────────────────────────
# priority: number (default 50)
#   Higher priority wins when multiple modes match (match: or keywords:
#   ties). The LLM classifier itself uses priority: 100; specific modes
#   like math/factual use 90.

priority: 100

# ─────────────────────────────────────────────────────────────────────
# OPTIONAL FIELDS
# ─────────────────────────────────────────────────────────────────────
# model:  override LLM model for this mode only

# model: openai/gpt-oss-120b

# ─────────────────────────────────────────────────────────────────────
# HOST COMPATIBILITY (advanced)
# ─────────────────────────────────────────────────────────────────────
# Most blanks run everywhere. Override only when this mode depends on
# something a particular host can't provide (e.g. subprocess access).
#   on-host:     allow-list (e.g. [claude-code, opencode, codex, chrome])
#   not-on-host: deny-list  (e.g. [chrome])
# See docs/features/host-compat.md.

# on-host: chrome, claude-code, codex, opencode
# not-on-host: chrome
---
Answer the user's question concisely. Output one line, no preamble.

Example: "The capital of France is _" → ANSWER=Paris
