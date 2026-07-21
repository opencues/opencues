# Apple Notes band — repair log

Running log of host quirks and the fixes that pin them, per
`docs/guides/adding-an-integration.md` §8. Platform measurements live in
`integrations/apple-notes/NOTES-PLATFORM.md`.

## AN-1: Notes serializes entities WITHOUT semicolons on read-back

`body` read back from Notes contains `&lt` / `&gt` / `&amp` / `&quot`
(no trailing `;`), while standard semicolon entities are accepted on
write. Any code that locates a line inside `body` by escaping plaintext
itself and `indexOf`-ing will get zero matches on lines containing
`<`, `>`, `&`, or `"`.

**Fix:** `v1/html-text.ts` — `splitBodyLines` extracts each `<div>`
fragment's text by stripping tags + `unescapeNotesEntities` (tolerant of
both entity forms), and `spliceLineIntoBody` compares at the plaintext
level, never at the HTML level. Pinned by `html-text.test.ts`
("encoding-mismatch case").

## AN-2: `body` set replaces the whole note — attachments die

Setting `body` rewrites the entire note HTML. Attachment-bearing notes
would lose images/scans/checklist state.

**Fix:** two layers — the daemon skips notes flagged by
`bodyLooksAttachmentBearing()`, and the write path is always a
single-line splice (`spliceLineIntoBody`), which returns `null` (abort,
no write at all) on zero/multiple matches rather than falling back to a
plaintext→div rebuild.

## AN-3: TCC denial is SILENT when a deny is cached

First osascript Apple Events call normally prompts, but a cached deny
fails instantly (~70ms, exit 1, stderr `(-1743)`) with **no dialog**.
Observed on the dev machine 2026-07-06: a deny was recorded for
`com.apple.Terminal` without any prompt shown (the requesting process
ran sandboxed). Users cannot tell this apart from "OpenCues is broken."

**Fix:** the daemon classifies `-1743` as `permission-denied` and enters
a degraded state (no crash-loop); `opencues doctor` surfaces the exact
recovery: System Settings → Privacy & Security → Automation → [your
terminal] → Notes, or `tccutil reset AppleEvents com.apple.Terminal`
to re-arm the prompt.

## AN-4: `modificationDate` has 1-second resolution

Two changes inside the same second are indistinguishable by date; the
daemon's own CAS write also bumps it. Never use modificationDate for
echo discrimination — compare content hashes (per-note last-written
plaintext hash) and classify hash-matching polls as `source: 'runtime'`.

## AN-5: no cursor / key / render channel exists

AppleScript exposes no selection or cursor for Notes. The band is the
universal/no-cycling profile: `supportsCycling()` and
`supportsAgentRewrite()` return false, `onKey`/`onCursorChange`/
`onRender` are inert, `forceRender` is a no-op, and the daemon
synthesizes `cursorOffset` at `indexOf('_') + 1` (else text end).

## AN-6: LLM whole-buffer rewrites omit the trailing newline

Notes plaintext always ends with `\n`; TransformBlank/merge output often
doesn't. One landed fill with the 1-char-short text poisoned the
daemon's snapshot and every later fill self-dropped on the changed-
since-resolution guard. **Fix:** `ensureTrailingNewline` canonicalizes
every runtime write at the daemon's requestWrite boundary (tick.ts).

## AN-7: echo classification must tolerate in-flight writes AND
## Notes' character normalization

Two bites: (1) some characters don't round-trip byte-identically
(observed with U+203E as a loading frame), so hashing the INTENDED
text misclassified our own echo as a user edit; (2) a poll reading the
note between a CAS landing and its hash being recorded did the same.
**Fix:** per-note SET of recent write hashes (capped, `recordWriteHash`)
containing both the intended text (recorded BEFORE the CAS) and the
as-landed plaintext that `fill-note.js` returns.

## AN-8: address Notes by bundle id, never display name

`Application('Notes')` broke with a LaunchServices desync ("Application
isn't running" -600 while the process was demonstrably running) after
Notes was quit and relaunched; `Application('com.apple.Notes')` kept
working, and is also locale-proof. All jxa/ scripts use the bundle id.
