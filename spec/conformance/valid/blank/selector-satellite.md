---
type: blank
name: opencues
description: Selector + satellite for OpenCues runtime settings
blankKeywords: opencues, settings, config
impl: OpenCuesSettingsBlank
blankSatellite: true
blankAutoPopulate: true
blankProximity: 2
spec: opencues/0.1-alpha
---

Selector + satellite pattern: a single `_` resolves to two adjacent words. Selector picks a setting (e.g. `voice-mode`); cycling the selector swaps the satellite (the current value of that setting). Setting the satellite writes through to the underlying config.

`get` returns `<selector>\t<satellite>` (tab-separated). The runtime MUST splice both as adjacent words. See [`blank-spec.md` § Flag obligations](../../blank-spec.md#flag-obligations).
