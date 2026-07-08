---
last_updated: 2026-07-04
---

# Markdown Styling

LLM-origin text (TransformBlank rewrites, FluidBlank fills) may come back
wrapped in inline Markdown — `**bold**`, `*italic*`, `` `code` ``,
`~~strike~~`, `# heading`, `- list item`. Left as-is, the user's buffer
would show literal asterisks and hashes instead of real emphasis. OpenCues
strips those markers before writing to the buffer and re-renders the
same styling natively — ANSI escapes in terminal hosts, real `<b>`/`<i>`/
`<strike>` markup (where the host editor allows it) in chrome. The user
never sees `**wilfred**`; they see **wilfred**, however their host is
capable of showing it.

The feature also has a dedicated entry point on the imperative side:
asking TransformBlank to `make X bold` decorates a named span in place,
without rewriting anything else in the buffer.

Implemented across four small modules in `packages/opencues-runtime/src/modules/`:
`markdown-parse.ts`, `markdown-strip.ts`, `markdown-render.ts`,
`markdown-substitute.ts`, wired into the substitute path in
`packages/opencues-runtime/src/modules/resolver.ts` via
`applyMarkdownAwareSubstitution` / `applyMarkdownAwareSplice`.

---

## Why strip-then-restore, not "leave the markers in"

If the buffer kept literal `**bold**` syntax, two things would go wrong:

1. **The user sees syntax, not styling.** Editors that don't run a
   Markdown renderer over the live buffer (every host OpenCues supports)
   would show the raw asterisks forever — there's no post-hoc rendering
   pass over "what the user typed."
2. **Every subsequent LLM call has to reason about syntax it doesn't need
   to know about.** If a user later asks to "make it caps" on a
   still-marked-up buffer, the model has to both apply the transform AND
   avoid corrupting the `**`/`~~`/`` ` `` markers around unrelated
   spans — pure downside risk for no benefit.

So OpenCues treats Markdown markers as a **write-time-only wire format**:
the LLM may emit them, the runtime strips them immediately and renders
the styling as a host-native visual instead. The buffer itself is always
marker-free plain text.

### The exception — markdown pass-through (`HostAdapter.markdownPassthrough`)

Both arguments above assume the host has *somewhere* to re-render the
styling. A host with **no styling surface** whose current target is a
**markdown-native composer** inverts them: Discord renders `**bold**`
itself at send time, so literal markers in the buffer are the *correct*
content, and stripping destroys the user's requested styling with
nowhere to re-render it. Hosts can therefore implement the optional
`markdownPassthrough?(): boolean` adapter hook (dynamic — re-evaluated
per substitution, like `supportsCycling`): when it returns true, the
write chokepoint (`applyMarkdownAwareSplice`) writes the rewrite
verbatim and emits no `markdown.styled` event. Today's only
implementation is the windows host, which answers per focused app
(daemon env `OPENCUES_MD_PASSTHROUGH_APPS`, default `discord`; Slack is
deliberately excluded because its WYSIWYG composer only interprets
markup typed live — programmatically inserted markers land literal).
Hosts that omit the hook keep the strip+render path unchanged.

---

## The lifecycle

1. **An LLM-backed source (TransformBlank or FluidBlank) returns text**
   that may contain Markdown markers — nothing forces the model to avoid
   emitting them; the fused TransformBlank prompt explicitly asks for them
   when the instruction is a styling request (see below).
2. **`stripMarkdown`** (`markdown-strip.ts`) parses the rewrite line by
   line: heading (`^#{1,6}\s+`) and list (`^[ \t]*([-*+]|\d+\.)\s+`)
   markers at line-start, then an inline scan per line for
   `**bold**` / `~~strike~~` / `` `code` `` / `*italic*` (checked in that
   order so `**bold**` isn't mis-parsed as two adjacent `*italic*` spans).
   It returns the marker-free string plus one `Range[]` per style, **in
   stripped-text coordinates**.
3. **`applyMarkdownAwareSplice`** (`markdown-substitute.ts`) splices the
   stripped text into the live buffer at `[start, end)` (or
   `applyMarkdownAwareSubstitution` replaces the whole buffer), shifts
   every range by the splice offset so they index into the **final
   buffer**, writes the buffer, and — only if the input actually
   contained Markdown (`hadMarkdown`) — emits a `markdown.styled` event
   carrying `{ text, bold, italic, code, strike, heading, list }`.
4. **`MarkdownRender`** (`markdown-render.ts`) listens for
   `markdown.styled`, caches the payload keyed by the written text, and
   on every render tick checks whether the live buffer still starts with
   the cached **styled body** (the prefix up to the end of the last
   styled range — trailing content past that point is not load-bearing,
   so the user can keep typing after a styled substitution without
   invalidating it). While the cache is valid, `compute()` returns the six
   range lists as a `RenderDirectives` object; each host's render pipeline
   turns that into a visual effect.
5. **User edits inside the styled body invalidate the cache** — a
   `onTextChange` handler with `source === 'user'` that no longer matches
   the cached body clears `_cached` to `null`, so a manually-edited word
   stops being (incorrectly) rendered as bold.

Both flavours of the entry point (`applyMarkdownAwareSplice` for
FluidBlank's slot-fill and TransformBlank's bounded-target replace;
`applyMarkdownAwareSubstitution` for TransformBlank's whole-buffer
merge path) funnel through the same strip primitive, so there is one
strip implementation, not two.

---

## Blank-slot suppression

Markdown's single-asterisk italic syntax (`*x*`) can collide with the
runtime's own `_` blank-slot syntax and with underscores users type for
other reasons. Both `parseMarkdown` (display-only parser used for
already-substituted text) and `stripMarkdown` (write-time parser) accept
a `suppressRanges` option — character ranges where an active `_` blank
lives. Any *italic*, code, or strike range that overlaps a suppress range
is dropped; **bold (`**`) is exempt** because a two-character marker
can't collide with a single `_` slot. This is why `volume _` never gets
its underscore accidentally parsed as the start of an italic span.

---

## Per-host rendering

The runtime never renders styling itself — it only exposes six named
range lists (`boldRanges`, `italicRanges`, `codeRanges`, `strikeRanges`,
`headingRanges`, `listRanges`) on `RenderDirectives`
(`packages/opencues-runtime/src/adapter.ts`). Each host turns those into
whatever its render surface supports:

| Host | Mechanism | Notes |
|---|---|---|
| Claude Code, OpenCode, Gemini CLI (terminal) | ANSI escape codes via `applyDirectives` (`packages/opencues-runtime/src/render-directives.ts`) | `bold` → `\x1b[1m`/`\x1b[22m`, `italic` → `\x1b[3m`/`\x1b[23m`, `code` → `\x1b[7m`/`\x1b[27m` (inverse video, since terminals have no reliable monospace-within-monospace signal), `strike` → `\x1b[9m`/`\x1b[29m`, `heading` → `\x1b[1;4m`/`\x1b[22;24m` (bold+underline, so the heading survives even on terminals that render bold subtly), `list` → reuses the dim on/off codes on the range. Ranges are coalesced (overlap-merged) before insertion. |
| OpenCode specifically | OpenTUI extmark styles, registered lazily (`opencuesBootstrap.ts`) | `opencues-bold` (`bold: true`), `opencues-italic` (`italic: true`), `opencues-code` (tinted foreground colour, not inverse), `opencues-strike` (`strikethrough: true`, falling back to `dim: true` if the terminal doesn't expose strikethrough), `opencues-heading` (`bold + underline`), `opencues-list` (dim grey foreground) |
| Gemini CLI | Same `applyDirectives`-shaped clipping, applied per visual line via `decorateLine` | Each Ink-rendered line gets its intersecting ranges clipped and re-offset to line-local coordinates before ANSI insertion |
| Chrome | `document.execCommand('bold' / 'italic' / 'strikethrough')` over a computed `Selection` range, in `applyMarkdownStyling` (`integrations/chrome/src/opencues-bootstrap.ts`) | **Only bold/italic/strike are attempted — code, heading, and list ranges are explicitly skipped on chrome** (`execCommand` has no equivalent, and per-engine wrapping in `<code>`/`<h1>`/`<li>` was judged too editor-specific for a generic implementation). Whether bold/italic/strike actually render depends entirely on the page's editor: reliable on generic contenteditables (Gmail, plain `<div contenteditable>`), best-effort on Lexical (depends on the site's rich-text schema), and typically a silent no-op on ProseMirror/Draft.js sites configured plain-text-only (ChatGPT, claude.ai, ChatGPT-like composers) — see `integrations/chrome/CLAUDE.md` § "Markdown styling — chrome support is hit-and-miss outside Gmail" for the full per-engine matrix. Even when the visual style doesn't land, the strip is still load-bearing: the user never sees literal `**wilfred**`, just `wilfred` without the emphasis. |

Chrome resets the browser's "typing mode" after applying styling
(`document.queryCommandState` + a toggle-off `execCommand`) so that
`execCommand('bold')` over a selection doesn't leave the *next* character
the user types inheriting bold — a documented `execCommand` quirk that
would otherwise silently bold unrelated text.

---

## The `make X bold` instruction path (TransformBlank)

Separately from styling that merely survives an unrelated rewrite,
TransformBlank recognises styling as its own instruction type. The
`MARKDOWN STYLING` rule in `FUSED_SYSTEM`
(`packages/opencues-core/src/sources/transform-blank-source.ts`) fires
when the instruction asks to decorate a named span: "make wilfred bold",
"bold the word X", "italicize Y", "underline Z", "strike through W",
"make X code". The rule is explicit that this is *not* a rewrite:

> you are NOT rewriting or extracting — you wrap that span in markdown
> markers IN PLACE. The named span may appear ANYWHERE in the input —
> including in a sentence BEFORE the instruction, across a period, comma,
> or line break. VERDICT=TRANSFORM; TARGET = the ENTIRE input minus the
> instruction phrase + `_`; FULL_REWRITE = that whole TARGET verbatim,
> byte-for-byte, with ONLY markdown markers added around the named span.

For example, `My name is Wilfred and I work on opencues. make wilfred
bold _` produces `My name is **Wilfred** and I work on opencues.` — the
whole buffer verbatim, with only the named word wrapped. The fused
prompt has a matching `STRUCTURE` rule for the adjacent case of
reshaping (not decorating) the buffer: "turn into a list" → `- ` per
item, "make it a heading" → `# `.

Because TransformBlank runs as a single fused call on every provider (no
separate EXTRACT/APPLY passes since the June 2026 retirement — see
`docs/architecture/transform-blank.md`), the model never emits a
`TARGET` field at all; the runtime always takes the whole-buffer
three-way-merge path (`threeWayMerge` in `resolver.ts`) for this case,
diffing `FULL_REWRITE` against `originalText` and merging into
`liveText`, then routing the merged text through
`applyMarkdownAwareSubstitution` so the resulting `**Wilfred**` still
gets stripped-and-rendered like any other Markdown-bearing rewrite.

A June 2026 bug (documented in `CHANGELOG.md`) had this instruction type
bail to `VERDICT: NONE` whenever the identity-context or blank-context
catalog was injected into the prompt and the named span sat in a prior
sentence across a period — the model treated the first sentence as
out-of-scope. Fixed by making the `MARKDOWN STYLING` rule explicit that
`TARGET` is always the whole input and the model must never bail just
because the span is in an earlier sentence.

---

## Styling survives across a chain of transforms

`MarkdownRender.getCachedPayload()` is also consumed on the *input* side
of the pipeline. `Resolver` (constructor parameter `markdownRender`) uses
the cached payload to build a `richText` view of the current buffer —
the visible (marker-free) text with the cached Markdown markers
re-injected via `injectMarkdownMarkers` — and passes it to the LLM as
`CueContext.richText`. TransformBlank's source prefers this over the
plain visible text (`richText > asTypedText > text` precedence,
`rawExtractText = context.richText ?? context.asTypedText ?? context.text`)
so that a second instruction (e.g. "make it caps" issued after "make
wilfred bold" already landed) sees the prior styling and can choose to
preserve it, rather than getting handed plain text that looks like the
bold never happened. `stripMarkdownMarkers` is run on the extracted
`transformTarget` before locating it in `originalText` via `indexOf`, so
a marked-up target still matches the unmarked visible buffer for the
bounded-splice code path.

---

## Limitations (read from source, not aspirational)

- **No nesting.** Bold-inside-italic, code-inside-bold, etc. are not
  parsed — first match wins; inner candidates fall through as plain
  text (`markdown-parse.ts`'s explicit design choice).
- **No newline-crossing inline spans.** `**bold**`, `*italic*`,
  `` `code` ``, and `~~strike~~` must open and close on the same line;
  a marker pair split across a line break is left as literal text.
  Heading and list detection are line-level only.
- **Chrome renders three of six styles.** Code/heading/list ranges are
  computed identically on every host but are simply not applied to the
  chrome DOM — no `execCommand` equivalent exists, and per-engine
  `<code>`/`<h1>`/`<li>` wrapping was judged too site-specific for a
  generic pass (see the per-host table above).
- **Chrome's bold/italic/strike are best-effort, not guaranteed**, on
  any editor that owns its own schema (Lexical/ProseMirror/Draft.js/Slate)
  — if the site's schema doesn't expose a bold/italic/strike mark, the
  `execCommand` call silently no-ops. There is no per-site override
  today beyond what `integrations/chrome/CLAUDE.md` documents as a
  future site-specific carve-out path.
- **Auto-styling (pick-your-own-spans) is a separate, unimplemented
  feature.** The `MARKDOWN STYLING` rule only fires for a *named* span
  ("make wilfred bold"). Instructions like "add bolding where
  appropriate" or "highlight key terms" — where the model has to choose
  which spans deserve styling — are not handled by this rule and are not
  otherwise wired up; see the note in the report this doc was written
  alongside for the exact stale reference in
  `docs/architecture/transform-blank.md`.
- **Cache invalidation is prefix-based, not span-based.** `MarkdownRender`
  only asks "does the live buffer still start with the styled body?" — it
  doesn't track whether the specific styled *word* survived unedited
  elsewhere in a longer buffer. Editing text well past the styled region
  is safe (doesn't invalidate); editing inside the styled region drops
  the *entire* cached payload, not just the affected range.

---

## Portability

### Standard (opencues-core)

- Nothing in `@opencues/core`'s spec mandates Markdown stripping/
  rendering — this is a `@opencues/runtime` + reference-impl feature,
  not a wire-format concept downstream implementations must support.
- `FUSED_SYSTEM`'s `MARKDOWN STYLING` / `STRUCTURE` rules are reference-
  impl prompt design, not part of the spec (`SPEC_VERSION` unaffected).

### Integration responsibilities

- Construct one shared `MarkdownRender(adapter)` per runtime instance and
  wire it into the `Resolver` constructor's `markdownRender` parameter so
  rich-text re-injection works across transforms.
- Consume the six `RenderDirectives` range fields
  (`boldRanges`/`italicRanges`/`codeRanges`/`strikeRanges`/`headingRanges`/`listRanges`)
  in whatever native styling mechanism the host exposes; a host that
  can't render a given style (chrome + code/heading/list) may simply
  drop that range — the buffer is already marker-free either way, so
  dropping a directive degrades to "plain text," never to garbled
  syntax.
- Reset any "typing mode" side effect a native styling API may leave
  behind after applying a range (chrome's `execCommand` toggle-reset is
  the concrete example) so the next character the user types doesn't
  inherit unintended formatting.
- Call `MarkdownRender.resetState()` as part of any full runtime reset
  (session boundary, buffer swap) — a stale cache would otherwise
  re-inject rich-text markers into a new buffer's first LLM call.

---

## See also

- `packages/opencues-runtime/src/modules/markdown-parse.ts` — display-only parser for already-rendered text (six range types, blank-slot suppression)
- `packages/opencues-runtime/src/modules/markdown-strip.ts` — write-time strip + per-style range extraction
- `packages/opencues-runtime/src/modules/markdown-render.ts` — event-driven cache + `RenderDirectives` computation
- `packages/opencues-runtime/src/modules/markdown-substitute.ts` — `applyMarkdownAwareSplice` / `applyMarkdownAwareSubstitution`, the two write-path entry points
- `packages/opencues-runtime/src/modules/resolver.ts` — `richText` construction, `injectMarkdownMarkers`, `stripMarkdownMarkers`, the bounded-splice vs whole-buffer-merge branch
- `packages/opencues-runtime/src/render-directives.ts` — ANSI escape codes for terminal hosts
- `packages/opencues-core/src/sources/transform-blank-source.ts` — `MARKDOWN STYLING` / `STRUCTURE` rules in `FUSED_SYSTEM`
- `integrations/chrome/src/opencues-bootstrap.ts` — `applyMarkdownStyling`, `selectPlainRange`
- `integrations/chrome/CLAUDE.md` § "Markdown styling — chrome support is hit-and-miss outside Gmail" — full per-engine support matrix
- `integrations/opencode/patches/opencuesBootstrap.ts` — OpenTUI extmark style registration
- `docs/architecture/transform-blank.md` — the fused TransformBlank pipeline this feature's imperative path rides on
- `CHANGELOG.md` — `feat(markdown): inline styling end-to-end + transform-blank refactor` (initial ship) and the June 2026 catalog-injection bug fix for `make X bold` with a prior sentence
