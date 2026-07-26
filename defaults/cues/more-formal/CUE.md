---
name: more-formal
scope: sentence
priority: 85
description: Sentence-scope cue — rewrites each sentence to be more formal
# Prose cue — belongs on prose surfaces, not value fields. Cede in
# single-line fields (a browser omnibox / address bar, a search box), where
# "make it more formal" is nonsensical. Runs everywhere else (multi-line
# editors, comment boxes) unchanged. See on-field / not-on-field in the spec.
not-on-field: single-line
---

Rewrite each sentence in the buffer to be MORE FORMAL. Preserve
the original meaning exactly — no information added or removed. Output
THREE distinct formal rewrites per sentence (or fewer if you cannot
produce three genuinely distinct ones).

Emit `ALT: NONE` for any sentence that:
  - Is already formal (no useful lift possible).
  - Is a fragment, one-word greeting/acknowledgement, or interjection
    (e.g. "ok.", "hi.", "yes.").
  - Is technical content — code, shell commands, URLs, identifiers.
  - Is markup, a list item, or a header.

Formality moves you should prefer (when meaning is preserved):

  - Expand contractions: "don't" → "do not", "I'll" → "I will".
  - Replace colloquialisms: "gonna" → "will", "kinda" → "somewhat",
    "stuff" → "items / matters / tasks", "things" → "matters",
    "biggie" → "issue", "cheers" → "thank you / best regards".
  - Lift register: "ping me" → "please notify me", "touch base" →
    "reconnect", "circle back" → "follow up", "on my plate" →
    "in my workload".
  - Replace casual greetings/sign-offs: "thanks a bunch" → "thank you
    very much", "cheers!" → "best regards".
  - Use third-person constructions for emails/reports where natural.
  - Capitalise sentence-initial words; ensure full punctuation.

Formality moves to AVOID:

  - Adding words or clauses the original did not contain.
  - Changing the speaker's point of view (first-person stays first-person).
  - Changing question to statement (or vice versa).
  - Substituting unfamiliar formal-sounding words that distort
    meaning ("ameliorate" when "improve" works).

Examples (the output format spec is appended automatically by the
runtime — do not include it in the body):

Informal input → formal rewrites:

  "thanks a bunch for the help."
    → "Thank you very much for your assistance."
    → "I am grateful for your help."
    → "Many thanks for your assistance."

  "I'm gonna look into that tomorrow."
    → "I will look into that tomorrow."
    → "I will investigate that tomorrow."
    → "I will examine that matter tomorrow."

  "let me know what you think."
    → "Please share your thoughts."
    → "Your feedback would be appreciated."
    → "I welcome your opinion."

Already-formal input → emit ALT: NONE:

  "Pursuant to our agreement, the deliverables are enclosed."
    → ALT: NONE

  "The board has approved the proposal unanimously."
    → ALT: NONE

Fragment / non-prose input → emit ALT: NONE:

  "ok."             → ALT: NONE
  "const x = 42;"   → ALT: NONE
  "npm install."    → ALT: NONE
