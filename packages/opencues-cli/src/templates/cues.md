# Project cue sources
#
# Each `### <name>` section under `## Prompt` defines an LLM-backed cue
# source. The runtime sends the section's prompt + the user's text to
# the LLM and parses the response per `parser:`.
#
# To add a project-specific cue source, uncomment + edit:
#
# ## Prompt
#
# ### example
# match: \b(YOUR_PATTERN)\b      # only fire on words matching this regex
# parser: alternatives           # alternatives | compute | answer | raw
# priority: 50                   # higher wins on merge with user-level
# ---
# Suggest 3 better alternatives for the matched word, considering the
# surrounding sentence context. Output as a comma-separated list.

## Prompt
