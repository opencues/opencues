---
name: cc-fix-a-bug
id: 6
next: cc-custom-command
title: Fix a bug the right way — describe, options, apply, verify
---

The doc-recommended debugging loop: share the error, compare fixes,
apply one, verify. In this order — each step earns the next.

## Step 1 — describe or paste the error
Tell Claude exactly what you're seeing, e.g.:
I'm seeing an error when I run npm test: TypeError: cannot read properties of undefined
Paste the real error text — the message IS the evidence.
coach:
  - STRICT ORDER — if they just say "fix it" or ask for a fix with no error described, OFF_TRACK: tell them to paste the actual error message first
  - Nothing typed → suggest describing the failing command and pasting the error
  - They submitted a message containing an error description/message → STEP_DONE

## Step 2 — ask for OPTIONS, not a fix
Ask: suggest a few ways to fix this
Comparing approaches before editing catches the fix that treats the
symptom instead of the cause.
coach:
  - They asked Claude to just fix/edit directly → OFF_TRACK: ask for a few candidate approaches first
  - Nothing typed → suggest: suggest a few ways to fix this
  - They submitted a request for multiple approaches/options → STEP_DONE

## Step 3 — pick one and apply it
Choose an approach and ask for it specifically, e.g.:
update the parser to add the null check you suggested
coach:
  - Nothing typed → tell them to pick ONE suggested approach and ask for it by name
  - The request doesn't reference a specific approach → nudge: name which fix to apply
  - They submitted a specific apply-this-fix request → STEP_DONE

## Step 4 — verify with the tests
Run the tests to prove the fix, e.g.:
! npm test
(or ask: run the tests and show me the result)
coach:
  - Nothing typed → suggest: ! npm test
  - They submitted a test/verify command or request → STEP_DONE
