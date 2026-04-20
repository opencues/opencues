---
name: project-blanks
domain: project
version: 1
---

# blanks.md
#
# Blank-fill modes. When the user types `_`, the runtime picks a mode
# (classifier) and asks the LLM to fill the blank according to that
# mode's prompt + parser.
#
# ─────────────────────────────────────────────────────────────────────
# HOW MODE SELECTION WORKS
# ─────────────────────────────────────────────────────────────────────
#
# Three-stage cascade, fastest-first:
#   1. `match:` regex (instant)     → if ANY mode's regex matches, that mode wins
#   2. `keywords:` list (instant)   → if no regex matched, check keywords
#   3. `### classifier` LLM call    → fallback for ambiguous inputs
#
# Priority breaks ties at each stage. Higher priority = preferred.
#
# ─────────────────────────────────────────────────────────────────────
# IGNORE WORDS (optional)
# ─────────────────────────────────────────────────────────────────────
#
# Words the runtime should never treat as part of a blank-fill context.
# One per line under `## Ignore`.

# ## Ignore
#
# OpenCues
# Claude

## Prompt

# ─────────────────────────────────────────────────────────────────────
# THE CLASSIFIER — picks which mode to use when fast heuristics miss
# ─────────────────────────────────────────────────────────────────────
#
# Runs ONLY when `match:` and `keywords:` on all other modes fail to
# trigger. The classifier's output (MODE=XYZ) picks the mode whose
# `### <name>` matches (case-insensitive). Must list every mode you
# define below in its Output section.
#
# `priority: 100` ensures the classifier itself is checked first when
# present; in practice only ONE classifier should exist per blanks.md.

# ### classifier
#
# ```yaml
# priority: 100
# ```
#
# Classify the input into one mode: MATH, FACTUAL, GRAMMAR.
#
# NOTE: This classifier only runs when the fast heuristics (match + keywords
# on each mode) don't match anything.
#
# MATH - calculations, numbers with operators, word math:
#   - "4 * 12 = _" → MATH
#   - "half of 16 = _" → MATH
#   - "50 plus 20% tax = _" → MATH
#
# FACTUAL - specific facts, names, dates, knowledge lookups:
#   - "The CEO of Apple is _" → FACTUAL
#   - "The capital of France is _" → FACTUAL
#
# GRAMMAR - word alternatives, synonyms, completions (default fallback):
#   - "The quick brown _" → GRAMMAR
#   - "happy _" → GRAMMAR
#
# Output ONLY: MODE=MATH | MODE=FACTUAL | MODE=GRAMMAR

# ─────────────────────────────────────────────────────────────────────
# MODE SECTIONS — each defines one fill behaviour
# ─────────────────────────────────────────────────────────────────────
#
# Frontmatter per mode (all inside the ```yaml``` block):
#
#   parser:    alternatives | compute | answer | raw   (REQUIRED)
#              - alternatives: comma-separated options the user cycles
#              - compute:      COMPUTE=<expr> → evaluated (math)
#              - answer:       ANSWER=<text>  → single value
#              - raw:          prompt returns a verbatim string
#
#   priority:  number (higher wins on ties; default 50)
#
#   match:     regex — if the user's input matches, this mode wins instantly
#              without calling the classifier
#
#   keywords:  comma-separated triggers — instant match (OR'd with match:)
#
#   scope:     word | document (default: word)
#              Usually `word` for blanks; `document` for "improve the whole
#              prompt" patterns (see consume-all blanks docs)
#
#   model:     override LLM model

# ### math
#
# ```yaml
# parser: compute
# priority: 100
# match: \d+\s*[+\-*/]\s*\d+|\d+\s*%|percent of|plus|minus|times|divided
# keywords: math, calc, compute, result of
# ```
#
# Compute the expression. Output ONLY: COMPUTE=<javascript-expression>
# The runtime evaluates the expression and substitutes the result.
#
# Examples:
#   - 4 * 12 = _ → COMPUTE=4*12
#   - half of 16 = _ → COMPUTE=16/2
#   - 50 plus 20% tax = _ → COMPUTE=50*1.20
#   - celsius to fahrenheit 100C = _ → COMPUTE=(100*9/5)+32

# ### factual
#
# ```yaml
# parser: answer
# priority: 90
# match: the (capital|ceo|founder|author|inventor) of .+ is
# keywords: capital of, ceo of, founder of, author of, who is, who was
# ```
#
# Answer the factual question. Output ONLY: ANSWER=<answer>
#
# Examples:
#   - The CEO of Apple is _ → ANSWER=Tim Cook
#   - The capital of France is _ → ANSWER=Paris

# ### grammar
#
# ```yaml
# parser: alternatives
# priority: 50
# ```
#
# Default fallback for "suggest alternatives" style blanks. No match/keywords
# → only fires when classifier selects MODE=GRAMMAR.
#
# Output 3 comma-separated alternatives that fit the sentence context.
