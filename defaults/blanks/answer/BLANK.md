---
name: answer
type: blank
blankKeywords: what is the word for, how to say
# blankShapes: precision gate (June 2026). Multi-word trigger phrases
# anchored at the start with the query captured at the end. Drops
# prose like "she explained what is the word for in french _" from
# claiming. Shape-less prose with the keyword embedded mid-sentence
# routes to fluid-blank.
blankShapes: [{"pattern":"^what\\s+is\\s+the\\s+word\\s+for\\s+(.+?)\\s*_$","action":"get","valueGroup":1},{"pattern":"^how\\s+to\\s+say\\s+(.+?)\\s*_$","action":"get","valueGroup":1}]
blankAutoPopulate: true
blankFormat: string
blankTip: Answer
# One-span emission — single-answer LLM lookup, no cycle vocab.
# NO blankClearOnEdit — the answer is a word/phrase the user
# typically wants to keep and write around (e.g. "what is the word
# for surprise _" → "astonishment", then user types "astonishment was
# exactly the right word"). clearOnEdit would wipe their in-progress
# sentence the moment they typed a character.
blankConsumeContext: true
# Blank-as-context: deliberately OFF. AnswerBlank is a per-query LLM
# lookup with no fixed "current value" to surface — every invocation
# produces a different answer from the user's phrasing.
as-context: off
---

Implementation: built-in `AnswerBlank` in `@opencues/runtime`
(`packages/opencues-runtime/src/blanks/answer.ts`). Every host wires
it via `createDefaultBlanksRegistry`; the keyword routing in this
file is all that's needed.
