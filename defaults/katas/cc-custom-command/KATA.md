---
name: cc-custom-command
id: 7
title: Make your own slash command — create, invoke, refine
---

Custom slash commands are just markdown files. Create one, use it,
improve it — changes hot-reload, no restart needed.

## Step 1 — create the skill file
Ask Claude to create it for you, e.g.:
create .claude/skills/standup/SKILL.md that summarizes my git commits from today, taking a date as $0
coach:
  - STRICT ORDER — if they try to invoke /standup before creating the file, OFF_TRACK: the command doesn't exist yet, create the SKILL.md first
  - Nothing typed → suggest asking Claude to create .claude/skills/standup/SKILL.md with a description and a $0 argument
  - They submitted a request to create the skill file → STEP_DONE

## Step 2 — invoke your new command
Skills hot-reload — your command works immediately. Try:
/standup today
coach:
  - Nothing typed → tell them to type /standup today
  - They typed /standup without an argument → fine, but mention $0 receives whatever they pass, e.g. /standup today
  - They submitted /standup (with or without an argument) → STEP_DONE

## Step 3 — refine it
Ask Claude to improve the command, e.g.:
add an argument-hint to the standup skill so the picker shows what to pass
coach:
  - Nothing typed → suggest asking Claude to add an argument-hint to the skill's frontmatter
  - They submitted a request to modify/improve the skill file → STEP_DONE
