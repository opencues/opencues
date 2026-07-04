---
name: claude-code-basics
id: 1
title: Claude Code basics — plan, model, commit
---

Learn the plan-first workflow: enter plan mode, ask for a plan, switch
model, then commit the work to git.

## Step 1 — enter plan mode
Enter plan mode by pressing Shift+Tab twice. You'll see "plan mode" in
the input border. This step happens outside the input box — type `done`
when you're in plan mode.
coach:
  - Nothing typed yet → tell them to press Shift+Tab twice, then type done
  - They typed something else → remind them this step is just Shift+Tab twice, then the word done

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
  - They submitted "/model" → tell them to pick a model with arrows + Enter, then type done
  - They typed done → the runtime advances (handled outside your judgement)

## Step 4 — commit to git
Ask Claude to commit the work to git on a new branch.
coach:
  - Empty buffer → suggest: commit this to git on a new branch
  - Their request mentions committing but no branch → tell them to add "on a new branch"
  - They submitted a commit-on-branch request → STEP_DONE
