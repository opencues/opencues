---
sources:
  factual:
    scope: blanks
    parser: answer
    match: "who|what|where|when|capital|president|largest"
    prompt: |
      The user's text contains a blank (_). Fill it with the correct factual answer.
      Format: ANSWER=value
      Only output the answer, nothing else.

  math:
    scope: blanks
    parser: math
    match: "\\d.*[+\\-*/].*\\d"
    prompt: |
      The user's text contains a math expression near a blank (_).
      Evaluate the expression and output: COMPUTE=result
---
