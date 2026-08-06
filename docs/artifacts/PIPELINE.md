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
