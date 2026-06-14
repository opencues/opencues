---
name: weather
type: blank
blankKeywords: weather, forecast, temp, temperature
# blankShapes: declarative precision gate (June 2026). Drops prose
# misfires like "the weather was great _" from claiming the slot.
# Multi-keyword: weather / forecast / temp / temperature all alias to
# the same blank, so the shape pattern accepts any of them as the
# leading word.
#
#   Shape 1 — bare lookup (default location):  weather _
#   Shape 2 — explicit location:                weather london _    /  forecast paris _
blankShapes: [{"pattern":"^(?:weather|forecast|temp|temperature)\\s+(.+?)\\s*_$","action":"get","valueGroup":1},{"pattern":"^(?:weather|forecast|temp|temperature)\\s*_$","action":"get"}]
blankAutoPopulate: true
blankFormat: string
blankTip: Weather
# No blankSatellite: weather has no cycle vocab (no blankStep, no
# stepValues), so we use the "one uniform gray span" emission —
# the regular splice path produces a single dimmed substitution the
# user can wipe with Backspace or edit-anywhere.
blankClearOnEdit: true
blankConsumeContext: true
# Blank-as-context: when blank-context-mode is on, expose current
# weather for the user's workCity (from IDENTITY.md) as an ambient
# token [WEATHER <CITY>] that fluid-blank can route casual phrasings
# to ("what's it like outside _", "do i need a jacket _").
as-context: safe
context-bind: workCity
---

Implementation: built-in `WeatherBlank` in `@opencues/runtime`
(`packages/opencues-runtime/src/blanks/weather.ts`). Open-Meteo
geocode + forecast fetch happens in pure TypeScript.
