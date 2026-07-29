# Inline cues — design + per-integration implementation

> **Status: built on branch `feat/inline-cues`, live on all five host bands**
> (CC, OpenCode, Gemini CLI, shell, chrome). Not spec-affecting — it rides the
> existing `RenderDirectives` channel. Gated by `inline-cues-mode` (default
> `inline`; `secondary` degrades to the status line).
>
> **Companion:** [`inline-cue-cycle.md`](inline-cue-cycle.md) — pressing `_`
> inside a painted note rotates the cue (a discoverable complement to
> `Ctrl+Alt+arrow`). Gated on the note being painted; that doc holds the cycle
> semantics.

## The idea

A passive cue's advisory (`def.cueTip` — a sentence-cue's calendar-conflict
heads-up, a contradiction cue's weekday-date mismatch) reveals **inline** — gray
text on a line directly below the flagged span — the moment the text caret
enters that span, and vanishes when it leaves or the text is edited. The
always-dimmed span is the persistent "there's more here" indicator; the reveal
is the content. This is the "Error Lens" interaction.

Two visible parts, both display-only (never in the submit buffer):

- **Indicator (always on):** the flagged span is dimmed. Pure styling of buffer
  characters via `RenderDirectives.dimRanges` — works on every host that can
  paint dim.
- **Reveal (cursor-gated):** the advisory (`↳ <note>`) is shown on its own line
  below the span, **pushing the content below it DOWN** so it never occludes the
  next line — the Claude Code behaviour, matched on every host it's mechanically
  possible on.

## Runtime contract (host-agnostic)

The runtime does not paint. It emits **one directive** and every host renders it
in whatever way its surface allows:

- **`RenderDirectives.inlineNote?: { spanStart, spanEnd, text }`** (`adapter.ts`)
  — spans in the host's painted (`ctx.text`) coordinate space.
- **`DimRender.compute`** (`dim-render.ts`) emits `inlineNote` only when
  `inline-cues-mode: inline`, the host advertises the `inline-note` capability,
  and `ctx.cursor` sits inside a **live passive-cue def** (a def with `cueTip`
  passing the staleness guard). The span is mapped logical→painted before the
  containment test so soft-wrap hosts test the caret in the right space.
- **Cursor-gating is the safety property.** The note is emitted only while the
  caret is in the span, so it can't be present at submit time. Combined with
  display-only rendering, the advisory can never reach `ctx.text` (the submit
  buffer).
- **Shared render helpers** (`render-directives.ts`), used by *every* host so the
  note reads identically everywhere:
  - `inlineNoteDisplayText(cueTip)` → the `↳ <note>` string (connector + text).
  - `inlineNoteBoxColumn(text, spanStart)` → the column (in cells) to hang the
    connector under, CJK-cell-aware.
- **`inline-cues-mode`** — FEATURES registry entry + typed `OpenCuesState`
  (`inlineCuesMode: 'inline' | 'secondary'`, default `inline`). In `secondary`,
  `Statusline.buildPayload` keeps the status-line copy of `def.cueTip`; in
  `inline` on a paint-capable host it suppresses that copy (no double display).

## What gets a note vs. just dim

Two layers, and they're not the same set. **Dim** ("there's more here") is
painted on *any* span with something to cycle or reveal. The **inline note**
(`↳ …`) is the cursor-gated reveal, and only a subset of dimmed spans are
**note-bearing**.

The single decider is **`inlineNoteText(def)`** (`state/dyn-defs.ts`) — the
shared source of truth used by BOTH `DimRender` (paints the note) and `Cycling`
(the `_`-step), so they can never disagree on "has a note":

```
def.cueTip present         → note = cueTip       (an advisory)
transform-blank, >1 alt    → note = "transform"  (walkable edit history)
fluid-blank, >1 alt        → note = "lookup"     (walkable history)
plain word-cue, >1 alt     → note = suggestions  (alternatives[1..] joined — incl. spelling)
otherwise                  → undefined           (dim only, no note)
```

| Span type | Produced by / config | Dimmed? | Inline note? | Note text |
|---|---|---|---|---|
| **Word-cue** (incl. spelling) | `### alternatives` / spelling sources | ✅ | ✅ | its **suggestions** — `alternatives[1..]` (e.g. `receive`, or `lawyer · counsel`) |
| **Sentence-cue** | `scope: sentence` cue + `sentence-cues-mode: on` | ✅ | ✅ | `cueTip` — the cue's advisory (e.g. `more-formal`) |
| **Contradiction-cue** | `contradiction-cues-mode: on` | ✅ | ✅ | `cueTip` — the computed correction |
| **Transform-blank** (after a rewrite, >1 alt) | `<body> fix typos _` | ✅ | ✅ | `transform` (its edit history) |
| **Fluid-blank** (after a lookup, >1 alt) | `weather in paris _` | ✅ | ✅ | `lookup` (its history) |
| **List / script blank, selector-satellite** | blanks | ✅ | ❌ (follow-up) | — (value's in the buffer; these are `SpanFillState`/`SelectorSatelliteState`, not DynDefs, so the note loop doesn't reach them) |

So the rule is: **anything whose useful reveal is otherwise hidden gets a note** —
passive cues show their advisory (`cueTip`, set at DynDef registration in
`resolver.ts`), `_`-blanks show their history, and **word-cues (including
spelling) show their suggestions** — the alternatives the resolver already
registered on the def, read straight off it (no fetch, no separate tip channel).
The lone gap is filled list/script blanks + selector-satellite: their value is
already visible in the buffer and they live in different state objects the note
loop doesn't iterate — a deliberate follow-up, not a missing reveal.

**All of these must hold for the note to actually show** (`dim-render.ts`):
1. `inline-cues-mode: inline` (default) — `secondary` sends the same advisory to
   the status line instead.
2. Host advertises the `inline-note` capability — else it falls back to the
   status line (no half-state where the span auto-selects but no note appears).
3. Caret is inside the span (`ctx.cursor ∈ [spanStart, spanEnd]`) — cursor-gated.
4. The span is still live (`defSpanLive` — buffer text at the span still matches
   the def's current alt; stale spans are skipped).

The **dim** layer has its own two gates: the host can paint dim (`dim-ranges`
capability), and `supportsCycling()` isn't `false` (on a no-cycling field — a
chrome plain `<input>` — cue-map dims are suppressed so dim never falsely
advertises cyclability).

> **Note text is still placeholder for `_` blanks.** `inlineNoteText` returns the
> literal `"transform"` / `"lookup"` for history-bearing blanks (the indicator
> text/style was deliberately deferred). Sentence/contradiction cues show a real
> advisory. Improving the blank labels is an isolated change in that one function.

## The hard part — a real pushed-down line, not an overlay

`dimRanges` / `highlight` can only **style existing buffer characters**; they
can't *inject* text. Showing a line that isn't in the buffer — and having the
content below it move down rather than be covered — is a different capability on
every surface. Getting "one line opens below the span, content shifts down,
never reaches the submit buffer" identical across five hosts was the bulk of the
work. Each host's mechanism, and *why* it can't just reuse the previous one:

| Host | Surface | Push-down mechanism | Why not the others |
|---|---|---|---|
| **Claude Code** | native binary, host owns the painted string | `applyDirectives` splices `\n\x1b[2m↳ …\x1b[22m` into the **rendered string** after the body. The host re-lays-out and the input grows by a row. | The host hands the runtime the full painted string, so appending a display-only line is trivial and native. This is the **reference**. |
| **OpenCode** | OpenTUI + SolidJS, textarea is one native renderable | The note is a **flow `<text>` sibling** rendered after the textarea, driven by the `opencuesInlineNote` Solid signal (content-sized, grows the input by a row). | OpenTUI draws the textarea's buffer lines monolithically in a Zig/FFI layer — no per-line element and no display-line primitive to splice into. A sibling flow element is the SolidJS-native way to reserve the row. |
| **shell** (`oc-edit`) | OpenTUI + SolidJS, **we own the whole app incl. submit** | **Buffer injection**: a `\n` + non-breaking-space marker (`INJ_MARK`, ` `) is spliced into the textarea buffer at the span's line end to open a *real* blank row; the note text paints as an absolute overlay box in it. The marker is stripped from every read / cursor / write / **submit** path (`getText`/`getCursor`/`getCleanBufferText`). | Same OpenTUI constraint as OpenCode, but shell owns its submit path, so it can safely inject into the buffer and guarantee the marker never ships. (A `\n`-only line was tried first — the auto-select highlight spilled onto the next visible cell; NBSP gives the injected line a real cell so the boundary lands on it.) |
| **Gemini CLI** | React / Ink, virtualized line list with `fixedItemHeight` | A dedicated **`opencuesNote` item** is appended to `scrollableData`; the list height (`Math.min(viewportHeight, scrollableData.length)`) grows by one. `getOpencuesInlineNote(text, cursor)` (→ `BootResult.getInlineNote`) formats it. | Each visual line is a fixed-height (1-row) `<Box height={1}>`, so a line **cannot grow to two rows** — an embedded `\n` clips. The note has to be its OWN list item. |
| **chrome** | DOM contenteditable / input, no host render loop | The note is a `position: fixed` overlay `<div>` anchored at the span's `rect.bottom`. Push-down is surface-specific (see next section). | CSS Custom Highlight styles ranges but can't add text; a real DOM node is reverted by managed editors and can leak into submit. So the note is an overlay and the *room* for it is opened by whichever push-down the surface allows. |

## Chrome push-down — three surfaces, three safe levers

Chrome is the one host with no render loop of its own, and its surfaces differ
enough that the push-down forks. The governing rule: **never open the row in a
way that could reach the submitted text or fight the editor's reconciler.** The
mode is chosen in `opencues-bootstrap.ts`'s `runtimeRender` and passed to
`applyDirectives(target, directives, pushMode)` as `'node' | 'margin' | 'none'`.

| Surface | Detect | Push-down | Safety |
|---|---|---|---|
| **Plain contenteditable** (Gmail, YouTube) | `!isManagedEditor` | `'node'` — insert an empty `contenteditable=false` **spacer block** (`data-oc-note-spacer`) right after the span's line so content below moves down. | The spacer carries no text and `walkPlainText` skips it by attribute, so it can't reach the submit buffer or shift offsets. Two DOM shapes handled: a per-line block → insert after it; a first line that's bare text in the root (Gmail/YouTube shape) → anchor to the line's terminating `<br>` / next block (`firstLineBreakAfter`). |
| **Managed editor** (claude.ai / ChatGPT = ProseMirror, Reddit = Lexical, LinkedIn = Quill, Twitter = Draft) | `isManagedEditor` | `'margin'` — open the row with **CSS layout only** (never a DOM node — managed editors revert those and they can ship). Three sub-strategies below. | A style is not document content, so it can never reach the submit buffer (`walkPlainText` reads text, not styles) and creates no editor transaction (no undo entry). |
| **Normal `<input>` / `<textarea>`** | `isNormalInput` | `'none'` — no push-down; render is skipped entirely (CSS Custom Highlight can't paint an input's internally-laid-out value). | Single-answer blanks still work via `.value` mutation. Cues aren't painted; with a cue advisory the degradation is to the secondary display. |

### The `'margin'` path's three sub-strategies (`insertMarginPush`)

Picked by what's below the caret's line. All CSS-only — no DOM node — because
PM/Lexical/Quill **revert inline styles on child nodes they own AND revert
inserted nodes**, but cannot see or revert an *external stylesheet* or a style on
their *own root*.

1. **`sheet-margin` — mid-buffer** (caret's line has a following sibling block
   to push). An injected **stylesheet rule** gives that block `margin-bottom`.
   The block is found by walking up to the first ancestor **with a following
   sibling** (`lineBlockWithSibling` — Draft.js nests each line several divs
   deep, so the nearest block is a sibling-less wrapper; the real line block is
   higher up), and targeted by a **full `:nth-child` path from the editor root**
   (`nthChildPathFrom` — the root carries `data-oc-editor`, nothing is marked on
   a node the editor manages).
2. **`root-padding` — last / only line.** Grow the editor **root** via inline
   `padding-bottom`, **additively**: existing computed padding + one line
   (ChatGPT's ProseMirror ships ~16px of its own; replacing it opened <1 line).
   `clearPushDown()` restores the base padding before the computed read, so it
   doesn't compound.
3. **opaque cover — soft `<br>` line that can't be pushed.** Some managed
   editors (LinkedIn **comments**) separate lines with a soft `<br>` inside one
   block. Verified there is *no* safe push here — Chrome's LayoutBR ignores
   `display`/`height`/`margin` so CSS can't box a `<br>`; a spacer node is
   reconciled away by Quill (and resets the caret); and Quill's instance/API is
   unreachable (`__quill` absent, no global `Quill`). So the note instead renders
   as an **opaque cover**: the field's background colour (nearest non-transparent
   ancestor bg, white fallback), one line tall, extended a few px left+bottom to
   catch glyph bleed, opacity 1 — it cleanly *replaces* the line below while the
   caret is in the span, and (cursor-gated) that line reappears the instant the
   caret leaves.

**Caret-unreadable suppression.** When the editor exposes no browser-readable
caret (LinkedIn **Posts** — a fully-controlled Quill that parks
`window.getSelection()` at the app root and hides its instance), `readCursorOffset`
returns a fabricated `0`; `runtimeRender` detects this via `lastCursorReliable()`
and **strips the inline note + auto-select highlight** so they don't fire at the
bogus position. The always-on dim still marks the span.

Gap height on every chrome path is **measured from the note's own rendered
height** (one line in the field's font), reset to natural size *before* measuring
so an explicit cover/gap height can't compound. Robust to `line-height: normal`
and wrapped sentences. Fallback: field line-height → span rect height → `1px`.

### Verified per editor (July 2026)

| Editor | Engine | Behaviour |
|---|---|---|
| **Gmail, YouTube** | plain CE | ✅ real push-down (spacer node) |
| **claude.ai, ChatGPT** | ProseMirror | ✅ real push-down (`sheet-margin` mid, additive `root-padding` last) |
| **Twitter / X** | Draft.js (nested) | ✅ real push-down (`sheet-margin`, up-walk + nth-child path) |
| **LinkedIn comments — block lines** | Quill | ✅ real push-down (`sheet-margin` / `root-padding`) |
| **LinkedIn comments — soft `<br>` lines** | Quill | ✅ opaque cover (no safe push — see sub-strategy 3) |
| **LinkedIn Posts** | Quill (controlled) | ⚠ note + auto-select suppressed (no readable caret); dim only |
| **Reddit** | Lexical | ✅ opaque cover over the line below when one exists (same as LinkedIn `<br>` comments) |
| **normal `<input>` / `<textarea>`** | — | render skipped (secondary display) |

> The per-tick debug diagnostics that drove this whole investigation
> (`[chrome] marginPush` / `cursorReadFallback` / `cursorQuillNative`) were
> **removed** once every editor was verified — they'd served their purpose and
> cost a hot-path branch per render. The findings they surfaced are captured in
> **Implementation notes** below so we don't have to re-discover them. If a new
> editor misbehaves, re-add a throttled `log.debug` at `insertMarginPush`'s
> return points and at `readCursorOffset`'s fallback — that's exactly how each
> case here was cracked.

## Implementation notes — chrome gotchas (for our future selves)

Everything in the chrome push-down is shaped by hard-won constraints. Read these
before "simplifying" any of it — each was a real bug.

1. **Managed editors revert BOTH inserted DOM nodes AND inline styles on their
   own nodes**, and doing either **resets the caret** (their reconciler re-syncs
   selection from the model). That's why the margin path is CSS-only via an
   *external stylesheet* (unobservable to their MutationObserver) and only touches
   the editor's *own root* (which PM doesn't reconcile). A spacer `<br>`/`<span>`
   node *did* render on Quill but reset the caret every tick — abandoned.

2. **A stylesheet rule can't put an attribute on a node the editor manages** —
   Quill/PM may strip it. Mark the STABLE editor root with `data-oc-editor` and
   reach the target block by a full `:nth-child` path from it (`nthChildPathFrom`).

3. **Draft.js nests each line several `<div>`s deep.** The *nearest* block to the
   caret is a sibling-less inner wrapper — margin on it does nothing. Walk UP to
   the first ancestor that *has a following sibling* (`lineBlockWithSibling`) —
   that's the real line block whose sibling is the next line.

4. **A bottom margin on the LAST child is swallowed** (doesn't grow the parent).
   So the sibling-margin path only applies mid-buffer; the last/only line grows
   the editor root's `padding-bottom` instead.

5. **`padding-bottom` must be ADDITIVE.** ChatGPT's ProseMirror ships ~16px of its
   own bottom padding; replacing it with one line grew the box <1 line. Read the
   computed padding and add a line. `clearPushDown()` restores the base first, so
   `getComputedStyle` reads the editor's own value, not our prior nudge (else it
   compounds).

6. **Measuring the note's height to size a cover COMPOUNDS** if you've already set
   an explicit height on it — next tick measures the inflated value and adds
   again (the "cover grew to 2×" bug). Reset the note to natural size *before*
   measuring.

7. **Chrome's `<br>` (LayoutBR) ignores `display`/`height`/`margin`.** There is no
   CSS that opens a gap at a `<br>`. Combined with (1), soft-`<br>` lines
   (LinkedIn comments, Reddit) genuinely cannot be pushed — hence the **opaque
   cover**: paint the note over the line below with the field's own background
   colour (nearest non-transparent ancestor; walk up), one line tall, +3px
   left/bottom to catch glyph bleed. Cursor-gated, so the covered line returns
   when the caret leaves.

8. **LinkedIn hides its Quill.** No `__quill` on the container, no global `Quill`,
   so `Quill.find` is unavailable — the editor's API can't be used to insert a
   cooperative line. Verified on both comments and Posts.

9. **LinkedIn Posts is fully controlled** — it never surfaces a browser-readable
   caret: `window.getSelection()` parks at `<div id="root">` (the app root,
   outside any contenteditable). So `readCursorOffset` returns a fabricated `0`,
   and the cursor-gated note would fire everywhere. `lastCursorReliable()` gates
   this: on a fabricated read, `runtimeRender` strips the note + auto-select (dim
   stays). Comments DO surface a caret, so they're unaffected.

10. **Quill parks the browser selection outside `.ql-editor` between events** even
    on the editors that work. `readCursorOffset` falls back to Quill's own
    `getSelection().index` (when the instance is reachable) or the last cached
    valid offset — see `_lastValidCursor` / `cacheValidCursor`.

11. **Safe-by-construction submit guarantee.** The note NEVER enters submitted
    text: node spacers carry `data-oc-note-spacer` (stripped by `walkPlainText`);
    styles aren't content; real content insertion is refused on editors whose
    send button we don't own. If you add a new push mechanism, preserve this.

## Cross-host consistency contract

- **Same text everywhere:** `↳ <note>` via `inlineNoteDisplayText`; same column
  alignment via `inlineNoteBoxColumn`.
- **Same trigger everywhere:** cursor-gated by the runtime, not the host — the
  note emits only while the caret is in the span, and clears on caret move
  (including vertical moves the host doesn't surface as cursor events — hosts
  re-render after non-consumed cursor keys) or on edit.
- **Same submit guarantee everywhere:** the note is never in `ctx.text`. Terminal
  = display-only splice; OpenTUI/Gemini = a separate renderable; shell = injected
  marker stripped on submit; chrome = overlay + layout-only push-down.

## Known limits

- **Soft `<br>` lines get an opaque cover, not a real push-down.** When a managed
  editor separates lines with a `<br>` inside one block (LinkedIn comments), there
  is no safe way to open a real gap (see `'margin'` sub-strategy 3), so the note
  *covers* the line below instead of pushing it down. It's clean (no overlap) and
  cursor-gated, but the line below is momentarily hidden rather than moved. The
  cover's background is the nearest solid ancestor colour — if a site's field bg
  is an unusual gradient/image, the match can be imperfect.
- **Fully-controlled editors get no note.** An editor that exposes no
  browser-readable caret and hides its instance/API (LinkedIn Posts) can't be
  cursor-tracked, so the note + auto-select are suppressed there (dim only). Not
  fixable without the editor's cooperation.
- **Managed-editor styles could still be reverted per-site.** The stylesheet-rule
  / root-padding levers are chosen to survive PM/Lexical/Quill reconciliation and
  are verified on the editors in the matrix above, but a new site could override
  them; the `marginPush` diagnostic is the per-editor check.
- **Multiple overlapping advisories.** v1 reveals the first def whose span
  contains the caret; passive cues rarely overlap. Define precedence (priority?)
  if a real overlap case appears.
- **Chrome normal inputs** get no inline reveal by construction — secondary
  display only.
