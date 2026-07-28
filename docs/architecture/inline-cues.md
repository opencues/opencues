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
| **Managed editor** (claude.ai / ChatGPT / Luma = ProseMirror, Reddit = Lexical, LinkedIn = Quill, Twitter = Draft) | `isManagedEditor` | `'margin'` — open the row with **CSS layout only**. Mid-buffer (caret line has a following sibling to push): an **injected stylesheet rule** `[data-oc-editor] > :nth-child(N) { margin-bottom }`. Last/only line: grow the editor **root** via inline `padding-bottom`. | A style is not document content, so it can never reach the submit buffer (`walkPlainText` reads text, not styles) and creates no editor transaction (no undo entry). The stylesheet rule is used because PM/Lexical/Quill **revert inline styles on child nodes they own** but cannot see or revert an external stylesheet. A real inserted line is refused outright here: we don't own these editors' send button, so it would ship in the user's message. If a given editor still reverts even the style, the row just doesn't open and the note floats — never unsafe. |
| **Normal `<input>` / `<textarea>`** | `isNormalInput` | `'none'` — no push-down; render is skipped entirely (CSS Custom Highlight can't paint an input's internally-laid-out value). | Single-answer blanks still work via `.value` mutation. Cues aren't painted; with a cue advisory the degradation is to the secondary display. |

Gap height on every chrome path is **measured from the note's own rendered
height** (one line in the field's font), not the field's `line-height` — robust
to `line-height: normal` and to a sentence that wraps across visual lines (which
still opens exactly one row). Fallback: field line-height → span rect height →
`1px` floor.

**Debug diagnostic:** with `debug-mode: on`, the managed path logs
`[chrome] marginPush {path, tag, …}` to `/tmp/opencues.log` — `sheet-margin`
(mid-buffer), `root-padding` (last line). If a managed editor reverts the nudge,
it's visible there rather than a silent no-op.

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

- **Managed-editor push-down can be reverted.** The stylesheet-rule / root-padding
  levers are chosen to survive ProseMirror/Lexical/Quill reconciliation, but a
  specific site's editor could still override them; the fallback is a floating
  (occluding) note. This is the surface the user is expected to spot-check per
  editor — the `marginPush` diagnostic is the check.
- **Soft `<br>` line breaks inside one block (non-last line).** Some managed
  editors (e.g. LinkedIn comments) put multiple lines in a SINGLE block
  separated by `<br>`, not sibling blocks. There is no CSS that opens a gap
  between two `<br>` lines mid-block, and inserting a node/content would ship in
  the message — so when the caret is on such a line with another `<br>` line
  below, the note floats (overlaps the next line). The runtime detects this
  (`marginPush path: 'no-safe-push', reason: 'soft-break-midline'`) and declines
  to push rather than mis-grow the editor. The last line of such a block still
  gets `root-padding`. Would need an opaque-note fallback (occlude cleanly) or a
  per-editor API to improve.
- **Multiple overlapping advisories.** v1 reveals the first def whose span
  contains the caret; passive cues rarely overlap. Define precedence (priority?)
  if a real overlap case appears.
- **Chrome normal inputs** get no inline reveal by construction — secondary
  display only.
