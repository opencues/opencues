---
type: blank
name: weather
description: Local weather — temperature + conditions for a city
blankKeywords: weather, forecast, temp
impl: WeatherBlank
priority: 50
enabled: true
blankAutoPopulate: true
blankReadOnly: true
blankProximity: 2
blankFormat: string
blankSuffix: ""
blankTip: "Open-Meteo (cached 5min)"
blankKeywordExpansions:
  temp: temperature
on-host: [chrome, claude-code, gemini-cli, opencode]
speak: false
spec: opencues/0.1-alpha
---

Returns "13°C Partly cloudy" or similar. Pulls from Open-Meteo. Geocodes the location word in `context`.
