# Artifact → website pipeline

How a page gets written once and published twice: as a **standalone artifact**
(shareable link, self-contained) and as a **page on opencues.com**.

```
docs/artifacts/pages/<name>.html          ← the content. One source of truth.
        │
        ├── node build.cjs <src> <out> "<title>"          → ARTIFACT
        │     theme.css + fonts base64-inlined            self-contained page,
        │     .wrap page shell                            publish with the Artifact tool
        │
        └── node build.cjs --site <src> <out>             → SITE FRAGMENT
              no fonts (the site loads them)              paste into a page in
              no shell (.base-grid owns layout)           ~/opencues-website
              .wrap → .oc-doc  (scoped)                   which links oc-doc.css
```

## The two halves

| | Artifact | Site |
|---|---|---|
| Stylesheet | `docs/artifacts/theme.css` (this repo) | `oc-doc.css` (website repo) |
| Fonts | base64-inlined (CSP blocks font hosts) | already loaded by the site |
| Layout | its own `.wrap` shell | the site's `.base-grid` / `.copy-block` |
| Scope | whole page | everything under `.oc-doc` |
| Tokens | literal values in `:root` | mapped onto the site's own variables |

**The class names are identical on both sides** — `.term`, `.box`, `.gauge`,
`.frame`, `.badge`, `.note-callout`, `.hero`. That's what makes one body work in
both places. The two stylesheets differ only in tokens and shell, so **keep them
in step**: adding a component to one means adding it to the other.

## Publishing a new page

1. **Write the content** as body-only HTML at `docs/artifacts/pages/<name>.html`.
   Start from `example-body.html`. No `<!doctype>`/`<html>`/`<head>`/`<style>` —
   everything inside a single `<div class="wrap">`. Leave a `<!--HERO-->` marker
   if you want the looping demo.
2. **Build + publish the artifact** —
   `node docs/artifacts/build.cjs docs/artifacts/pages/<name>.html /tmp/<name>.html "<Title>"`
   then publish that file. Iterate here: it's the fast loop.
3. **Build the site fragment** —
   `node docs/artifacts/build.cjs --site docs/artifacts/pages/<name>.html /tmp/<name>-frag.html`
4. **Drop it into a page** in `~/opencues-website`: copy an existing page shell
   (head meta / OG / the `base-grid` body), link `oc-doc.css`, and paste the
   fragment between `<!-- BEGIN generated fragment -->` and `<!-- END generated
   fragment -->`. Re-running step 3 and replacing what's between the markers is
   the whole update path.
5. **Website PR.** Site changes go via a PR on the website repo, and a new
   published page needs its sitemap entry — see that repo's CLAUDE.md.

Worked example, all four pieces live: source
`docs/artifacts/pages/actuator-states.html` → website page
`actuator.html` + `oc-doc.css`.

## Why paste the fragment instead of `data-include`

The site's `data-include` injects a component with `innerHTML`, and **`innerHTML`
never executes `<script>`**. A page whose fragment carries the hero animation
would render the markup and silently never animate. Pasting the fragment into the
page keeps the script inline where the parser runs it.

If a page has no animation, `data-include` would work — but use one mechanism, not
two, so nobody has to remember which pages animate.

## Who owns what

- **Content** — this repo. It is documentation of a feature, and it belongs next
  to the feature it documents.
- **Presentation** — the designer, in the token block at the top of `oc-doc.css`.
  Every colour, face, and radius is a variable there; no component rule hard-codes
  one. Retheming the site carries through without touching content.

## The integration layer

Three things sit between the source and the site. None is hard on its own; the
cost is that they're invisible until one breaks.

### 1. What `--site` actually transforms

| Step | Why |
|---|---|
| `<div class="wrap">` → `<div class="oc-doc">` | `.oc-doc` is the scope every rule in `oc-doc.css` hangs off. `.wrap` also carries a page shell (background, max-width, padding) the site must own instead. |
| Theme + `@font-face` omitted | The site already loads TWK Lausanne and Ufficio Mono, and links `oc-doc.css` itself. Inlining either again would fight the site. |
| HTML comments stripped | They're authoring notes for us. Published page source shouldn't carry the kit's internal warnings. Safe for the hero, whose script comments with `/* */` and `//`. |

Everything else passes through untouched, which is the point: the body is the
same bytes on both targets.

### 2. The twin-stylesheet contract

`docs/artifacts/theme.css` (this repo) and `oc-doc.css` (website repo) are twins.

**Must stay identical:** the class names and their structural rules — every
component (`.term`, `.box`, `.cols`, `.gauge`, `.bar`, `.frame`, `.strip`,
`.badge`, `.note-callout`, `.hero`, `.foot`) and the layout properties that make
them work, including the two mobile rules (`white-space:pre` on `.term`,
`min-width:0` on grid children).

**Deliberately differs:** the token values (site maps onto the website's own
variables instead of literals), the fonts (inlined vs already loaded), the page
shell (`.wrap` vs nothing), and the scope (global vs `.oc-doc`).

There is no CI gate for this — the files live in different repos — so the check
is manual. After changing either, compare the class sets:

```bash
cls(){ grep -o '^[^{]*{' "$1" | grep -oE '\.[a-z][a-z0-9-]*' | sort -u; }
diff <(cls ~/opencues/docs/artifacts/theme.css) <(cls ~/opencues-website/oc-doc.css)
```

A clean run prints exactly two lines: `.wrap` (artifact-only page shell) and
`.oc-doc` (site-only scope). Anything else is drift — a component class present
in one and missing from the other means that page renders on one target and
falls apart on the other.

### 3. The content-rule delta

The two targets have different editorial rules, and **the source must satisfy
the stricter of the two** (the site), because it feeds both:

- **No em dashes.** The website forbids them in authored copy. Use commas,
  colons, parentheses, or a sentence break.
- **No reviewer-facing prose.** An artifact often starts life as a design review
  ("shipped as stop-at-top per your steer, say the word if you'd rather it
  wrap"). That is addressed to one person and must not reach a public page.
  State the behaviour and why, and drop the ask.
- **One `h1`,** and no maturity hedging ("experimental", "prototype", "beta").
- **Titles end `- OpenCues`** on the site page's `<title>` (that's the page
  shell, not the fragment).

Full list in the website repo's CLAUDE.md § Content rules. Since the content is
generated, a violation is fixed **at the source here**, never in the website.


## Downloadable assets (PDF + video)

A page can offer its own PDF and a 16:9 video of the hero. Both are
**pre-rendered files**, not generated in the browser:

```bash
cd docs/artifacts    # REQUIRED: the renderers resolve their paths against cwd
node render-pdf.cjs   pages/<name>.html pdf/<name>.pdf "<Title>"
node render-video.cjs                                       # both cuts, 1280x720
```

⚠ **The renderers want `docs/artifacts` as the working directory; `build.cjs`
wants the repo root** (its paths in this file are repo-relative). Running either
from the wrong place fails with a bare `ENOENT` naming a path you did pass, which
reads like a missing file rather than a wrong cwd.

The buttons ride in the page body, so both targets get them. `build.cjs`
inlines the files as data URIs for the artifact target; the site target uses the
relative fallbacks (`pdf/`, `video/`), so copy the rendered files into the
website repo alongside the page.

**Regenerate on a theme change, not just a content change.** The video and the
PDF bake in whatever `theme.css` said at render time, so a colour that moved
only in CSS leaves them stale and silently disagreeing with the live page.

**Why the PDF is pre-rendered and not `window.print()`.** A published artifact
runs in a sandboxed iframe where `print()` is blocked, and it is unreliable on
mobile browsers anyway. A file downloads the same way everywhere. `print()`
remains as the fallback, and the print rules in both stylesheets still apply if
someone prints the page directly.

**How the video is captured.** Headless capture inside WSL is broken on this
class of machine (page screenshots hang on chromium and chrome-headless-shell
alike, even for a trivial page) and Chrome ignores `--remote-debugging-address`,
so CDP from WSL is not available either. What works is **Windows Chrome's
one-shot `--screenshot`**, one process per frame. To make that deterministic the
stage installs a **virtual-time shim**: `setTimeout`/`rAF` become a queue, and
`?mode=frame&n=K` advances the *real* hero code by exactly K callbacks.
`?mode=schedule` runs the whole loop and reports each callback's virtual time,
which becomes each frame's duration in the cut. So the video is driven by the
animation's own code and timings, and cannot drift from the page.

Two gotchas worth keeping:
- Headless Chrome reports `prefers-reduced-motion: reduce`, which made the hero
  skip its typewriter. The shim overrides `matchMedia` so the video shows the
  full animation.
- Anything injected into the stage must live *inside* its script tag. A comment
  left in HTML space rendered as visible text across the top of every frame.


### What the rendered output gets wrong that the page does not

A page can look right in the browser and still export badly. All three of these
shipped before being caught, and all three are invisible until you open the
artefact itself:

- **The PDF printed an empty hero.** At t=0 the animation is a bare caret, so a
  straight print catches nothing. `render-pdf.cjs` passes Chrome
  `--virtual-time-budget=5000`, which runs the animation on to a filled state
  before printing. Any future animated component needs the same treatment: a
  print is a snapshot of frame zero unless you move the clock.
- **Table text printed near-black.** The cells inherited their colour, and
  inheritance is exactly what a print path can reset. `th,td` now carry an
  explicit `color`, so there is nothing to lose on the way out.
- **A `transition` never reaches a frame.** Frames are captured the instant the
  animation's callback fires, so any CSS transition is still at 0% and its end
  state never appears. The key press therefore uses `transition:none` and
  applies instantly. This applies to every state the video is meant to show.

**Verify the artefact, not the page.** Open the PDF and step the video before
calling either done. Both are cheap to inspect from the shell:

```bash
gs -q -dNOPAUSE -dBATCH -sDEVICE=png16m -r70 -dFirstPage=1 -dLastPage=1 \
   -sOutputFile=/tmp/pdf-%d.png docs/artifacts/pdf/<name>.pdf     # look at a page
ffmpeg -v error -y -ss 7.5 -i docs/artifacts/video/oc-hero-raw.mp4 \
   -frames:v 1 /tmp/frame.png                                     # look at a frame
convert /tmp/pdf-1.png -crop 170x14+357+616 +repage -colorspace gray \
   -format '%[max]' info:                                         # measure a colour
```

That last one is worth the habit: eyeballing a dark render is unreliable, and a
crop that misses the text row reports the background and sends you fixing the
wrong thing.


### Pagination in the PDF

`build.cjs` wraps each `h2` and everything under it in a `<section class="sec">`
automatically, for both targets, so print rules have something to hold. Authors
don't add the wrapper; the two targets can't diverge on it.

The print rules then aim for a **spacious** document rather than a dense one,
because these pages are short:

- `.sec{break-inside:avoid}` keeps a section whole, so a section that would
  bleed across a break starts on a fresh page instead. Half-empty pages are the
  intended outcome here, not a failure. A section taller than a page still
  breaks naturally, since `avoid` is a preference rather than a guarantee.
- `.foot{break-before:avoid}` stops the closing note from landing alone.
  Spacious is not the same as a page holding two lines.
- `h2`, `.lead` and `h3` carry `break-after:avoid`, so a heading or its intro
  line is never stranded at the foot of a page.

Measured on the actuator page while tuning: 4 pages with section 05 split badly
(heading, lead and one filmstrip frame alone at the foot of a page), 6 pages
when every section was forced whole without the footer rule, 5 with the set
above. Rasterise and look, rather than trusting the page count:

```bash
gs -q -dNOPAUSE -dBATCH -sDEVICE=png16m -r50 \
   -sOutputFile=/tmp/p-%d.png docs/artifacts/pdf/<name>.pdf
```

## Gotchas

- **Don't hand-edit the fragment in the website.** It is generated. Edit the
  source and re-run step 3, or the two drift and the next rebuild silently
  reverts the fix. The generated block is fenced with BEGIN/END markers for
  exactly this reason.
- **Never write the literal `script` tag name inside an HTML comment** in
  `hero.html` or a page body. A "first script tag → last closing tag" regex
  (the kind used to swap the hero out) will match from the comment and eat the
  markup in between. This silently removed the hero once.
- **The two mobile rules still apply** on the site: `.term` children on ONE line
  (`white-space:pre`), and `min-width:0` on grid children. Both stylesheets carry
  them; don't drop them when adding a component.
