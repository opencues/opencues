# CLAUDE.md — Chrome integration

This document captures hard-won knowledge for the chrome extension that
isn't obvious from the code alone. Read this before changing anything in
`opencues-bootstrap.ts`'s write paths.

## Verified working sites (May 2026)

| Site | Engine | Path used |
|---|---|---|
| Gmail compose | generic contenteditable | `execCommand('delete')` + paste with `<br>`-joined HTML |
| Reddit | Lexical | editor API or keyboard sim + paste with `<p>` HTML |
| Twitter/X | Draft.js | keyboard sim + paste with `text/plain` |
| LinkedIn | ProseMirror | `execCommand('insertText')` |
| ChatGPT | ProseMirror | `execCommand('insertText')` |
| claude.ai | ProseMirror | `execCommand('insertText')` |
| Luma | ProseMirror (outlier) | keyboard sim + paste with `<p>` HTML |
| YouTube comments | generic contenteditable | `execCommand('delete')` + paste with `<br>`-joined HTML |

If you regress one of these while fixing another, that's a structural
problem with the change. Re-verify the full matrix after every write-path
edit, not just the site you're targeting.

## The biggest issue: writing into managed contenteditables

Most modern web apps use a managed-editor framework (Lexical, ProseMirror/
TipTap, Slate, Draft.js) that owns the contenteditable as a React-style
surface. Their model is the source of truth; the DOM is just rendered
output; their MutationObservers REVERT direct DOM mutations that don't
match expected shape; their selection models DON'T sync from
`window.getSelection()` set by us.

There is no universal programmatic write strategy that works across all
of them — each engine and even each app has its own quirks. The chrome
adapter's write paths in `replaceAllText` and `applyTextDiff` (in
`src/opencues-bootstrap.ts`) implement a per-editor ladder discovered by
trial and error. Don't unify it without testing every entry below.

### The matrix (current state)

| Engine | Sites | Write path | Why this and not others |
|---|---|---|---|
| **Lexical** | Reddit | `__lexicalEditor.update($getRoot().clear())` (or keyboard sim Ctrl+A + Backspace fallback) → synthetic `paste` event with `<p>`-per-paragraph HTML in DataTransfer | Lexical's selection model doesn't sync from browser selection. Direct DOM mutations get reverted. Only its editor API or keydown-pipeline events are honored. Paste handler accepts text/html when paragraph blocks match the `<p><span data-lexical-text>` shape Lexical builds natively. |
| **Draft.js** | Twitter/X | Keyboard sim Ctrl+A + Backspace → synthetic `paste` event with `text/plain` (NOT html) | Draft.js's keydown pipeline accepts synthetic Ctrl+A and Backspace. Its `onPaste` handler reads `e.clipboardData.getData('text')` only — html paste gets rejected. |
| **ProseMirror/TipTap default** | LinkedIn, ChatGPT, claude.ai, and presumably most ProseMirror sites | `execCommand('insertText', false, text)` (text passed as-is) | These all reject programmatic paste events outright (paste filters / sanitization extensions). insertText routes through ProseMirror's plain-text-insertion command, which the paste filter doesn't intercept. With selection set to all (via `selectNodeContents` at top of `replaceAllText`), insertText replaces. Browser dispatches `inputType: insertParagraph` for each `\n`; LLM `\n\n` produces one paragraph break (web convention). |
| **ProseMirror/TipTap exception** | Luma | Keyboard sim Ctrl+A + Backspace → synthetic `paste` event with `<p>`-per-paragraph HTML | Luma's TipTap config maps EACH `\n` (in insertText) to a hard paragraph break, so LLM `\n\n` becomes double-spacing. Their paste handler accepts the `<p>` HTML cleanly with correct single-paragraph spacing. |
| **Generic contenteditable** | Gmail, plain `<div contenteditable>` | `execCommand('delete')` → synthetic `paste` event with `<br>`-joined HTML | Gmail's own Enter-key emits `<br>` per line, and its paste handler honors `<br>`-separated content. `<p>` per line would inherit extra paragraph margins. |

### Key learnings (do not re-discover)

1. **`document.execCommand('delete')` is a no-op on managed editors.** Their
   beforeinput handlers read INTERNAL selection, which doesn't sync from
   browser selection. The visible-only DOM clear (`removeChild`,
   `innerHTML=''`, `textContent=''`) gets REVERTED by the editor's
   reconciler within milliseconds. Either use the editor's own API or
   simulate keyboard events that route through the editor's keydown
   pipeline.

2. **`execCommand` returns `true` even when the editor preventDefaults
   the resulting beforeinput.** There's no synchronous "did the write
   actually take" signal. Don't build fallback chains based on
   post-execCommand DOM length comparisons — the second fallback fires
   while the first is still being processed asynchronously by the
   editor, causing double-renders.

3. **`InputEvent('input', { inputType: 'insertFromPaste', data: text })`
   dispatched after a paste DOUBLES the content** in editors whose
   input-event handler reads the `data` field as plaintext to insert
   (Lexical, ProseMirror). The paste handler already inserted the text
   from DataTransfer; the input event's `data` field then gets inserted
   on top. Don't dispatch `input` events alongside paste.

4. **LLM `\n\n` is the universal paragraph-break convention. Don't
   collapse it generically.** LinkedIn / ChatGPT / claude.ai treat `\n\n`
   as one paragraph break (collapsing internally per web convention).
   Luma's TipTap is the outlier — it treats EACH `\n` as a hard
   paragraph break, so we collapse `\n+` → `\n` only for Luma.

5. **`writeCursorOffset` no-ops in managed editors.** Their selection
   models sync model→DOM, never the other way. Setting browser selection
   externally fights with their next render and the model usually wins
   (often snapping to end-of-buffer). For single-text-node splices the
   editor naturally keeps the caret at the prior character offset
   within the mutated node, which is what we want anyway.

6. **`applyTextDiff` only mutates text nodes safely on
   non-managed editors AND on managed editors when the change is
   single-segment.** Multi-segment splices get reverted by Lexical/PM
   reconcilers (only the first changed node survives, rest revert).
   For multi-segment changes in managed editors, route to
   `replaceAllText` instead.

7. **`pushText` (cycling) and `setText` (transform-blank) both go through
   `diffWriteText`.** Originally we routed setText straight to
   `replaceAllText` thinking it always meant "whole body replace", but
   cycling.ts uses setText for every word cycle — that put the cursor at
   end-of-buffer in Lexical on every cycle. The diff's single-segment vs
   multi-segment check is the right discriminator.

### Adding a new editor / site

1. Identify the engine via DOM inspection — typical markers:
   - `[data-lexical-editor="true"]` → Lexical
   - `.public-DraftEditor-content` / `data-block="true"` → Draft.js
   - `.ProseMirror` → ProseMirror/TipTap
   - `[data-slate-editor="true"]` → Slate
2. Try the matching path from the matrix first (no code changes needed if
   the engine is already detected — `isManagedEditor`/`isLexicalEditor`/
   `isDraftJsEditor` cover it).
3. If the default path for that engine doesn't work for this site, add a
   hostname carve-out in `replaceAllText`. Examples already in code:
   `isLuma`, `isPasteFiltered`. Keep the carve-outs minimal and
   well-documented (engine quirk, not a fundamental rewrite).
4. If it's a brand new engine family, add a new branch to
   `replaceAllText`, a detector to the helpers near the top of
   `opencues-bootstrap.ts`, and extend `isManagedEditor`.

### Reddit/Lexical content-loss prevention (related)

Two protections live in the runtime/core (NOT chrome-only) that prevent
data loss when LLM/pipeline glitches produce undersized rewrites for
multi-paragraph bodies:

- `packages/opencues-runtime/src/state/dyn-defs.ts` —
  `reconstructAsTyped` skips transform-blank-typed defs. Their
  `originalWord` is the FULL prior body INCLUDING the prior trigger
  phrase; reverting it bleeds two instructions into the next EXTRACT
  input, producing pipe-composed instructions or worse. See
  `docs/architecture/transform-blank.md` § "asTypedText reconstruction
  — TransformBlank defs are SKIPPED".
- `packages/opencues-core/src/sources/transform-blank-source.ts` —
  refuses to substitute when the rewrite is < 10% of target length AND
  target > 100 chars. Backstop against APPLY/VERIFY hallucinating tiny
  rewrites for big bodies.

Both apply to all hosts (CC, OC, chrome) but were discovered via chrome
debugging.
