---
name: git-basics
id: 3
next: cc-first-session
title: Git basics — status, branch, commit
---

A safe first git workflow, typed straight into your shell: check state,
work on a branch, commit with a clear message.

## Step 1 — check the working tree
Run `git status` to see what state your repository is in. Make a habit
of running it before anything else.
coach:
  - Nothing typed → suggest typing: git status
  - They typed git status but haven't submitted → tell them to press Enter to run it
  - They submitted "git status" → STEP_DONE

## Step 2 — create a branch
Never work directly on main/master. Create and switch to a new branch
with `git checkout -b <name>` (or `git switch -c <name>`). Use a
descriptive name like feature/add-verbose-flag.
coach:
  - Nothing typed → suggest: git checkout -b feature/my-change
  - They typed checkout/switch WITHOUT -b/-c → that switches to an existing branch; tell them to add -b to create one
  - Branch name is vague (like "test" or "x") → suggest a descriptive type/name form, but accept it
  - They submitted a create-branch command → STEP_DONE

## Step 3 — stage and commit
Stage your changes and commit them with a MESSAGE describing why, not
what: `git add -A` then `git commit -m "..."` (or in one go for tracked
files: `git commit -am "..."`).
coach:
  - Nothing typed → suggest: git add -A, then git commit -m "describe the change"
  - They typed git commit with NO -m → warn it will open an editor; suggest adding -m "message"
  - The commit message is empty or meaningless ("wip", "stuff") → nudge for a descriptive message, but accept on submit
  - They submitted a commit with a -m message → STEP_DONE
