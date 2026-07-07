# Note collection blank

**Experimental (prototype — issue #210). Runs on all five hosts.**

A user-curated collection blank: save a snippet once, recall it with a
couple of words, tweak it in place. The store is a plain markdown
bullet list at `~/.cues/NOTES.md`, shared across the native hosts
(Chrome round-trips it via the chrome-messaging host, with a
storage-only fallback). Every operation is **deterministic and fully
local — notes never reach an LLM provider.**

## Syntax

```
note add <anything> _            save a snippet   ("label: " prefix optionally names it)
note <query> _                   recall the best match (label stripped, ready to tweak)
note delete <query> _            remove a match   (refuses an ambiguous query)
note _                           browse the 5 most recent (cycle with Ctrl+Alt+↑/↓)
```

Examples:

```
note add fix mp4: ffmpeg -fflags +genpts -err_detect ignore_err -i in.mp4 -c copy out.mp4 _
note ffmpeg _          → fills the command, ready to run/tweak in place
note _                 → browse recent notes; cycle to the one you want
note delete fix mp4 _  → removes it
```

## Labels

An optional `label: ` prefix (everything before the first `: `) names
an entry. Recall fills the **body only** — a recalled command lands
ready to run, not prefixed with its label. The bare `note _` browse
keeps labels so entries stay identifiable.

```
note add groq key: gsk_abc123 _     stores label "groq key", body "gsk_abc123"
note groq _                          → gsk_abc123        (body only)
note _                               → groq key: gsk_abc123   (label kept while browsing)
```

## Search

Fully local and deterministic: every query word must appear in the
entry (case-insensitive); **label matches rank above body matches,
newest first.** When several match, the best fills the buffer and the
rest are cycling alternatives (`note _` and ambiguous recalls are
cycleable). `note delete` refuses an ambiguous query rather than guess.

## The store — `~/.cues/NOTES.md`

A plain markdown bullet list (one `- ` line per entry). Edit, reorder,
or bulk-delete by hand — changes hot-reload. **Runtime writes are line
surgery** (append/remove a single bullet), so your own headers,
comments, and spacing are never rewritten.

```markdown
# Notes

- groq key: gsk_abc123
- fix mp4: ffmpeg -fflags +genpts …
```

## Safety

- **Local-only, never sent to an LLM.** `as-context: off` — notes never
  ride ambiently into any prompt.
- **Validator chokepoint.** Every write goes through `validateNoteWrite`:
  entry cap (256 notes), per-entry length cap (1024 chars), control-char
  rejection, and duplicate idempotency (re-adding the same note is a
  no-op, not a second copy).
- **Dismissible results.** Confirmations and recall lists are
  `blankDismissible` — cycling past the end returns the `_`, so you can
  back out of any result.
- **Recall preserves your edit.** Deliberately not `clearOnEdit`: recall
  exists so you can tweak the text in place — editing inside the fill
  leaves it intact (it only detaches the cycling span).

## Availability

Ships on `chrome`, `claude-code`, `gemini-cli`, `opencode`, `shell`.
No `blankScript:` / sandbox — it's a runtime-class blank (`NoteBlank`
in `@opencues/runtime`) served through injected `readFile`/`writeFile`
against the store. Chrome writes go disk-first via the chrome-messaging
host; without the host it degrades to a storage-only copy.

## Prototype status

This is a prototype for issue #210. Known follow-ups (not blockers):
the format isn't yet a spec surface, there's no per-note cache opt-out,
and the trailing-period recall UX is still being tuned. Architecture +
the `validateNoteWrite` chokepoint live in
`packages/opencues-runtime/src/blanks/note.ts`; the shipped config is
`defaults/blanks/note/BLANK.md`.
