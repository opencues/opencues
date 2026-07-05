---
name: claude-code-basics
id: 1
next: claude-code-power
title: Claude Code basics — plan, model, commit
---

Learn the plan-first workflow: enter plan mode, ask for a plan, switch
model, then commit the work to git. Progress is detected automatically
from what you type and press — just follow the coaching line.

## Step 1 — enter plan mode
Enter plan mode by pressing Shift+Tab twice. You'll see "plan mode" in
the input border.
coach:
  - No activity yet → tell them to press Shift+Tab twice
  - Trace shows "pressed: shift+tab" once → one more Shift+Tab to go
  - Trace shows "pressed: shift+tab (×2)" or more → STEP_DONE
  - They started typing a planning request already → they're past this step: STEP_DONE

## Step 2 — ask for a plan
Ask Claude to write a PLAN for a small change (for example adding a
--verbose flag) — planning only, no implementation yet.
coach:
  - Empty buffer → suggest typing something like: write a plan for adding a --verbose flag
  - They typed a request that asks Claude to IMPLEMENT directly → tell them to ask for a plan first, e.g. add "just write the plan, don't implement yet"
  - They typed a planning request but haven't submitted → tell them to press Enter to send it
  - They submitted a planning request → STEP_DONE

## Step 3 — switch model
Switch to a different model using the /model picker.
coach:
  - Nothing typed → tell them to type /model
  - Buffer is exactly "/model" → tell them to press Enter to open the picker
  - They submitted "/model" → tell them to pick a model with the arrow keys, then Enter
  - After submitting "/model", trace shows arrow presses and/or "pressed: enter" → they picked a model: STEP_DONE

## Step 4 — commit to git
Ask Claude to commit the work to git on a new branch.
coach:
  - Empty buffer → suggest: commit this to git on a new branch
  - Their request mentions committing but no branch → tell them to add "on a new branch"
  - They submitted a commit-on-branch request → STEP_DONE
