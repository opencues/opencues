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
