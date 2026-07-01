---
name: weather
type: blank
blankKeywords: weather, forecast, temp, temperature
blankAutoPopulate: true
blankFormat: string
tip: Weather
blankDismissible: true
blankProximity: 3
# Auto: bare "weather london _" → wipe → "London: 13°C Overcast"
# (location embedded). Copula phrasings ("weather is _") → keep.
blankReplace: auto
# Blank-as-context: when blank-context-mode is on, expose current
# weather for the user's workCity (from IDENTITY.md) as an ambient
# token [WEATHER <CITY>] that fluid-blank can route casual phrasings
# to ("what's it like outside _", "do i need a jacket _").
as-context: safe
context-bind: workCity
# TYPED-SENTINEL Phase 4 — ai-callable ON-DEMAND fetch. With `sentinel-language:
# typed`, the catalog advertises `[WEATHER(city: string): string]` and the
# runtime may call WeatherBlank.get(<city>) with an LLM-provided city — e.g.
# `[WEATHER(city=Berlin)]` — even for a city not pre-fetched as a slot. SAFE:
# bounded codomain (a city → a weather string), no exec/side-effect, no
# blankScript. (Parser refuses ai-callable on any script blank.)
signature: (city: string)
returns: string
ai-callable: true
---

Implementation: built-in `WeatherBlank` in `@opencues/runtime`
(`packages/opencues-runtime/src/blanks/weather.ts`). Every host wires
it via `createDefaultBlanksRegistry`. Open-Meteo geocode + forecast
fetch happens in pure TypeScript.
