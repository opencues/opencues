---
name: weather
type: control
control: weather
blankKeywords: weather, forecast, temp, temperature
blankAutoPopulate: true
blankFormat: string
blankTip: Weather
blankDismissible: true
blankProximity: 3
blankClearKeywords: true
---

Dispatched by the shared runtime `WeatherControl`
(`packages/opencues-runtime/src/controls/weather.ts`). Hosts wire
`WeatherControl()` into their controls registry. Open-Meteo geocode +
forecast fetch happens in pure TypeScript; the legacy
`weather-blank.sh` was deleted on 2026-04-18 once chrome + opencode
were verified green on the runtime path.
