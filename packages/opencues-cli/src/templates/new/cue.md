---
# Cue source: {{NAME}}
# Created by `opencues new cue {{NAME}}`.
#
# Required fields:
#   parser: alternatives | compute | answer | raw
#
# Common optional fields:
#   match: <regex>      — only fire on words matching (instant; LLM skipped)
#   keywords: a, b, c   — instant trigger via keyword (faster than match)
#   priority: 50        — higher wins on merge conflicts (default: 50)
#   model: <name>       — override LLM model for this source
parser: alternatives
priority: 50
---
Suggest 3 alternatives for the highlighted word, considering the
surrounding sentence context. Output as a comma-separated list.
