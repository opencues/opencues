---
# ─────────────────────────────────────────────────────────────────────
# Blank-fill mode: {{NAME}}
# Created by `opencues new blank {{NAME}}`.
# ─────────────────────────────────────────────────────────────────────
#
# A folder-based blank mode. The runtime merges this with modes
# declared in monolithic blanks.md; folder wins on name conflicts.
#
# Blank modes fire when the user types `_`. Mode selection cascades:
#   1. `match:` regex     (instant — any mode whose regex matches wins)
#   2. `keywords:` list   (instant — OR'd with match:)
#   3. LLM classifier     (fallback — blanks.md `### classifier` picks)
#
# ─────────────────────────────────────────────────────────────────────
# REQUIRED FIELD
# ─────────────────────────────────────────────────────────────────────
# parser:  alternatives | compute | answer | raw
#
#   alternatives — comma-separated options the user cycles through
#                  e.g. "joyful, pleased, content"
#   compute      — LLM returns COMPUTE=<js-expr>, runtime evaluates
#                  e.g. COMPUTE=50*1.20 → "60"
#   answer       — LLM returns ANSWER=<text>, displayed verbatim
#                  e.g. ANSWER=Paris
#   raw          — LLM's raw string is the output (no parsing)

parser: answer

# ─────────────────────────────────────────────────────────────────────
# TRIGGERS (optional but recommended — otherwise relies on classifier)
# ─────────────────────────────────────────────────────────────────────
# match:     regex — instant trigger when input matches
# keywords:  comma-separated — instant trigger (OR'd with match:)
#
# Examples:
#   match: \d+\s*[+\-*/]\s*\d+       # arithmetic expressions
#   match: (capital|ceo|founder) of  # factual questions
#   keywords: math, calc, compute    # direct keyword triggers

# match:
# keywords:

# ─────────────────────────────────────────────────────────────────────
# PRIORITY
# ─────────────────────────────────────────────────────────────────────
# priority: number (default 50)
#   Higher priority wins when multiple modes match (match: or keywords:
#   ties). Also determines classifier preference on ambiguous inputs.
#   Classifier itself usually has priority: 100.

priority: 100

# ─────────────────────────────────────────────────────────────────────
# SCOPE
# ─────────────────────────────────────────────────────────────────────
# scope: word | document
#   word     — fills a single `_` blank (default; most modes)
#   document — consume-all mode; runs once for the whole input
#              (e.g. "improve the whole prompt" patterns)

# scope: word

# ─────────────────────────────────────────────────────────────────────
# OPTIONAL FIELDS
# ─────────────────────────────────────────────────────────────────────
# model:  override LLM model for this mode only

# model: openai/gpt-oss-120b
---
Answer the user's question concisely. Output one line, no preamble.

Example: "The capital of France is _" → ANSWER=Paris
