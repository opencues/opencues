---
name: tables
type: blank
blankKeywords: unicode for, hex for, rgb for, http status for, http status, mime type for, mime type, default port for, default port, port for, convert, calc, calculate, atomic number of, atomic mass of, boiling point of, melting point of, ph of
blankAutoPopulate: true
blankFormat: string
tip: Table lookup
blankReadOnly: true
# Shape-gated (explicit shapes win over the keyword desugaring): `convert`
# and `calc` only claim the `_` when a NUMBER follows, so "convert this to
# markdown _" and "calculate the risk _" stay with TransformBlank / fluid.
# Every shape captures the argument, so the command span is consumed and
# the answer stands alone ("hex for tomato _" → "tomato: #ff6347").
blankShapes: [{"pattern":"^unicode for\\s+(.+?)\\s*\\??\\s*_$","action":"get","valueGroup":1},{"pattern":"^(?:hex|rgb) for\\s+(.+?)\\s*\\??\\s*_$","action":"get","valueGroup":1},{"pattern":"^http status(?: for)?\\s+(.+?)\\s*\\??\\s*_$","action":"get","valueGroup":1},{"pattern":"^mime type(?: for)?\\s+(.+?)\\s*\\??\\s*_$","action":"get","valueGroup":1},{"pattern":"^(?:default port(?: for)?|port for)\\s+(.+?)\\s*\\??\\s*_$","action":"get","valueGroup":1},{"pattern":"^convert\\s+(-?\\d[\\d.,]*\\s*°?\\s*\\S.*?)\\s*\\??\\s*_$","action":"get","valueGroup":1},{"pattern":"^calc(?:ulate)?\\s+(.*?\\d.*?)\\s*\\??\\s*_$","action":"get","valueGroup":1},{"pattern":"^(?:atomic (?:number|mass)|boiling point|melting point|ph) of\\s+(.+?)\\s*\\??\\s*_$","action":"get","valueGroup":1}]
---

Gated by `table-lookups-mode` in OPENCUES.md (off by default): while off this
blank is not registered at all, and the `_` route asks no table question.

Implementation: built-in `TablesBlank` in `@opencues/runtime`
(`packages/opencues-runtime/src/blanks/tables.ts`). One blank, eight
OFFLINE tables (`tables-data.ts`): the lookups people type with a `_`
that a table or a calculator answers exactly. No network, no model, no
hallucination — the answer is data. Country facts keep their own blank
(`countries`).

Examples:
- `unicode for em dash _` → `em dash: — U+2014`
- `hex for tomato _` → `tomato: #ff6347`
- `rgb for #1e90ff _` → `#1e90ff: rgb(30, 144, 255)`
- `http status for not found _` → `404 Not Found`
- `mime type for png _` → `png: image/png`
- `default port for postgres _` → `postgres: 5432`
- `convert 5 miles to km _` → `5 miles = 8.04672 km`
- `convert 100 celsius to fahrenheit _` → `100 celsius = 212 fahrenheit`
- `calc 17 * 23 _` → `17 * 23 = 391`
- `calc 15% of 240 _` → `15% of 240 = 36`
- `atomic number of gold _` → `Gold (Au): atomic number 79`
- `boiling point of water _` → `water: boils at 100 °C`

With `decisions-provider` on, a plain phrasing (`what's the postgres port _`,
`how many feet in a mile _`) can reach the same tables through the `_`
route's `table` verdict (core's `decisions/data-policy.ts`): the verdict names
the table, the runtime resolves the argument under a closed grammar and
runs this blank. Without a decision package the shapes above are the only
way in. ReadOnly: cycling is a no-op.
