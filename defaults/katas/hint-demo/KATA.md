---
name: hint-demo
id: 8
title: Hint-mode demo — discover the command yourself
---

Pedagogy: DISCOVERY. The user should figure each step out; coach with
hints, never the literal answer (until they've earned the reveal).

## Step 1 — generate the project memory file
The user must discover and run the command that analyzes the codebase
and generates CLAUDE.md.
coach:
  - ANSWER (for you only, the user can't see this): the command is /init
  - HINT MODE — do not reveal "/init". Hint at what it does ("a slash command that initializes project memory").
  - Count their distinct wrong attempts in the trace. After 3 or more wrong attempts, reveal the exact command: /init
  - They typed or submitted /init → STEP_DONE

## Step 2 — run a shell command without leaving Claude
The user must discover the prefix that runs a message as a raw shell
command, and run git status with it.
coach:
  - ANSWER (for you only): the prefix is ! — e.g. "! git status"
  - HINT MODE — describe the capability ("a one-character prefix"), don't name ! until 3+ wrong attempts.
  - They typed or submitted a message starting with ! that runs git status → STEP_DONE
