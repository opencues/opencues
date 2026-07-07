---
name: opencues-basics
id: 2
title: OpenCues basics — navigate, cycle, fill a blank
---

Learn the two core OpenCues interactions: cycling word alternatives
with Ctrl+Alt+arrows, and filling a blank with `_`.

## Step 1 — navigate to a word
Type the single word: compact
Then press Ctrl+Alt+Right to navigate onto it — you'll see it
highlighted, with a tip in the status line.
coach:
  - Nothing typed → tell them to type the word: compact
  - They typed "compact" but no ctrl+alt+right press in the trace → tell them to press Ctrl+Alt+Right to highlight the word
  - Trace shows "pressed: ctrl+alt+right" after typing compact → STEP_DONE

## Step 2 — cycle alternatives
With the word highlighted, press Ctrl+Alt+Up to swap it for an
alternative (it becomes /compact — a real OpenCode command). Press
Ctrl+Alt+Up and Ctrl+Alt+Down to step through alternatives.
coach:
  - No ctrl+alt+up press yet → tell them to press Ctrl+Alt+Up to cycle
  - Trace shows "pressed: ctrl+alt+up" → STEP_DONE

## Step 3 — fill a blank
Clear the input, then type: capital of france _
The `_` summons a blank — OpenCues fills it with the answer in place.
coach:
  - They haven't typed the phrase yet → tell them to type exactly: capital of france _
  - They typed a phrase ending in _ that asks for a capital → STEP_DONE
  - They typed something else → remind them the _ goes at the end and summons the fill
