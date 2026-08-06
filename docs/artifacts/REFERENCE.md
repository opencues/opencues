# OpenCues artifact kit — reference

Full reference for the two pieces of the kit: **the theme** and **the hero
animation**. For the quickstart, see [`README.md`](README.md).

- [Design tokens](#design-tokens)
- [Fonts](#fonts)
- [Page skeleton](#page-skeleton)
- [Components](#components)
- [The hero animation](#the-hero-animation)
- [PDF rules](#pdf-rules)
- [Video rules](#video-rules)
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
| `--accent` | `#9ec0ff` | **primary accent** (code-blue) — use sparingly |
| `--accent-2` | `#9085e9` | secondary accent (violet) — rarer still |
| `--press-bg` / `--press-fg` | `#BE6EEC` / `#fff` | a key being pressed right now (the site's resting purple, not its hover) |
| `--term-bg` `--term-fg` `--term-dim` | `#000` `#d6d6d6` `#7c7c7c` | terminal block |
| `--live` / `--live-bg` | `#9ec0ff` / 12% of it | "it happened" |
| `--edge` / `--edge-bg` | `#d66f6b` / 14% of it | "at a limit" |
| `--mute` | `#5b5b5b` | "zero / absent" |

**Rules of thumb**

- The accent is for *emphasis*, not decoration. Most of the page is greyscale;
  colour marks the few things that carry state. If a colour is doing no work,
  take it out.
- **Don't colour what is already a shape.** A keycap, a chip, and a code span
  are already set apart by their box, so colouring them too says the same thing
  twice. That's why the chips are neutral.
- The semantic colours (`--live`, `--edge`, `--mute`) mean *state*. Don't use
  them as a second accent, and don't use the accent to mean state.
- **Everything is square.** `border-radius: 0`, with no exceptions — the site
  uses only 0 and 50%, and nothing on these pages is a circle. Rounded corners
  read as someone else's design system.
- **Nothing has a 360° border.** Depth comes from a fill or a shadow, never an
  outline round a box.

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
  <h1>Page title</h1>
  <p class="dek">One-sentence summary of what this page is.</p>

  <!--HERO-->            <!-- optional: build.cjs splices hero.html here -->

  <h2>First section</h2>
  <p class="lead">Intro line for the section.</p>
  …
  <div class="foot">Provenance line — where this came from, how it was verified.</div>
</div>
```

`h2` sections are top-ruled and **not numbered**. Numbers imply the reader has to
go in order, so they belong on a real sequence (the steps of a worked example)
and nowhere else. A reference page is read by jumping to the part you need.

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

Small square chips for a mode or state, and they are **neutral on purpose**: a
chip is already a box, so a colour on top of it repeats what the box said. The
words `GET` / `SET` carry the meaning. Existing pages still write `.badge get`
and friends; those modifier classes style nothing and are kept only so the
markup reads.

### Gauges — `.gauge` / `.bar`

A value on a 0–100 track. The fill is the accent; `.bar.edge` (salmon) marks a
maximum and `.bar.mute` (grey) marks zero. This is one of the few places colour
earns its keep, because the bar has no words on it.

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

`.hw` is the "what actually happened" line, set in `--muted`. It is deliberately
uncoloured: it sits next to the terminal that proves it, and the sentence itself
says whether something hit a limit.

**Tune `--label-col` per strip.** The label column is a fixed width, so a caption
longer than it wraps to two lines and the row grows. Measure the widest caption
in *that* strip and set the width on the strip itself
(`<div class="strip" style="--label-col:19.5rem">`), rather than picking one
number for every strip on the page. Leave a comment naming the caption you
measured against, so the next person editing the captions knows to re-measure.
There is no excuse for a strip whose captions wrap.

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


## PDF rules

The PDF is a **pre-rendered file** (`render-pdf.cjs` → Chrome `--print-to-pdf`),
committed next to the page. It is not made in the reader's browser: `print()` is
blocked inside a published artifact's sandboxed iframe and is unreliable on
mobile. Regenerate it whenever the content or the theme changes.

What the print rules guarantee, and why each exists:

| Rule | Why |
|---|---|
| `print-color-adjust:exact` on everything, `@page{background}` | browsers drop backgrounds when printing; without this the dark ground turns white |
| colours are **declared, not inherited**, on `th`/`td` | an inherited cell colour printed near-black and was unreadable |
| `.sec{break-inside:avoid}` | keeps a section whole, so one never bleeds across a break. Half-empty pages are intended: these documents are short and should breathe |
| `.foot{break-before:avoid}` | spacious is not the same as a page holding two lines |
| `h2`, `.lead`, `h3` `break-after:avoid` | a heading or its intro is never stranded at a page foot |
| `.term`, `.box`, `.frame`, `.gauge`, `.note-callout` `break-inside:avoid` | a terminal or card never splits mid-component |
| `.oc-actions`, `.hero-cap` hidden | the toolbar is not content, and a "press this key" instruction means nothing on paper |
| `--virtual-time-budget` passed to Chrome | an animation is a bare caret at t=0, so a straight print captures an empty box |

A section taller than a page still breaks: `avoid` is a preference, not a
guarantee. That is correct behaviour, not a bug to chase.

## Video rules

The video is also pre-rendered (`render-video.cjs`), in two cuts: **raw** (the
demo alone, nothing to crop for social) and **captioned** (title and description
burned in). 1280x720, H.264, yuv420p, which is what social platforms accept.

Frames come from the **real** hero markup and theme, never a re-implementation,
so the video cannot drift from the page. Three constraints follow from how
frames are captured:

- **No CSS transitions on anything the video must show.** A frame is captured
  the instant the animation's callback fires, so a transition is still at 0% and
  its end state never appears. This is why the key press applies instantly.
- **Reduced motion must be overridden.** Headless Chrome reports
  `prefers-reduced-motion: reduce`, which made the hero skip its typewriter.
- **Nothing may sit in HTML space.** A comment left outside its script tag
  rendered as visible text across the top of every frame.

Designers: the video's look is the page's look. Change `theme.css` (or
`oc-doc.css`) and re-run the renderer; there is no separate video styling beyond
the stage in `render-video.cjs`, which only scales the type up and sets the 16:9
ground.

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
