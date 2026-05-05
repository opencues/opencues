---
name: weather
type: blank
blankKeywords: weather, forecast, temp, temperature
blankAutoPopulate: true
blankFormat: string
blankTip: Weather
blankDismissible: true
blankProximity: 3
blankClearKeywords: true
---

Dispatched by the shared runtime `WeatherBlank`
(`packages/opencues-runtime/src/blanks/weather.ts`). Hosts wire
`WeatherBlank()` into their blanks registry. Open-Meteo geocode +
forecast fetch happens in pure TypeScript.
