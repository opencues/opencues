---
name: countries
type: blank
blankKeywords: population of, capital of, currency of, region of, language of, languages of, area of, size of
blankAutoPopulate: true
blankFormat: string
blankTip: Country fact
blankReadOnly: true
blankProximity: 3
---

Dispatched by the shared runtime `CountriesControl`
(`packages/opencues-runtime/src/controls/countries.ts`). One control,
many facts: the keyword phrase tells the runtime which field to extract
from REST Countries (https://restcountries.com — no auth, no signup).
24h cache per country.

Examples:
- `population of France _` → `67.7M`
- `capital of Japan _` → `Tokyo`
- `currency of Brazil _` → `Brazilian real (BRL)`
- `area of Russia _` → `17,098,242 km²`
- `languages of India _` → `Hindi, English`

Multi-word country names work (`united states`, `south africa`) — the
runtime joins all non-trigger words and lets REST Countries' search
endpoint fuzzy-match. ReadOnly: cycling is no-op.
