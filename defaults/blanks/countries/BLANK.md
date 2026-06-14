---
name: countries
type: blank
blankKeywords: population of, capital of, currency of, region of, language of, languages of, area of, size of
# blankShapes: precision gate (June 2026). Each fact-keyword phrase
# anchored at the start, with the country name captured at the end.
# Drops prose like "the population of the city was huge _" (city not
# country) or "I love the capital of culture _".
blankShapes: [{"pattern":"^population\\s+of\\s+(.+?)\\s*_$","action":"get","valueGroup":1},{"pattern":"^capital\\s+of\\s+(.+?)\\s*_$","action":"get","valueGroup":1},{"pattern":"^currency\\s+of\\s+(.+?)\\s*_$","action":"get","valueGroup":1},{"pattern":"^region\\s+of\\s+(.+?)\\s*_$","action":"get","valueGroup":1},{"pattern":"^languages?\\s+of\\s+(.+?)\\s*_$","action":"get","valueGroup":1},{"pattern":"^(?:area|size)\\s+of\\s+(.+?)\\s*_$","action":"get","valueGroup":1}]
blankAutoPopulate: true
blankFormat: string
blankTip: Country fact
blankReadOnly: true
# One-span emission — no cycle vocab.
blankClearOnEdit: true
blankConsumeContext: true
---

Implementation: built-in `CountriesBlank` in `@opencues/runtime`
(`packages/opencues-runtime/src/blanks/countries.ts`). One blank, many
facts: the keyword phrase tells the runtime which field to extract
from REST Countries (https://restcountries.com — no auth, no signup).
24h cache per country.

Multi-word country names work (`united states`, `south africa`) — the
runtime joins all non-trigger words and lets REST Countries' search
endpoint fuzzy-match.
