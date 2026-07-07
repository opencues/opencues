---
name: note
type: blank
blankKeywords: note
blankFormat: string
tip: Save, recall, and delete reusable snippets (~/.cues/NOTES.md)
# Confirmations + recall lists are dismissible — cycling past the end
# returns the `_` so the user can back out of any result.
blankDismissible: true
# Bare `note _` (browse recent) consumes the keyword — the listed
# entries stand alone; a "note" label prefix would read as part of
# the entry text.
blankClearKeywords: true
# Deliberately NOT blankClearOnEdit: recall exists so the user can
# TWEAK the recalled text in place. An edit inside the fill must
# leave it intact (it only detaches the cycling span).
# Runtime-only blank — served by NoteBlank in @opencues/runtime via
# injected readFile/writeFile against ~/.cues/NOTES.md. No
# blankScript:/sandbox: needed. Every write goes through the
# validateNoteWrite chokepoint (entry cap 256, 1024 chars/entry,
# control-char reject, duplicate idempotency).
on-host: chrome, claude-code, gemini-cli, opencode, shell
# Blank-as-context: OFF — notes are the user's private store; they
# must never ride ambiently into LLM prompts. Recall is fully local.
as-context: off
---

# Note — save, recall, and delete reusable snippets (PROTOTYPE)

A user-curated collection over `~/.cues/NOTES.md` (issue #210):
things you need "time and time again" — repair commands, links,
boilerplate — saved once and recalled by a couple of words.

## Usage

```
note add fix mp4: ffmpeg -fflags +genpts -err_detect ignore_err -i input.mp4 -c copy output.mp4 _
note ffmpeg _              → recalls the command, ready to tweak
note _                     → browse the 5 most recent notes (cycle)
note delete fix mp4 _      → removes it (refuses if the query is ambiguous)
```

An optional `label: ` prefix (before the first `: `) names the entry.
Recall fills the BODY only, so a recalled command lands ready to run;
the bare `note _` browse keeps labels so entries are identifiable.

## Search

Fully local and deterministic — every query word must appear in the
entry (case-insensitive); label matches rank above body matches,
newest first. Notes never reach an LLM provider.

## Editing the file directly

`~/.cues/NOTES.md` is a plain markdown bullet list — edit, reorder,
or bulk-delete entries by hand; changes hot-reload. Runtime writes
are line surgery (append/remove one bullet), so your own headers,
comments, and spacing are never rewritten.
