---
name: answer
type: blank
blankKeywords: what is the word for, how to say
# wipe: replaces the full query phrase with the answer word.
# "what is the word for surprise _" → "astonishment"
blankReplace: wipe
blankAutoPopulate: true
blankFormat: string
blankTip: Answer
blankProximity: 20
---

Implementation: built-in `AnswerBlank` in `@opencues/runtime`
(`packages/opencues-runtime/src/blanks/answer.ts`). Every host wires
it via `createDefaultBlanksRegistry`; the keyword routing in this
file is all that's needed.
