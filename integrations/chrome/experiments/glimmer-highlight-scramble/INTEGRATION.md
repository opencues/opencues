# Integrating highlight-glimmer into the chrome extension

The plan for replacing glimmer real-write mode (disabled after the
Gmail freeze) with the Highlight API engine in `highlight-glimmer.js`.
This is a PLAN — none of the wiring below has been done yet. The API
itself is proven (see NOTES.md + the api-test run: multi-text-node
targets, concurrent namespaced instances, clean destroy).

## Why this fixes the original problem, structurally

Real-write mode wrote the scrambled text into the field every 70ms tick
through the full edit pathway — O(field length) DOM walking per tick,
which froze Gmail on long reply chains, fought managed-editor
reconcilers, and risked the undo stack. The highlight engine writes
NOTHING to the text DOM: it moves Ranges between `Highlight` sets and
flips stylesheet values. Managed editors (Lexical / ProseMirror / Quill
/ Draft.js) cannot see it, revert it, or record it — their
MutationObservers watch the DOM tree, and the tree never changes.
Cost is O(animated span), never O(field).

## The seam: a host-animation escape hatch on GlimmerRender

`packages/opencues-runtime/src/modules/glimmer-render.ts` currently has
two delivery modes: `RenderDirectives.textOverride` (CC consumes it) and
`realWrite` via `adapter.setText` (OC / shell; chrome's is disabled).
Add a third, taking priority when present:

```ts
// GlimmerRenderOptions
playHostAnimation?: (spec: {
  startOffset: number;   // plain-text coords of the animated span
  endOffset: number;
  durationMs: number;
  mode: 'appear' | 'sweep';
}) => { cancel(): void };
```

When the option is provided, `start()` calls it once and skips the
`_tick` loop entirely — no per-tick scramble text generation, no
setText, no render kicks. `stop()` / user-edit paths call the returned
`cancel()`. The runtime stays host-agnostic: it knows nothing about
`Highlight`, only that the host owns the animation.

Plumbing: `BuildSharedRuntimeOptions` (boot-common) carries it,
`adapters/chrome/v1/boot.ts` forwards `bindings.playGlimmer` from the
bootstrap. Every other host passes nothing and keeps today's behavior
byte-for-byte.

> ⚠ Overlap warning: the uncommitted Phase A work on
> `feat/glimmer-transition` (a `frameMs` cadence override threaded
> through the same three files) targets the same territory via a
> different strategy (make real-write cheaper). Landing this seam
> supersedes it for chrome — decide its fate (keep for OC/shell, or
> drop) in the same PR rather than letting both drift.

## Chrome-side wiring (`integrations/chrome/src/`)

1. Port `highlight-glimmer.js` to `src/highlight-glimmer.ts` (mechanical
   — the module has zero deps).
2. In `opencues-bootstrap.ts`, implement the binding:
   - **Span → Range translation must use the existing dom-walk, not the
     API's own TreeWalker.** The runtime speaks plain-text offsets, and
     `plainOffsetOfPosition` / `domPositionOfPlainOffset` already handle
     the emoji-as-`<img>` synthetic segments (`alt` text counted as
     characters with no text node behind them). Build the DOM Range for
     `[startOffset, endOffset]` with those helpers, then hand the Range
     to `createHighlightGlimmer`. Chars backed by an `<img>` segment
     have no text node, so the engine's walker skips them — the glyph
     simply doesn't scramble, which is the correct degradation.
   - One instance per animation; `destroy()` (not just cancel) when it
     ends — instances are cheap and per-animation lifetime avoids stale
     Ranges outliving edits.
3. **Cancel triggers are mandatory, not polish.** Ranges over mutated
   text are meaningless; the animation must never outlive the text it
   was built against. Call `cancel()` from: `notifyOpenCuesTextChange`
   (any text change while animating), focus change (`publishTarget`),
   blur/detach, and before starting any runtime write
   (`replaceAllText` / `applyTextDiff` / cycling `setText`).
4. **Shadow DOM (Reddit `<reddit-rte>`)**: `::highlight()` rules only
   reach ranges in their own tree scope. The engine's `styleParent`
   option exists for this — pass the shadow root (from
   `shadow-focus.ts`'s resolution) when the attach target lives in one.
   Untested; verify on Reddit before calling the site supported.
5. **Feature gate + fallbacks**:
   - `supportsHighlightGlimmer()` false → no animation at all (text
     just appears). NEVER fall back to real-write; that path stays
     disabled on chrome.
   - Normal `<input>` / `<textarea>` (universal profile): their value
     isn't DOM text nodes, so the Highlight API structurally cannot
     reach it. Glimmer stays off there, same as today.
   - Sensitive fields never attach in the first place — no new surface.
6. **Security notes**: no new inputs, no network, no exec, no synthetic
   input events (so no trust-gate / sourceReclassifier interaction — the
   engine never fires events the gate would see). CSP-clean (no
   workers, no blob URLs, no eval). The one new writable surface is
   `CSS.highlights`, namespaced per instance and fully removed on
   destroy.

## What to reuse from the tuned recipe

The API defaults ARE the recipe picked in the bench (80% active, 60%
re-roll, single-line mixed decorations at 30% on swapped chars, tail
scrambling, 900ms appear-fwd). The bootstrap should pass only
`{ mode, durationMs }` from the runtime spec and take the rest as
defaults, so future tuning is one file.

Config surface (later, not v1): a `glimmer-transition-ms` tunable
(300/600/900) belongs in `MENU_TUNABLES` in the feature registry —
one-PR pattern per `docs/architecture/feature-registry.md`. v1 can
hardcode 900ms.

## Test plan

- Unit (jsdom won't do — Highlight API needs real Chromium): extend the
  chrome E2E suite (`tests/e2e/`) with a glimmer scenario: trigger a
  substitution on the harness page, assert `oc-glimmer-*` names appear
  in `CSS.highlights` during the transition and the registry is empty
  after + the buffer text equals the final substitution (the animation
  must not alter text).
- The regression that matters: a LONG field (the Gmail shape). E2E page
  with ~10KB of content, animate a 10-word span, assert tick cost
  stays flat vs a 100-byte field. That pins the O(span)-not-O(field)
  contract that real-write violated.
- Manual matrix (per chrome CLAUDE.md discipline): Gmail (the incident
  site) first, then Reddit (shadow DOM + Lexical), ChatGPT/claude.ai
  (ProseMirror), LinkedIn (Quill), Twitter (Draft.js). For each: play,
  type mid-animation (cancel path), Ctrl+Z after (undo stack untouched).

## Ship checklist (repo discipline)

- Branch + PR (never direct to master). Suggest continuing on
  `feat/glimmer-transition` since PR #421 owns the glimmer story.
- Runtime seam touched → `@opencues/runtime` version bump + CHANGELOG
  entry; chrome touched → `manifest.json` AND `package.json` lockstep
  bump.
- `bash scripts/pre-pr.sh` (includes the chrome bundle-artifact gate —
  the new TS module must survive esbuild; it has no node imports so it
  should be clean).
- Chrome E2E run (not in CI — manual discipline): `cd
  integrations/chrome && npm run build && npm run test:e2e:chrome`.
- Upgrade path for users: rebuild runtime → rebuild chrome → `opencues
  sync chrome` (WSL → /mnt/c) → reload extension. Existing srcHash
  drift detection covers the runtime half automatically; the chrome
  dist sync remains the manual step it always was.
