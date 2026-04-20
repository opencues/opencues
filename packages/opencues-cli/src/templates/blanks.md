# Project blank-fill modes
#
# Each `### <name>` section defines a blank mode the user can trigger
# by typing `_`. The classifier picks which mode to use based on `match:`
# (regex) → `keywords:` (instant) → LLM classifier (fallback).
#
# To add a project-specific blank mode, uncomment + edit:
#
# ## Prompt
#
# ### example
# match: \b\d+\s*[+\-*/]\s*\d+   # instant trigger via regex
# keywords: math, calc            # instant trigger via keyword
# parser: compute                 # alternatives | compute | answer | raw
# priority: 100
# ---
# Compute the result of the expression. Output only the number.

## Prompt
