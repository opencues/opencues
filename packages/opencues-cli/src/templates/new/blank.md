---
# Blank-fill mode: {{NAME}}
# Created by `opencues new blank {{NAME}}`.
#
# Triggered when the user types `_`. The classifier picks which mode
# to use based on `match:` (instant) → `keywords:` (instant) → LLM
# classifier (fallback).
#
# Required fields:
#   parser: alternatives | compute | answer | raw
#
# Common optional fields:
#   match: <regex>     — instant trigger via regex
#   keywords: a, b, c  — instant trigger via keyword
#   priority: 100      — higher wins on classifier ties
parser: answer
priority: 100
---
Answer the user's question concisely. Output one line, no preamble.
