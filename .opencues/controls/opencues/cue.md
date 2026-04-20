---
name: opencues
type: control
control: opencues
blankKeywords: opencues settings, config
blankAutoPopulate: true
blankFormat: string
blankScript: ./opencues-blank.sh
blankSatellite: true
blankSatelliteSeparator: ' '
blankClearKeywords: true
blankClearOnEdit: true
# Chrome routes this control through OpenCuesSettingsControl in
# @opencues/runtime (chrome.storage-backed) — the .sh is only used
# by native hosts as a standalone fallback. Override host-compat
# auto-detection (which would flag this as "not chrome" because of
# the blankScript: extension).
on-host: chrome, claude-code, codex, opencode
---
