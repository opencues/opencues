---
name: cc-first-session
id: 5
title: Your first Claude Code session — init, orient, first change
---

The recommended first session in a new project, in order: generate the
project memory file, orient yourself, then make your first change.

## Step 1 — generate CLAUDE.md with /init
Run /init first — it analyzes the codebase and generates CLAUDE.md
(build commands, conventions, project layout) so every later answer is
better grounded.
coach:
  - STRICT ORDER — if they ask a question or request a change before running /init, that is OFF_TRACK: remind them to run /init first so Claude knows the project
  - Nothing typed → tell them to type /init
  - They typed /init but haven't submitted → press Enter
  - They submitted /init → STEP_DONE

## Step 2 — get an overview
Ask for orientation before touching anything, e.g.:
give me an overview of this codebase
coach:
  - Nothing typed → suggest: give me an overview of this codebase
  - They asked Claude to change/write code already → OFF_TRACK: orient first, ask for an overview before editing
  - They submitted an overview/orientation question → STEP_DONE

## Step 3 — learn how to run the tests
Ask: how do I run the tests? Knowing the verify loop BEFORE changing
code is the habit that makes everything else safe.
coach:
  - Nothing typed → suggest: how do I run the tests?
  - They submitted a question about running tests/builds → STEP_DONE

## Step 4 — make your first small change
Now request a small, concrete change, e.g.:
add a hello world function to the utils module
coach:
  - Nothing typed → suggest a small concrete request like: add a hello world function
  - The request is huge or vague ("rewrite the app") → nudge them to start small and specific
  - They submitted a small concrete change request → STEP_DONE
