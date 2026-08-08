# Dismissing a cue

Some cues only tell you something. A calendar clash, a date that is not the
weekday you called it — there is nothing to swap in, just a note. When one of
those is wrong, or right but not now, you can silence it from the note itself.

## Press `_`

Put your cursor on the flagged text. The note tells you what to do:

```
I am free Thursday morning
⚠ clashes with dentist 10:00  (underscore to dismiss)
```

- **Press `_` once** and the cue goes quiet for half an hour. Nothing is typed
  into your text; the note simply disappears.
- **Press `_` twice** and it does not come back at all.

The hint fades once you have used it, the same way the other gestures teach
themselves and then get out of the way.

Notes that offer something to swap in keep their usual meaning: there `_`
cycles through the alternatives, and taking the suggested rewrite is the answer
rather than silencing it.

## Getting one back

Everything you have permanently dismissed is listed, and every row can be turned
back on:

```
opencues dismissals
```

```
  space or enter toggles a row · esc leaves it as it is

  ●  clashes with dentist 10:00              calendar · forgotten 2d ago
  ●  15 Aug 2026 is a Saturday, not a Friday contradiction · forgotten 2h ago

  Done
```

Nothing is written until you accept, so opening it to look costs nothing. A cue
you turn back on can appear again within a few seconds — you do not need to
restart anything.

For scripts and shortcuts:

| Command | What it does |
|---|---|
| `opencues dismissals list` | print what is silenced (`--json` to script it) |
| `opencues dismissals restore 2` | bring one back, by number or by a phrase from the list |
| `opencues dismissals clear` | bring them all back |
| `opencues dismissals path` | print the file, if you would rather edit it |

## Good to know

- A half-hour mute is not written down anywhere; it lapses on its own, and a
  fresh session starts clean.
- Silencing one cue never silences another, even a similar one on the next line.
- Dismissing is per phrase. If the same point comes back to you worded
  differently, it counts as a new cue.
- In the browser extension there is nowhere to save a permanent dismissal, so
  pressing twice quiets the cue for a day rather than forever.
