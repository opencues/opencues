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
impl: ./blank.js
network: [geocoding-api.open-meteo.com, api.open-meteo.com]
storage: weather
---

Dispatched by the shared runtime `WeatherBlank`
(`packages/opencues-runtime/src/blanks/weather.ts`). Hosts wire
`WeatherBlank()` into their blanks registry. Open-Meteo geocode +
forecast fetch happens in pure TypeScript.
