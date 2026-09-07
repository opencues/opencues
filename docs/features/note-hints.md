---
last_updated: 2026-09-06
---

# The note and its hint

The inline note under a cue has two parts: the **note** names the state,
the **hint** on the right names what the next press does.

## The hint is a verb

The hint is one of seven words, chosen by the runtime from what the def
holds. It never names a destination ("underscore to Paris" reads as a place;
the destination lives in the note, where it already is).

| the next press | hint | retires after first use? |
|---|---|---|
| puts a proposed value or rewrite in | `(underscore to apply)` | no |
| puts the original back | `(underscore to revert)` | no |
| corrects a misspelling (two stops) | `(underscore to correct)` | no |
| reconciles a contradiction (two stops) | `(underscore to fix)` | no |
| moves through three or more stops | `(underscore to cycle)` | yes |
| mutes an advisory | `(underscore to dismiss)`, then `(muted · underscore again to forget)` | as before |
| nudges a live value | `(ctrl+alt+up/down to adjust)` | yes |

No exceptions, not even for a command tip: its note names the command
(the pack's `say:` line does, or the solution follows an arrow), so the hint
can stay a verb.

Only the hints that teach a key retire; a verb that states an outcome is
news every time. "Revert" applies to every cue the moment the next press
would restore the original, including the last stop of a three-rewrite
sentence cue.

## A toggle is not a cycle

A def with exactly two stops is an action and its undo. Its note drops the
count:

| | before the press | after the press |
|---|---|---|
| spelling, one correction | `✍️ definitely` | `✍️ was: definately` |
| contradiction with a reconciled line | `⚠ the 19th is a Friday` | `⚠ was: Thursday the 19th` |
| a command tip | `💡 Starting over? /clear wipes the conversation, CLAUDE.md stays` | `💡 was: ok this is a mess, lets start over on…` |
| a prose tip | `💡 Paste the error… → fix the login bug: [paste…` | `💡 was: fix the login bug` |
| a landed lookup or rewrite | `was: capital of france _` | `Paris` |

Three or more stops keep the count and the rotating list, because the list
already says where the presses go.

## What is too long

Two rules, and they are what define "too long" for a note:

- **The user's own text never wraps.** `was: …` and `→ …` are recognition
  cues; they show the first eight words or 48 code points, then `…`. The
  whole text is one press away.
- **The product's own text wraps to two lines.** A tip or a finding is
  capped at 120 code points, about two lines at a typical terminal width,
  then `…`. A note that would take a third line is too long.

Hosts still wrap the note body to their box width (Claude Code cell-aware
with a hang indent, chrome in a max-width, OpenTUI hosts as a growing flow);
the caps above make sure there is never more than two lines to wrap.

Where it lives: `packages/opencues-runtime/src/state/dyn-defs.ts`
(`inlineNoteText`, `inlineNoteHint`, `snippetLine`, `NOTE_MAX_CELLS`).
Companion: `cue-dismissal.md` (the dismiss and forget grains),
`semantic-tips.md` (the command tip).
