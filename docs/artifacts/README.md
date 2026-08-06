# OpenCues artifact kit

A small, self-contained kit for building **OpenCues-branded HTML pages** — the
design-review / feature-reference pages we publish as claude.ai artifacts (the
kind that explain a feature with live terminal examples, state tables, and a
looping demo).

It exists so those pages look like OpenCues instead of like a generic default,
and so the next one takes minutes instead of an afternoon of re-deriving colours,
fonts, and the two mobile bugs that keep biting.

**It is an override, not a default.** Applying this kit is a deliberate choice
for a page that should carry OpenCues branding. Anything else (a quick throwaway
page, a doc that isn't OpenCues-facing) is fine without it.

---

## What's in here

| File | What it is |
|---|---|
| [`theme.css`](theme.css) | **The theme.** Design tokens (from opencues.com) + every component, heavily commented inline. The reusable core. |
| [`build.cjs`](build.cjs) | **The assembler.** Wraps your page content with the theme and the base64-inlined fonts, producing one self-contained HTML file. |
| [`hero.html`](hero.html) | **The hero animation** (optional). A looping, typed terminal demo for the top of a page. Markup + inline script. |
| [`example-body.html`](example-body.html) | **Kitchen-sink template.** Every component with a doc comment. Copy this to start a page. |
| [`render-pdf.cjs`](render-pdf.cjs) | Renders the page to a PDF (dark ground preserved, sections kept whole). |
| [`render-video.cjs`](render-video.cjs) | Renders the hero to a 16:9 MP4, raw and captioned cuts. |
| [`preview-site.cjs`](preview-site.cjs) | Builds a standalone preview of the SITE target, for review without the site running. |
| [`REFERENCE.md`](REFERENCE.md) | **Full reference** — tokens, every component + its markup, the hero engine, and the gotchas. |

---

## Quick start

```bash
cd docs/artifacts

# 1. Start from the template. Content only — no <!doctype>/<html>/<head>/<style>;
#    everything goes inside a single <div class="wrap">.
cp example-body.html my-page-body.html
#    …write your page…

# 2. Build a self-contained file (theme + fonts inlined).
node build.cjs my-page-body.html my-page.html "My Page Title"

# 3. Publish my-page.html as an artifact (pick a fitting emoji favicon).
```

`build.cjs` reads the fonts from `~/opencues-website/fonts/` — override with
`OC_WEBSITE=/path/to/opencues-website`. It caches the generated `@font-face`
block to `oc-fontface.css` (gitignored) so a rebuild still works if the website
repo isn't checked out.

If your body contains an `<!--HERO-->` marker, `build.cjs` splices `hero.html`
in at that point.

---

## The two pieces

The kit is two independent bits — use the first alone, or both:

1. **The theme** (`theme.css` + `build.cjs`) — the look: OpenCues palette, TWK
   Lausanne + Ufficio Mono, sharp corners, and the component set (terminal
   blocks, cards, tables, badges, gauges, filmstrips, callouts).
2. **The hero animation** (`hero.html`) — an optional looping demo at the top of
   a page: types a command out, shows the result, then steps through states on a
   slow, readable loop.

Both are documented in detail in [`REFERENCE.md`](REFERENCE.md).

---

## Rules that MUST hold

Every one of these broke a real page. They're explained fully in `REFERENCE.md`
and commented at the exact CSS rules in `theme.css`:

1. **Inside a `.term`, put child elements on ONE line** with no whitespace
   between the tags. `.term` uses `white-space:pre`, so a newline between
   `<span class="buf">` and `<span class="note">` renders as literal blank space
   and pushes the note away from the line it annotates.
2. **Grid/flex children need `min-width:0`.** Without it a wide terminal line
   inside a card refuses to shrink and pushes the card past the viewport on
   mobile. `.box`, `.term`, and `.frame .act` all set it.
3. **Anything depicting your text borrows the terminal's colours** — base text
   `--term-fg`, selected text white on the tint, and the highlight on the
   *value* only. This one has broken three times in different components (a
   table highlighting a whole phrase, a cell inheriting the page's brighter
   body colour) because `.term` itself was always right and the copies drifted.
4. **The hero's caption bar is a fixed height.** It contains a keycap on some
   frames and not others, and the hero is vertically centred in the video
   stage, so a taller bar shifts the entire demo. `line-height` must stay above
   the keycap's height — in `theme.css` *and* in the scaled-up stage inside
   `render-video.cjs`.

**Before inventing a value, read the site.** This kit has no design system of
its own; it borrows opencues.com's. Spacing comes from that spacer scale
(`.6 / 1.2 / 2.2 / 4 / 6 / 8 / 12rem`), colour from the approved range on
`comparison.html`, corners are always square, scrollbars are hidden rather than
styled, and downloads are plain `Download ↓` links. Nearly every rule in
`REFERENCE.md` began as something invented and then corrected against a real
page.

---

## PDF and video

Each page can ship a PDF of itself and a 16:9 video of its hero animation. Both
are **pre-rendered files**, not made in the reader's browser, and they are
generated by different mechanisms with different constraints:

```bash
cd docs/artifacts        # paths below are relative to the CURRENT directory
node render-pdf.cjs   pages/<name>.html pdf/<name>.pdf "<Title>"
node render-video.cjs                                    # raw + captioned cuts
```

Regenerate both whenever the content **or the theme** changes — a colour that
only moved in `theme.css` still changes every frame of the video and every page
of the PDF. The rules each must obey (print colours, pagination, why the video
tolerates no CSS transitions) are in [REFERENCE.md](REFERENCE.md) and
[PIPELINE.md](PIPELINE.md).

**Check the output, not the page.** Both formats fail silently and in ways the
browser never shows you: a PDF that printed an empty hero, table text that came
out near-black, a CSS transition that never reached a frame. Open the PDF and
step the video.

## Where the design comes from

`~/opencues-website` — the tokens are lifted from its `style.css` `:root` block
and the fonts from its `fonts/` directory. If the site's palette changes, update
the `:root` block in `theme.css` to match; that's the only place colours live.
