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
impl: ./blank.js
llm: groq
---

Dispatched by the shared runtime `AnswerBlank`
(`packages/opencues-runtime/src/blanks/answer.ts`).
