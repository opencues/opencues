---
name: mood
type: control
control: mood
blankKeywords: mood, feeling, vibe, today I feel
stepValues: ["energised", "focused", "calm", "scattered", "tired", "anxious", "grateful", "frustrated", "curious", "content"]
tip: Daily mood check-in
blankDismissible: true
---
SHAPE 4: List control. No script needed — runtime cycles through
stepValues. Type "mood _" or "today I feel _" → blank auto-populates
with the first value, Up/Down cycles through the rest. Cycling to
nothing (after the last value) dismisses the blank entirely
(blankDismissible: true).

Designed for journaling prompts where you want a scrollable picker
with no LLM round-trip and no shell. Adapt by swapping stepValues.
