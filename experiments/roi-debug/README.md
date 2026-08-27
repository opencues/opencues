# Glimmer — reading-side cues (OpenCues experiment)

> Directory keeps its historical `roi-debug` name until graduation — the
> Chrome mirror path is wired to it. The integration's name is **Glimmer**.

A standalone MV3 extension prototyping the OpenCues reading-ROI concept: a
mid-viewport attention band, LLM "insight" analysis of prose passing through
it, a Zelda-style scramble glimmer on the last visible prose word, and a
hover reveal that boils the paragraph down to the insight — all without ever
destroying the page's own DOM.

## Folder layout

```
manifest.json          extension manifest (paths below)
key.js                 baked dev key — gitignored, never commit
lib/                   standalone modules, one concern each (window.* APIs):
                       scramble, perf, dom-utils, insight-client, concerns
content/               the orchestrator content script + its page CSS
popup/                 the action popup (the ROI debug screen)
icons/                 OpenCues brand icons
```

## Module layout (manifest load order)

| File | Namespace | Owns |
|---|---|---|
| `key.js` (root) | `window.CEREBRAS_KEY` | Baked dev key. **Gitignored — never commit.** |
| `lib/scramble.js` | `window.OcScramble` | The effect primitive: confusable-group `scramble(text, density, rand)`, `boil(el, opts)`, seeded `stream(seed)`. Extracted from the artifact kit; UMD, also loads in Node for tests. |
| `lib/dom-utils.js` | `window.RoiDom` | Pure DOM utilities — target validity (`glimmerableWord`, `inBadAncestor`, `wordVisible`), span wrapping, text-shape capture/paint/restore, box locking. No state, no settings, no timers. |
| `lib/concerns.js` | `window.RoiConcerns` | CUE.md-shaped reading concerns: frontmatter parser (KNOWN_SCOPES forward-compat — unknown `scope:` docs are dropped), `on-site:`/`not-on-site:` matching (wildcards, path prefixes), name-keyed override of built-ins, highest-priority-match selection. The shipped insight-finder is the default doc. |
| `lib/insight-client.js` | `window.RoiInsightClient` | The LLM half — endpoint/model/prompt, serialised request queue (one in flight), 20s timeout, token + cost ledger. `complete(passage) → Promise<string>`, `usage() → {tokIn, tokOut, cost}`. |
| `content/content.js` | (orchestrator) | Everything stateful: settings + panel, site registry, band geometry + spatial index, glimmer/reveal state machine, minimap, boot/teardown. |

Extending:

- **New site** → add a row to `REGISTRY` in `content.js` (container-level
  selector = one candidate per logical block; see the X/Reddit entries).
- **New effect surface** → consume `OcScramble` + `RoiDom.shapeOf`/`paintShape`;
  never write `innerHTML` on page elements (see "non-destructive" below).
- **New LLM task** → add a method beside `complete()` in `insight-client.js`;
  route it through the same `chain` so calls stay serialised.

## Invariants (each one is a fixed bug — keep them)

- **Non-destructive animation.** Every effect writes text-node *values* inside
  the existing tree. No `innerHTML`, no node replacement — page controls
  (LinkedIn's "…more") keep listeners and framework identity.
- **Interactive text is out of bounds.** Words inside `a/button/code/pre/
  role=link|button` are never targets; an `a[href]` *wrapper* disqualifies the
  whole candidate; `role="button"` wrappers don't (LinkedIn shells).
- **The glimmer is gated on the WORD's rect, not the paragraph's**, starts
  only in the core band, and survives in the buffered hysteresis zone.
- **Visibility is clip-chain + occlusion tested** (line-clamp ancestors,
  1px a11y containers, overlay buttons via `elementFromPoint`).
- **Box lock** pins width + height while a glimmer/reveal is live (HN table
  cells resize to content; hover would flicker).
- **Per-frame work scales with the band, not the page**: membership is
  push-based (IntersectionObserver maintains `nearSet`; far elements cost
  zero main-thread work), precise rects + class writes touch only that set,
  minimap marks are throttled and their full-page index is rebuilt only
  while debug UI shows. Never add a per-frame loop over `candidates`.
- **One LLM call in flight**, one call per element per session, prefetch 3
  ahead. LLM output only ever lands via `nodeValue`/`textContent`.

## Dev loop

Source of truth is this directory; Chrome loads the mirror at
`/mnt/c/Users/wilfred/AppData/Local/roi-debug/`. After edits:
`node --check <file> && cp -r manifest.json key.js lib content popup icons /mnt/c/.../roi-debug/`,
then reload at `chrome://extensions` **and refresh the page** (an old
content script can't reach a reloaded extension).
