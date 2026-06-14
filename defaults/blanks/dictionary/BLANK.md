---
name: dictionary
type: blank
blankKeywords: define, definition of, meaning of, what does, what is
# blankShapes: precision gate (June 2026). Each trigger phrase
# anchored at the start, with the word being defined captured at
# the end. Drops prose like "let me define what I mean _" or "the
# meaning of life _" (the latter is a fluid-blank query, not a
# dictionary lookup).
blankShapes: [{"pattern":"^define\\s+(.+?)\\s*_$","action":"get","valueGroup":1},{"pattern":"^definition\\s+of\\s+(.+?)\\s*_$","action":"get","valueGroup":1},{"pattern":"^meaning\\s+of\\s+(.+?)\\s*_$","action":"get","valueGroup":1},{"pattern":"^what\\s+does\\s+(.+?)\\s+mean\\s*_$","action":"get","valueGroup":1},{"pattern":"^what\\s+is\\s+(.+?)\\s*_$","action":"get","valueGroup":1}]
blankAutoPopulate: true
blankFormat: string
blankTip: Dictionary definition
blankReadOnly: true
# One-span emission — no cycle vocab.
blankClearOnEdit: true
blankConsumeContext: true
# Blank-as-context: deliberately OFF. The "ambient" set for dictionary
# would be "every word the user looks up" — a surveillance shape that
# also has no fixed slot list. Keep this as a keyword-triggered lookup.
as-context: off
---

Implementation: built-in `DictionaryBlank` in `@opencues/runtime`
(`packages/opencues-runtime/src/blanks/dictionary.ts`). Looks up
the highlighted/contextual word at https://api.dictionaryapi.dev/
(no API key, no signup), returns the first definition truncated to
~100 chars. Cached for 24h per word.
