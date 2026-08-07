# CLAUDE.md — the artifact kit

Working context for anything under `docs/artifacts/`. What the kit is and how to
drive it: [README.md](README.md). Every component and every gotcha:
[REFERENCE.md](REFERENCE.md). How a page reaches the website:
[PIPELINE.md](PIPELINE.md). This file is the part that is easy to get wrong and
expensive to rediscover.

## One source, two published targets, and a website that is a real repo

`pages/<name>.html` is the content, written once. `build.cjs` emits an
**artifact** (self-contained, fonts inlined) and a **site fragment** (pasted into
a page in `~/opencues-website`, which is its own repo, deployed from `main` via
Cloudflare Pages). The site half is not a nice-to-have: it is where these pages
end up in public, so a change here is only half done until it lands there.

The stylesheet is a **twin**: `theme.css` here, `oc-doc.css` in the website repo.
Same class names, same components; only the tokens and the page shell differ. Add
a component to one and add it to the other, and the same goes for a *fix* — a
behaviour change that lands on one side only becomes "it looks wrong on the site"
weeks later, which is exactly how it has gone wrong before. Edit both in the same
pass, always.

The website repo has its own CLAUDE.md covering the site-side half, the design
rules in their site form, and its shader work.

## The audience decides the writing

These pages teach someone who does not have the source open. No internal
vocabulary: not "the buffer" but "your text"; not "step 6" but "each press moves
it 6 percentage points". Keep it short — a reference page is a page, not a
manual. Never over-claim in a demo: if the animation only climbs to 50%, the
caption cannot say "up to 100%". Check the arithmetic in worked examples; readers
follow those closely. Verify examples against a running host and end the page
with a `.foot` line saying where the content came from. The full rules, with the
table of phrases that had to be rewritten, are in the root `CLAUDE.md`.

## Borrow the site's design system; do not invent one

The kit has no design language of its own. Before choosing a spacing value, a
colour, a radius or a link treatment, open opencues.com and find where it already
solves that problem. The spacer scale is `.6 / 1.2 / 2.2 / 4 / 6 / 8 / 12rem` and
nothing else, the palette is the approved range on `comparison.html`, the only
radii are `0` and `50%`, scrollbars are hidden rather than styled, and downloads
are plain `Download ↓` links. Every rule in REFERENCE.md began as something
invented and then corrected against a real page, so looking first is the cheap
move.

## A phone is a real target

Everything below was found at 390px after the page looked finished on a desktop.
The failures are structural, not cosmetic:

- **`overflow-x:auto` alone does not contain a block.** A `white-space:pre` line
  has no wrap point, so its *minimum* width is the whole line, and that minimum
  travels up the tree. On the site build one terminal line made the centre column
  440px inside a 390px phone and the whole page scrolled sideways with the title
  cut off. `.term` and `.scroll` carry `contain:inline-size`; anything new that
  can be wider than the page needs it too.
- **A gauge's track is a grid column, never a flex child**, or a longer label
  takes the width out of its own bar and no two gauges can be compared.
- **Tables scroll rather than compress**, and mono cells do not wrap: a cell
  depicts a line as typed, and breaking `volume 40 _` over two lines shows the
  reader something the product never produces.

To check, load the page in a **390px iframe** and compare
`documentElement.scrollWidth` against `clientWidth`. Headless Chrome on this
machine will not give a window narrower than about 526px, so `--window-size=390`
silently measures something else.

## Check the exported artefact, not just the page

The PDF and the video are pre-rendered files committed here (`pdf/`, `video/`),
never produced in the reader's browser, and they obey different rules from the
page. **Regenerate both after any content or theme change, then open them.**
Three failures shipped before being caught: an empty hero in the PDF (at t=0 an
animation is a bare caret), table text printing near-black (cells inherited their
colour instead of declaring one), and a CSS transition that never reached a video
frame (frames are captured the instant the animation's callback fires). Measure
colours off the render rather than eyeballing a dark image; `%[fx:mean_r]` is not
valid ImageMagick and silently returns luminance three times, the real symbol is
`%[fx:mean.r]`. Commands and the full trap list: [PIPELINE.md](PIPELINE.md).

Check **one region at a time** — each table, each card, each filmstrip frame.
The errors that survive longest are the ones where most of the page is right.

## Shaders are the website's, not the kit's

The shader ring around the demo is a **live-page effect on opencues.com** and is
deliberately absent here. It lives in `~/opencues-website/shader/` with its own
CLAUDE.md (the known-good configuration, what worked, what did not, and how to
debug a shader that renders nothing, which is the normal and silent failure).

It is not in the artifact or the video because a frame there is captured one
Chrome process at a time against a virtual clock, so the effect can only change
when the demo emits a frame — sporadic flashing rather than motion. The routes
around that were measured and all closed: a persistent browser is unavailable
(WSL cannot reach Windows Chrome's debug port, a Linux Playwright chromium hangs
at launch). If a persistent browser ever becomes available, that is the thing to
fix — not the shader code.
