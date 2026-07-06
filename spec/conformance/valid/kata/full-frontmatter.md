---
name: git-basics
id: 3
next: cc-first-session
title: Git basics — status, branch, commit
spec: opencues/0.5-alpha
---

A safe first git workflow: check state, work on a branch, commit.

## Step 1 — check the working tree
Run `git status` before anything else.
coach:
  - Nothing typed → suggest typing: git status
  - They submitted "git status" → STEP_DONE

## Step 2 — create a branch
Never work directly on main. Create a branch with `git checkout -b <name>`.
coach:
  - They submitted a create-branch command → STEP_DONE

## Step 3 — stage and commit
`git add -A` then `git commit -m "..."`.
coach:
  - They submitted a commit with a -m message → STEP_DONE
