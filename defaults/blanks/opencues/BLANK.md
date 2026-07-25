---
name: opencues
type: blank
blankKeywords: opencues settings, config
blankAutoPopulate: true
blankFormat: string
blankSatellite: true
blankSatelliteSeparator: ' '
blankClearKeywords: true
blankClearOnEdit: true
# Runtime-only blank — served by OpenCuesSettingsBlank in
# @opencues/runtime on every host (chrome.storage on chrome; injected
# readFile/writeFile against ~/.cues/OPENCUES.md on every native host).
# The resolver tries blankInvoke first and never falls back to spawn
# for this name, so no blankScript: / sandbox: is needed.
on-host: chrome, claude-code, gemini-cli, opencode, shell, windows
# Blank-as-context: deliberately OFF. OpenCues settings feeding back
# into prompts is a loop hazard — the LLM could be steered by current
# settings into recommending other settings, and substitution would
# inline live config values into prose that mentions OpenCues. Settings
# are a CONTROL surface, not an ambient data source.
as-context: off
---
