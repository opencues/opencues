# OpenCues artifact kit — reference

Full reference for the two pieces of the kit: **the theme** and **the hero
animation**. For the quickstart, see [`README.md`](README.md).

- [Design tokens](#design-tokens)
- [Fonts](#fonts)
- [Page skeleton](#page-skeleton)
- [Components](#components)
- [The hero animation](#the-hero-animation)
- [Gotchas](#gotchas)
- [Writing style](#writing-style)
- [How the build works](#how-the-build-works)

---

## Design tokens

Every colour lives in the `:root` block of `theme.css` — nothing is hard-coded in
a component. Source of truth: `~/opencues-website/style.css`.

| Token | Value | Use |
|---|---|---|
| `--paper` | `#111111` | page background |
| `--panel` | `#181818` | card background (a hair lighter than the page) |
| `--panel-2` | `#0c0c0c` | recessed panels, callouts, the hero frame |
| `--ink` | `#e6e6e6` | primary body text (headings use `#fff` directly) |
| `--muted` | `#8a8a8a` | secondary text |
| `--faint` | `#5b5b5b` | tertiary text, table headers |
| `--hair` | `#252525` | hairline borders |
| `--accent` | `#be6eec` | **primary accent** (code-purple) — use sparingly |
| `--accent-2` | `#9ec0ff` | secondary accent (code-blue) |
| `--accent-soft` | `#231a2b` | dark purple tint for chips / pressed states |
| `--term-bg` `--term-fg` `--term-dim` | `#0a0a0a` `#d6d6d6` `#7c7c7c` | terminal block |
| `--live` / `--live-bg` | `#5fbf8a` / `#12241a` | "live / real effect" green |
| `--edge` / `--edge-bg` | `#d9a24a` / `#241d10` | "at a limit / max" amber |
| `--mute` | `#d66f6b` | "muted / zero" salmon |

**Rules of thumb**

- The accent is for *emphasis*, not decoration: eyebrows, section numbers, inline
  `code`, the keycap. If half the page is purple, cut it back.
- The semantic colours (`--live`, `--edge`, `--mute`) mean *state*. Don't use
  them as a second accent, and don't use the accent to mean state.
- **Corners are sharp.** 5–6px on panels and terminals, 3–4px on code/keycaps,
  full pills only on `.badge`. The rounded-everywhere look is not OpenCues.

---

## Fonts

Three faces, all from `~/opencues-website/fonts/`:

| Family | Weight | Variable | Used for |
|---|---|---|---|
| TWK Lausanne | 300 | `--sans` | body copy |
| TWK Lausanne 200 | 200 | `--display` | `h1`, `h2` — the signature light display weight |
| Ufficio Mono | 300 | `--mono` | code, terminal, eyebrows, table headers, labels |

**They must be base64-inlined**, not linked. The artifact CSP blocks external
font hosts, so a `<link>` or `@import` silently falls back to a system font.
`build.cjs` handles this — it reads the font files and emits an `@font-face`
block with `data:` URIs. That's ~155 KB per page, which is the expected cost of a
self-contained artifact.

**Emphasis is by colour, not weight.** Only the 300 weight ships for body text,
so `strong` renders as white rather than bolder. Don't reach for `font-weight`
to emphasise something.

---

## Page skeleton

A body file is page content only — no `<!doctype>`, `<html>`, `<head>`, `<body>`,
or `<style>` (the host wraps the file, and `build.cjs` adds the style):

```html
<div class="wrap">
  <p class="eyebrow">OpenCues · Reference</p>
  <h1>Page title</h1>
  <p class="dek">One-sentence summary of what this page is.</p>

  <!--HERO-->            <!-- optional: build.cjs splices hero.html here -->

  <h2><span class="n">01</span>First section</h2>
  <p class="lead">Intro line for the section.</p>
  …
  <div class="foot">Provenance line — where this came from, how it was verified.</div>
</div>
```

`h2` sections are numbered with `<span class="n">01</span>` and top-ruled. Keep
the numbering sequential; it's how readers navigate a long page.

---

## Components

### Terminal block — `.term`

The workhorse. A monospace panel showing a line of text plus the dim note under
it, exactly as OpenCues renders in a real host.

```html
<div class="term"><span class="buf">volume <span class="sp">32%</span></span><span class="note"><span class="arw">↳ </span>🔊 system volume   <span class="hint">(ctrl+alt+up/down to adjust)</span></span></div>
```

| Class | Meaning |
|---|---|
| `.buf` | the line being annotated (the user's text) |
| `.sp` | the **active span** — a background highlight, matching how the product highlights. Never an underline. |
| `.note` | the dim note line underneath |
| `.arw` | the `↳` connector |
| `.hint` | the parenthetical how-to hint (italic) |

⚠ **Children go on ONE line.** See [Gotchas](#gotchas).

### Cards — `.cols` / `.box`

Two-up grid that collapses to one column under 600px. A `.box` can contain a
`.term`.

```html
<div class="cols">
  <div class="box"><p class="t"><span class="em">🔊</span> volume</p>
    <p>Description.</p></div>
  <div class="box"><p class="t"><span class="em">🔆</span> brightness</p>
    <p>Description.</p></div>
</div>
```

### Tables

Plain `<table>`, wrapped in `.scroll` so wide ones scroll on their own instead of
widening the page. `td.mono` for monospace/aligned-number cells.

```html
<div class="scroll"><table>
  <tr><th>You type</th><th>Mode</th><th class="mono">Result</th></tr>
  <tr><td class="mono">volume _</td><td><span class="badge get">GET</span></td><td class="mono">volume 26%</td></tr>
</table></div>
```

### Badges — `.badge`

Small pills for a mode or state. Ships with `.get` (blue), `.set` (green),
`.step` (purple). Add a variant by pairing a background tint with matching text.

### Gauges — `.gauge` / `.bar`

A value on a 0–100 track. `.bar.edge` (amber) for a maximum, `.bar.mute`
(salmon) for zero.

```html
<div class="gauge"><span class="v">32%</span><div class="bar"><span style="width:32%"></span></div><span class="lbl">normal</span></div>
```

### Filmstrip — `.strip` / `.frame`

A labelled sequence of states: a label column and a terminal column, collapsing
to one column on mobile. Use it to walk through an interaction step by step.

```html
<div class="strip">
  <div class="frame"><div class="act"><span class="k"><kbd>volume _</kbd></span><span class="hw">reads 26%</span></div>
    <div class="term">…</div></div>
</div>
```

`.hw` is the "what actually happened" line (green); `.hw.edge` amber for a limit,
`.hw.mute` salmon for zero.

### Callout — `.note-callout`

A recessed aside with an accent rail. For a caveat, a design note, or an open
question. Not for body copy.

### Footer — `.foot`

The provenance line: where the content came from and how it was verified. Every
page should end with one — it's what makes a page trustworthy a month later.

---

## The hero animation

`hero.html` is an optional looping demo for the top of a page. It **reuses
`.term`**, so it renders identically to the static examples below it — that
consistency is the point, and breaking it was a real bug (the hero had its own
font-size/line-height and looked subtly wrong).

**Structure:** a `.hero` frame containing a `.term` (the animated line) and a
`.hero-cap` caption bar underneath that narrates the current step.

**Behaviour**

- **Types the command out** character by character with a blinking caret, then
  shows the result and steps through states.
- **Slow and unhurried** — each step is `[action, ms-to-hold-after]`, with the
  longest hold on the state carrying the most to read. A full loop is ~16s.
- **The caret is always visible**, and sits on the *value* — the part the user
  actually interacts with — never disappearing between steps.
- **The keycap is inline in the caption** ("press `[_]` to nudge it up") and only
  appears on steps that actually show a press. It depresses on each press. No
  idle placeholder.
- **The caption never wraps** — it scrolls sideways like a terminal, because a
  wrapped caption changes the bar's height and breaks the layout.

**Reduced motion.** The hero *still plays* under
`prefers-reduced-motion: reduce`; it just skips the typewriter effect and the
keycap depress and keeps the slow state loop. This is deliberate: an earlier
version froze on a single static frame, which read as "the animation is broken"
to anyone with the OS setting on. Don't reintroduce a full stop.

**DOM-ready init.** The script initialises on `DOMContentLoaded` (or immediately
if the document is already parsed). Without this it can run before its element
exists, bail out, and leave the page frozen on the first frame.

**Adapting it.** Edit the `TYPED` string, the `fill()` values, and the caption
text in the script. The markup rarely needs to change.

---

## Gotchas

### 1. `white-space:pre` renders inter-element whitespace

`.term` uses `white-space:pre` so aligned output stays aligned. That means **any
newline or indentation between child elements is rendered as literal blank
space**, pushing the note line away from the line it annotates.

```html
<!-- RIGHT: children on one line, no whitespace between tags -->
<div class="term"><span class="buf">…</span><span class="note">…</span></div>

<!-- WRONG: the newlines become visible blank space -->
<div class="term">
  <span class="buf">…</span>
  <span class="note">…</span>
</div>
```

This is the single most common way to break one of these pages, and it looks like
a mysterious spacing bug rather than a markup bug.

### 2. Grid/flex children need `min-width:0`

A grid or flex child won't shrink below its content's intrinsic width unless you
say so. A wide terminal line inside a card therefore pushes the card past the
viewport on mobile — the "box in a box" break. `.box`, `.term`, and `.frame .act`
all set `min-width:0`; `.wrap` also carries `overflow-x:hidden` as a last guard.

Anything wide gets its own `overflow-x:auto` container so **it** scrolls and the
page never does.

### 3. Fonts can't be linked

The artifact CSP blocks external font hosts. Linking a font fails *silently* —
you get a system fallback that looks almost right. Always inline (build.cjs does).

---

## Writing style

The pages exist to explain a feature to someone who doesn't have the source open.
Internal vocabulary defeats that.

- **Don't name internals.** "Step 6" means nothing to a reader — write "each
  press moves it 6 percentage points". Not "the buffer" — "your text". Not "the
  keystroke is consumed" — "no `_` is typed into your text". Not "`set 32`"
  (that's the script call) — "26 + 6 = 32%".
- **Say what happens, not what the code does.** A caption under a state should
  describe the observable effect.
- **Don't over-claim in a demo.** If the animation only climbs to 50%, the
  caption must not say "up to 100%", and it must not teach a gesture the demo
  never shows. Anything the demo doesn't demonstrate belongs in the tables below.
- **Check the arithmetic.** Worked examples get read closely; a sequence that
  doesn't add up destroys trust in the whole page.

---

## How the build works

`build.cjs` does three things:

1. **Generates the `@font-face` block** by base64-encoding the three font files
   from `~/opencues-website/fonts/` (override the location with `OC_WEBSITE`).
   Caches to `oc-fontface.css` (gitignored) so builds still work without the
   website repo checked out.
2. **Splices the hero** into the body at an `<!--HERO-->` marker, if present.
3. **Concatenates** `<title>` + `<style>`(fonts + `theme.css`) + your body into
   one self-contained file.

```
node build.cjs <body.html> <out.html> "<title>"
```

The output is publishable as-is: no external requests, no build step at view
time, renders standalone.

**Live examples built with this kit:** the volume/brightness actuator reference
(states, gestures, hero animation) and the component baseline page.
