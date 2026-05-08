---
name: dictionary
type: blank
blankKeywords: define, definition of, meaning of, what does, what is
blankAutoPopulate: true
blankFormat: string
blankTip: Dictionary definition
blankReadOnly: true
blankProximity: 3
---

Dispatched by the shared runtime `DictionaryBlank`
(`packages/opencues-runtime/src/blanks/dictionary.ts`). Looks up
the highlighted/contextual word at https://api.dictionaryapi.dev/
(no API key, no signup), returns the first definition truncated to
~100 chars.

Examples:
- `define ephemeral _` → `lasting for a very short time`
- `meaning of catalyst _` → `a substance that accelerates a chemical reaction without...`
- `what is entropy _` → `a measure of disorder in a thermodynamic system`

Cached for 24h per word — definitions don't churn. ReadOnly so cycling
is a no-op (the definition IS the definition).
