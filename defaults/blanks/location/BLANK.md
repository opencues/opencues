---
name: location
type: blank
tip: Location lookup
blankKeywords: location, address
# Explicit shapes REPLACE the keyword-synthesized grammar (authored shapes
# win). The extra grammar over plain keywords is the TRAILING-keyword form —
# "east finchley iceland location _" — where the query precedes the trigger.
# First match wins:
#   1. leading get-with-arg   "location east finchley iceland _"
#   2. trailing get-with-arg  "east finchley iceland location _"
#   3. bare get               "location _" → usage hint ([err] feedback, fills
#      only the `_` so the typed command survives)
blankShapes: [{"pattern":"^(?:location|address)\\s+(.+?)\\s*_$","action":"get","valueGroup":1},{"pattern":"^(.+?)\\s+(?:location|address)\\s*_$","action":"get","valueGroup":1},{"pattern":"^(?:location|address)\\s*_$","action":"get"}]
---

Implementation: built-in `LocationBlank` in `@opencues/runtime`
(`packages/opencues-runtime/src/blanks/location.ts`). Every host wires
it via `createDefaultBlanksRegistry`. Free-form place / address / POI
search against OpenStreetMap's Nominatim (no API key, no signup); the
first hit's `display_name` is the answer. 24h cache per query —
Nominatim's usage policy asks callers to cache.

Examples:
- `east finchley iceland location _` → `Iceland, High Road, Finchley, London Borough of Barnet, Greater London, England, N2 8AQ, United Kingdom`
- `location 10 downing street _` → `10, Downing Street, Westminster, London, SW1A 2AA, United Kingdom`
- `address of the eiffel tower _` → `Tour Eiffel, 5, Avenue Anatole France, …, 75007, France`

The captured arg is the whole query, so both landmark names and
POI-in-area searches ("iceland east finchley") work — Nominatim indexes
OSM's business/POI layer, not just place names.

A shaped get consumes the whole command span (the output embeds the
place name, so it's self-contained). Misses return `[err] location: no
match for "…"` which fills only the `_` — the typed query survives for
correction.

Read-only: no cycling, so the blank also runs on no-cycling hosts
(chrome's plain-input profile).

Note the trailing shape means any sentence ending `… location _` /
`… address _` routes here (deterministic, zero LLM) rather than to
fluid-blank. That's intended — the trigger word is the user's routing
signal, mirroring `weather`/`define`.
