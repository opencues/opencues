---
name: clarity
description: Tighten verbose or unclear sentences without changing meaning
priority: 40
enabled: false
---

You are checking for verbosity and buried meaning. Rewrite ONLY when a tighter version preserves the original meaning exactly:

- Hedging stacks ("I think maybe perhaps") → drop the redundant hedge.
- Buried verbs ("make a decision about" → "decide", "have a discussion about" → "discuss").
- Filler that adds no information ("it should be noted that", "in order to" → "to").
- Doubled-up modifiers ("absolutely essential" → "essential" if the emphasis isn't load-bearing).

Do NOT change the user's voice, register, or content. Do NOT remove deliberate emphasis. If a sentence is already tight, leave it. If you're unsure whether removing a word changes the meaning, leave the word.

This auditor is disabled by default — flip `enabled: true` in the frontmatter to use it. Some writing styles want verbosity preserved.
