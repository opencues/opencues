---
name: display
type: control
control: display
blankKeywords: display, ui
blankAutoPopulate: true
blankFormat: string
blankScript: ./display-blank.sh
blankSatellite: true
blankSatelliteSeparator: ' '
blankClearKeywords: true
blankClearOnEdit: true
---
SHAPE 6: Selector + Satellite. Type "display _" → expands to
"<setting-name> <current-value>" (e.g. "theme dark"). Cycle the
selector word (theme | font-size | line-spacing) to switch settings;
cycle the satellite (the value) to change the current setting.

The colocated `display-blank.sh` is a stub for native hosts. A
real production version would either back the storage by a JSON file
in the user's home, or implement a TS class in @opencues/runtime
parallel to OpenCuesSettingsControl (mirrors the opencues control
itself — see defaults/controls/opencues/cue.md).

Demonstrates: blankSatellite, blankSatelliteSeparator, blankClearKeywords,
blankClearOnEdit — the full selector+satellite lifecycle.
