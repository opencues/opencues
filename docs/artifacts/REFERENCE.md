# OpenCues artifact kit — reference

Full reference for the two pieces of the kit: **the theme** and **the hero
animation**. For the quickstart, see [`README.md`](README.md).

- [Design tokens](#design-tokens)
- [Vertical rhythm](#vertical-rhythm)
- [Fonts](#fonts)
- [Page skeleton](#page-skeleton)
- [Components](#components)
- [Keys, chips and code](#keys-chips-and-code)
- [Things you can press](#things-you-can-press)
- [The hero animation](#the-hero-animation)
- [PDF rules](#pdf-rules)
- [Video rules](#video-rules)
- [Gotchas](#gotchas)
- [Writing style](#writing-style)
- [How the build works](#how-the-build-works)

**The one rule behind most of the rest:** this kit does not have its own design
system. It borrows opencues.com's. Before inventing a spacing value, a colour, a
radius, or a link treatment, **open the site and find where it already solves
that problem**. Every rule below started as something invented and then corrected
against a real page.

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
- **A hover colour is not a fill colour.** `--code-purple-hover` (`#DEA4FF`) is
  what the site's links warm to for a moment. Held permanently it becomes the
  brightest thing on the page, and white on it runs about 1.9:1. The resting
  purple `#BE6EEC` — the one on the install bar's `npm i` — is what a solid fill
  uses, at about 3.2:1. Check contrast before promoting any hover colour.

---

## Vertical rhythm

The site has a spacer scale and uses **only** these values. A gap that isn't one
of them is a gap someone invented:

| Class | Value | Typical use |
|---|---|---|
| `micro-spacer` | `.6rem` | title to the rule under it |
| `micro-two-spacer` | `1.2rem` | |
| `small-spacer` | `2.2rem` | title to its standfirst |
| `medium-two-spacer` | `4rem` | |
| `medium-spacer` | `6rem` | header to body; between sections |
| `medium-three-spacer` | `8rem` | |
| `large-spacer` | `12rem` | |

These pages don't use the classes (the content is plain HTML), but the *values*
are the same, expressed in the twin stylesheets:

- **Header** — `2.2rem` under the title, `6rem` under the standfirst.
- **Section** — `6rem` of air above the rule, `.6rem` between rule and heading.

The `6rem` in both is deliberate: the header and the sections then share one
rhythm, so the page reads as evenly spaced rather than as a header bolted onto a
body. **These pages are short — let them breathe.** Cramping is the more common
mistake by far.

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

**`.sp` marks the value, not the phrase.** In `volume 32%` the product selects
`32%`; `volume` is ordinary text. Highlighting the whole string is a claim about
the product that isn't true. `.sp` is deliberately **not** scoped to `.term`, so
a table cell or a caption showing what your text becomes can mark the value the
same way — use it anywhere the page depicts a live value.

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
  <tr><th>You type</th><th>Mode</th><th class="mono">Your text becomes</th></tr>
  <tr><td class="mono">volume _</td><td><span class="badge">GET</span></td><td class="mono">volume <span class="sp">26%</span></td></tr>
</table></div>
```

A "what your text becomes" cell is a depiction of the product, so it follows the
same rule the terminal does: `.sp` on the value only.

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

An aside on the same grey panel as a card. For a caveat, a design note, or an
open question. Not for body copy. It has no rail and no border: an aside is
already set apart by its panel.

### Footer — `.foot`

The provenance line: where the content came from and how it was verified. Every
page should end with one — it's what makes a page trustworthy a month later.

---

## Keys, chips and code

Three inline treatments that look similar and mean different things. Picking the
wrong one teaches the reader something false, so the distinction is worth
holding:

| Write | For | Example |
|---|---|---|
| `<kbd>` | **a key you press** | `Ctrl+Alt+↑`, and the `_` in "Press `_`" |
| `<code>` | **literal text**, typed or shown | `volume _`, `volume-blank.sh get` |
| `.badge` | **a mode or state label** | `GET`, `SET` |

The trap is `_`, which is both a character you type and a key you press. In
`volume _` it is part of a phrase the reader types, so it's `code`. In "Press `_`
and it goes to 32%" it's the key itself, so it's `kbd`. **Not every `_` on the
page is a keycap** — one sitting inside a sentence of prose or inside a longer
command is ordinary inline code.

The same logic makes keycaps rare: a keycap says "this is a physical control",
so it belongs on `Ctrl+Alt+↑` and on a standalone `_`, and nowhere else.

---

## Things you can press

Anything drawn with a shadow reads as raised, which quietly promises it can be
pushed. So the keycaps take a pointer cursor and depress under the cursor. They
do nothing — it's tactility, not an action.

Four constraints make it behave:

1. **`display:inline-block`.** `kbd` is inline by default, and **`transform` is
   ignored on non-replaced inline elements**, so the press would silently do
   nothing. This shipped once and looked fine in the video (which uses a
   different rule) while doing nothing in the browser.
2. **Depth moves in `box-shadow`, never in the box model.** Animating
   `border-width`, `padding`, `height` or `margin` reflows the row — press a
   keycap in a table and the whole row jumps. `transform` and `box-shadow` are
   free.
3. **`user-select:none`.** Clicking repeatedly otherwise starts selecting the
   glyph inside, which breaks the illusion instantly.
4. **Not focusable, no `button` role.** Nothing should promise a keyboard
   interaction that doesn't exist.

Downloads are the opposite case. They are **links, not buttons**: the site
offers files as a plain `Download ↓` that warms on hover, so these pages do the
same, at the small mono size the rest of the labels use.

Scrollbars, likewise, follow the site: it **hides** them rather than styling
them, so a wide table or terminal here scrolls with no visible bar
(`scrollbar-width:none` + `-webkit-scrollbar{display:none}`).

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
- **The caption bar is a constant height**, and this matters more than it
  sounds. The hero is vertically centred in the video stage, so *any* change in
  the bar's height moves the whole demo up or down between frames — a visible
  jitter that reads as the page twitching. Two things can change it, and both
  are guarded:
  - **Wrapping** — hence `white-space:nowrap`; it scrolls sideways instead.
  - **The keycap.** An inline-block taller than the line box grows the line,
    and the keycap only exists on *some* frames. So `line-height` is explicit
    and must stay greater than `.hkey`'s height. **Resize one, resize both** —
    including the scaled-up copy in `render-video.cjs`, which is where this
    shipped broken: the caption jumped 3px on every frame that had a key.
- **The caret matches the highlight it sits beside.** Its `height` and
  `vertical-align` are measured against the `.sp` background box, in `em` so
  they hold at any size. A caret that stops short of the highlight looks
  misaligned even when nobody can say why. Re-measure if the mono face changes.

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

### 4. `transform` does nothing on an inline element

CSS ignores `transform` on non-replaced inline elements. `kbd`, `code` and
`span` are all inline by default, so a press effect on one is silently dropped —
no error, no warning, it just never moves. Add `display:inline-block`.

### 5. Measuring a render is easy to get wrong

Two failures in one session, both of which produced confident wrong answers:

- **A mis-cropped region.** Cropping the wrong 60×50 box "proved" the keycap had
  no colour when it was plainly purple two pixels over. Confirm a crop by
  *looking* at it before trusting a number taken from it.
- **A syntax that silently means something else.** ImageMagick's `%[fx:mean_r]`
  is not the red channel — the real symbol is `%[fx:mean.r]`. The wrong one
  returns luminance three times, so every reading came back perfectly neutral
  and looked like a real result.

A measurement that looks like a measurement is worse than eyeballing, because
you stop questioning it. Sanity-check against a known value: crop a region whose
colour you already know and confirm the number matches.

### 6. Centred layout turns a height change into movement

The video stage centres the hero vertically. Anything that changes a child's
height therefore moves *everything*, by half the difference, in both directions.
A 6px taller caption bar became a 3px jump of the whole demo.

Watch for this wherever content is centred rather than top-aligned: a height
change that would be invisible in a normal document becomes motion. Verify by
measuring a fixed landmark — a divider row, a border — across several frames and
checking the number doesn't move.

### 7. A block glyph is not a caret

The caret is drawn in CSS (a 2px rule), not typed as `▌`. A half-block is far
heavier than any real terminal caret, and the *thin* block characters aren't in
every font — a missing glyph renders as a tofu box, which is worse than heavy.

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

### Verify against a running host, region by region

Every factual error on these pages so far has been invented rather than
mis-copied, and none was visible in the source:

- `volume _` was documented as producing a list of options to cycle. It never
  did. The example came from a unit-test fixture, and it survived several reads
  because it was plausible.
- The terminal blocks correctly highlighted only the value, while the **table**
  two sections up showed the whole `volume 26%` in one colour — claiming the
  product selects the entire phrase. The stylesheet gave no hint; only a render
  did.

So: open the feature in a real host, and check the page **one region at a time** —
each table, each card, each filmstrip frame — rather than reading it as a whole
and concluding it looks right. Then say what you checked in the `.foot`. An
example the product doesn't actually produce is worse than no example.

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
