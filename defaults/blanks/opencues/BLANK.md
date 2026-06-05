---
name: opencues
type: blank
blankKeywords: opencues settings, config
blankAutoPopulate: true
blankFormat: string
blankScript: ./opencues-blank.sh
# Sandbox: off because opencues-blank.sh writes to ~/.cues/OPENCUES.md
# (settings persistence) which is outside the sandbox's tmpfs and
# would be refused by the read-only CUES root bind. Chrome routes
# this through OpenCuesSettingsBlank (impl: class, no spawn) so the
# sandbox declaration only affects native hosts.
sandbox: off
blankSatellite: true
blankSatelliteSeparator: ' '
blankClearKeywords: true
blankClearOnEdit: true
# Chrome routes this blank through OpenCuesSettingsBlank in
# @opencues/runtime (chrome.storage-backed) — the .sh is only used
# by native hosts as a standalone fallback. Override host-compat
# auto-detection (which would flag this as "not chrome" because of
# the blankScript: extension).
on-host: chrome, claude-code, gemini-cli, opencode
# Blank-as-context: deliberately OFF. OpenCues settings feeding back
# into prompts is a loop hazard — the LLM could be steered by current
# settings into recommending other settings, and substitution would
# inline live config values into prose that mentions OpenCues. Settings
# are a CONTROL surface, not an ambient data source.
as-context: off
---
