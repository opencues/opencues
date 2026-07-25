---
name: location
# Multi-line get() output is ONE answer (a card), not a list of
# cycleable alternatives - join the lines into the buffer (opencues #339).
blankMultilineIsAnswer: true
type: blank
tip: Location lookup
# location / address → terse one-line address; map → the rich "location
# card" (name, hours, phone, website + a Google Maps link). Same blank,
# same fetch; the trigger keyword picks the output mode.
blankKeywords: location, address, map
# Explicit shapes REPLACE the keyword-synthesized grammar (authored shapes
# win). The extra grammar over plain keywords is the TRAILING-keyword form —
# "east finchley iceland location _" — where the query precedes the trigger.
# First match wins:
#   1. leading get-with-arg   "location east finchley iceland _" / "map british museum _"
#   2. trailing get-with-arg  "east finchley iceland location _" / "british museum map _"
#   3. bare get               "location _" → usage hint ([err] feedback, fills
#      only the `_` so the typed command survives)
blankShapes: [{"pattern":"^(?:location|address|map)\\s+(.+?)\\s*_$","action":"get","valueGroup":1},{"pattern":"^(.+?)\\s+(?:location|address|map)\\s*_$","action":"get","valueGroup":1},{"pattern":"^(?:location|address|map)\\s*_$","action":"get"}]
---

Implementation: built-in `LocationBlank` in `@opencues/runtime`
(`packages/opencues-runtime/src/blanks/location.ts`). Every host wires
it via `createDefaultBlanksRegistry`. Free-form place / address / POI
search against OpenStreetMap's Nominatim (no API key, no signup). 24h
cache per query — Nominatim's usage policy asks callers to cache.

Two output modes, chosen by the trigger keyword (one fetch, shared cache):

- **`location` / `address`** → the terse one-line address (the first
  hit's `display_name`).
- **`map`** → a rich "location card": name, address, opening hours,
  phone, website (from OSM `extratags`) plus a Google Maps link built
  from the coordinates. OSM has no ratings / reviews / photos (those are
  Google-proprietary) — the card is everything the free OSM data gives,
  formatted for a text buffer, and the Maps link is the one-click bridge
  to the rest.

Examples:
- `east finchley iceland location _` → `Iceland, High Road, Finchley, London Borough of Barnet, Greater London, England, N2 8AQ, United Kingdom`
- `location 10 downing street _` → `10, Downing Street, Westminster, London, SW1A 2AA, United Kingdom`
- `address of the eiffel tower _` → `Tour Eiffel, 5, Avenue Anatole France, …, 75007, France`
- `british museum map _` →

  ```
  British Museum
  Great Russell Street, Bloomsbury, London, WC1B 3DG, United Kingdom
  Hours: Mo-Su 10:00-17:00
  +44 20 7323 8299 · https://www.britishmuseum.org
  Map: https://www.google.com/maps/search/?api=1&query=51.519,−0.127
  ```

The captured arg is the whole query, so both landmark names and
POI-in-area searches ("iceland east finchley") work — Nominatim indexes
OSM's business/POI layer, not just place names. Card lines are omitted
when OSM has no data for them; the `Map:` link is always present.

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
