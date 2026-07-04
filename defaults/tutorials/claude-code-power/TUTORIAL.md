---
name: claude-code-power
id: 4
title: Claude Code power moves — shell mode, @files, compact, escape
---

Four small habits that make Claude Code feel fast: run shell commands
directly, point Claude at files, keep context lean, and use Escape.

## Step 1 — run a shell command with !
Start a message with `!` to run it as a shell command directly — Claude
doesn't interpret it, the output lands in the conversation. Try:
! git status
coach:
  - Nothing typed → suggest typing: ! git status
  - They typed a shell command WITHOUT the leading ! → tell them to put ! at the very start
  - They typed "! <command>" but haven't submitted → tell them to press Enter to run it
  - They submitted a message starting with ! → STEP_DONE

## Step 2 — point Claude at a file with @
Type @ anywhere in a prompt to get file autocomplete; the referenced
file is pulled into context. Ask something like:
explain @README.md
coach:
  - Nothing typed → suggest: explain @README.md
  - They typed a prompt with no @ → tell them to reference the file with @, e.g. @README.md
  - They typed a prompt containing @<path> but haven't submitted → tell them to press Enter
  - They submitted a prompt containing an @file reference → STEP_DONE

## Step 3 — compact the conversation with focus
When context fills up, /compact summarizes the conversation in place —
and you can tell it what to preserve: /compact focus on the API changes
coach:
  - Nothing typed → suggest: /compact focus on the API changes
  - They typed /clear → explain /clear starts a NEW conversation; /compact keeps this one, summarized
  - They typed /compact (with or without focus) but haven't submitted → press Enter
  - They submitted /compact → STEP_DONE

## Step 4 — clear your input with double Escape
Type anything into the input, then press Escape twice: the input clears
(and is saved to history — recall it with the Up arrow). Single Escape
also interrupts Claude mid-response. Note: while a tutorial is running
you'll see "Esc ×1 more to exit the tutorial" — that's the tutorial's
own escape hatch counting; a THIRD Escape would exit this tutorial, so
stop at two.
coach:
  - No activity yet → tell them to type a few words, then press Escape twice (and warn: not three — three exits the tutorial)
  - They typed something but no escape presses → tell them to press Escape twice
  - Trace shows "pressed: escape" twice or (×2) after typing → STEP_DONE
