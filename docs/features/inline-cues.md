# Inline cues (`inline-cues-mode`)

> **Status: exploration / spike.** Terminal reference implementation only.
> Placement and cross-host degradation are still being tuned. See
> `docs/architecture/inline-cues.md` for the design + implications.

Some cues carry a **passive advisory** rather than a cycleable alternative —
a sentence-cue's calendar-conflict heads-up, a contradiction cue's
"the 24th is a Friday, not Thursday". Historically that advisory only ever
appeared in the **secondary display** (the status line), visible when you
navigated onto the flagged word.

`inline-cues-mode` lets that advisory reveal **inline**, next to the text,
the moment your caret enters the flagged span — the "Error Lens" pattern.

## The model — one mechanism, two tiers of degradation

There is exactly one presentation, degrading gracefully:

- **Always-on indicator.** The flagged span is dimmed gray. That gray is the
  signal that "there's more here" — no content, just presence. It works on
  every host that can paint a dim range.
- **Cursor-gated reveal.** When the text cursor moves *into* the span, its
  note appears inline (gray). Move out, or edit, and it vanishes. The note reads
  in one **vocabulary**: an **emoji leads a notification** — something is flagged
  (`⚠` a factual / scheduling conflict, `✍️` a spelling error) — while **no emoji
  means a cycleable improvement** (a formality lift, a transform result, a lookup
  answer — nothing wrong, just a better option). A **countdown number** shows how
  many options remain (`⚠ 3 | the 19th is a Friday`, or `2 | Improve formality`),
  and a right-aligned **how-to hint** appears until you first use that note, then
  drops off — **per note**, so learning the gesture on one note doesn't silence
  the hint on a different one. The hint text matches the gesture:
  **`(underscore to cycle)`** for a cycleable cue, **`(ctrl+alt+up/down to adjust)`**
  for a volume/brightness knob. It shows again after a host restart. A pure
  advisory with nothing to cycle to (a calendar conflict) shows just the emoji
  and message — no number, no hint. The note is
  **display-only** — spliced into what the host *paints*, never into the buffer
  you submit, so it can never be sent. A long note **wraps** onto multiple lines
  and pushes the content below down to make room.
- **Press `_` to cycle / nudge.** With the caret inside a revealed span, a plain
  `_` rotates that span forward (the discoverable complement to Ctrl+Alt+↑). On a
  **volume/brightness knob** `_` nudges the value UP one step (and holds at the
  top); use Ctrl+Alt+↓ to come back down. Move past the span (type a space) or
  edit it, and `_` goes back to its normal blank meaning.

Where a host has no inline paint surface (e.g. chrome's normal
`<input>`/`<textarea>`, where CSS Custom Highlight can't reach), the advisory
**degrades automatically to the secondary display** — the same status-line
behaviour as before. This is degradation, not a second implementation: the
cue is authored once; the runtime picks the richest surface available.

## Values

```yaml
inline-cues-mode: inline      # default
# inline-cues-mode: secondary  # keep advisories in the status line only
```

- `inline` (default) — reveal inline on cursor-in-span, on hosts that can
  paint it; degrade to the status line elsewhere. When inline paint is
  available the status-line copy is suppressed (no redundant double-display).
- `secondary` — advisories always show in the status line only; no inline
  reveal.

## What it applies to

**Every note-bearing gray span** (the uniform note model, July 2026):

- **Passive cues** (`def.cueTip`) — **sentence-cues** (`scope: sentence`, e.g.
  the calendar-conflict heads-up) and **contradiction cues** — show their advisory.
- **Word-cues** (incl. spelling) show their suggestions.
- **Actuators** — `volume` / `brightness` (any `blankStep` blank) — fill a value
  (`volume 32%`) and show a live-knob note: `🔊 system volume` / `🔆 screen
  brightness` (emoji from the blank's `icon:`, label from its `tip:`) plus the
  adjust hint. `Ctrl+Alt+↑/↓` or `_` change the real device level; the value in
  the buffer tracks it. Once the caret is in the value it's adjustable with no
  separate navigate ("GET arms the knob").
- **Settings selector-satellite** (`opencues settings _`) shows a cursor-aware
  tip: the setting's description on the selector, the value's tip on the satellite.

A bare **blank keyword** before its `_` fires is the one gray-less exception —
it's a pure trigger, no note.

## Host reach

| Host | Inline reveal | Notes |
|---|---|---|
| Claude Code | ✅ | Reference implementation (terminal splice). |
| OpenCode / shell / gemini | ⏳ | Terminal painters share the channel; wiring is a follow-up. |
| Chrome (contenteditable) | ⏳ | Dim works; inline text reveal needs design (reconciler-safe). |
| Chrome (normal input) | ➡️ secondary | No paint surface — degrades to status line. |

## Design

Full design, the render-directive channel it rides on, the cursor-gating
rationale, and the cross-host implications: `docs/architecture/inline-cues.md`.
