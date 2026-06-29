---
type: blank
name: weather
description: Local weather — temperature + conditions for a city
blankKeywords: weather, forecast, temp
impl: WeatherBlank
priority: 50
enabled: true
blankShapes: [{"pattern":"^(?:weather|forecast|temp)\\s+(.+?)\\s*_$","action":"get","valueGroup":1},{"pattern":"^(?:weather|forecast|temp)\\s*_$","action":"get"}]
blankSuffix: ""
integration: it's currently {value}
tip: "Open-Meteo (cached 5min)"
on-host: [chrome, claude-code, gemini-cli, opencode]
speak: false
spec: opencues/0.1-alpha
---

Returns "13°C Partly cloudy" or similar. Pulls from Open-Meteo. Geocodes the location word captured by the shape.
