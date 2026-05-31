---
name: weather
type: blank
blankKeywords: weather, forecast, temp, temperature
blankAutoPopulate: true
blankFormat: string
blankTip: Weather
blankDismissible: true
blankProximity: 3
# Auto: bare "weather london _" → wipe → "London: 13°C Overcast"
# (location embedded). Copula phrasings ("weather is _") → keep.
blankReplace: auto
---

Implementation: built-in `WeatherBlank` in `@opencues/runtime`
(`packages/opencues-runtime/src/blanks/weather.ts`). Every host wires
it via `createDefaultBlanksRegistry`. Open-Meteo geocode + forecast
fetch happens in pure TypeScript.
