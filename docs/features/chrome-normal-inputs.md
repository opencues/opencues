# Chrome — normal `<input>` / `<textarea>` mode

OpenCues attaches to two kinds of focused element in the browser:

1. **Contenteditable surfaces** — Gmail compose, Reddit's Lexical editor,
   ChatGPT, LinkedIn, etc. These render the editor's text from DOM text
   nodes, which CSS Custom Highlight ranges can paint. Cues + blanks
   both work here. This is the original chrome integration target.
2. **Normal `<input>` and `<textarea>`** — search boxes, single-line
   form fields, multi-line plain textareas. The browser lays out the
   `.value` internally; CSS Custom Highlight ranges can't paint on
   that internal text. So **cues are off**, **blanks still work**.

This page is the canonical reference for what works on the normal-input
path and what doesn't.

## Supported elements

The integration treats the following as normal-input mode:

- `<textarea>`
- `<input type="text">`
- `<input type="email">`
- `<input type="search">`
- `<input type="url">`

Everything else (`type="number"`, `type="date"`, `type="tel"`,
`type="password"`, `type="hidden"`, `<input>` without a `type` mapped
above, structured pickers, …) is ignored. Password and hidden inputs
should never receive fills; structured inputs have semantics that
silent text substitution would break.

The detector is `isNormalInput()` in
`integrations/chrome/src/opencues-bootstrap.ts`.

## What works

**Every blank kind except selector/satellite.** Specifically:

| Blank kind                          | Works on normal inputs? | Notes |
|---|---|---|
| Compute → text (weather, stocks, crypto, hackernews, dictionary, countries, claude-status, answer) | ✅ | First match fills, single-shot. |
| Transform (prompt-improver, "make it louder _", …)                  | ✅ | Rewrites the whole `.value`. On single-line inputs the substitution still happens — surprise factor is on the user. |
| Fluid blank (free-form `_` lookup)                                  | ✅ | Single substitution at the `_`. |
| List blank (affirmations, stepValues)                               | ⚠ Degenerate | Fills with the FIRST list item only. Cycling has no UI, so the user can't step through alternatives. |
| Selector / satellite (`opencues settings _`, `volume _`, brightness)| ❌ | Cycling is fundamental to these — without a visible band there's nothing to cycle. Triggers are ignored. |
| Cue-blanks backed by `blankScript`                                  | ✅ | Same as on CC/OC, gated by chrome-host. |

Blanks fire reactively on text-change, so typing `weather london _`
fills as soon as the `_` lands.

## What doesn't work

- **Cues (word-alternatives, tips, spelling cues).** The resolver still
  runs and may compute cue ranges, but the renderer skips them
  (`runtimeRender` early-returns in normal-input mode). Token cost is
  the same as the contenteditable path; we just discard the output.
  TODO if this becomes wasteful: gate the resolver itself.
- **Navigation / Cycling keystrokes.** The bootstrap's document-level
  `keydown` listener (`installKeyListener`) returns early when the
  focused element is a normal input. Ctrl+Up/Down, Tab between cues,
  Escape-to-dismiss, etc. all pass through to the browser. Cue/cycling
  state has no visible representation in this mode, so dispatching
  these keys would mutate text invisibly — worse than no-op.
- **Dim render / active-pill / cycling band / multi-word span markers.**
  All CSS-Custom-Highlight-driven. None paint on input internals.
- **Status bar overlay.** Skipped — it's tied to render-time injection.
- **`selectionchange` round-trip.** Skipped — cursor-navigate
  auto-highlight has no surface to drive.
- **Markdown styling.** Same root cause — `execCommand('bold')` is a
  no-op on plain inputs, and there's no DOM to wrap `<b>` around.

## Implementation shape

The "big IF statement" lives in two files:

**`integrations/chrome/src/opencues-bootstrap.ts`**

- `isNormalInput(el)` — exported detector.
- `readTargetText(target)` — branches `el.value` vs `walkPlainText`.
- `writeNormalInputValue(el, text)` — uses the native prototype-setter
  trick so React/Vue/Svelte controlled inputs pick up the change, then
  dispatches `input` + `change`. Synthetic dispatch is `isTrusted=false`
  so the document-level input listener filters it out — no
  double-notify, but framework onChange handlers still fire (those use
  their own synthetic event systems, not `isTrusted`).
- `readCursorOffset` / `writeCursorOffset` — branched to use
  `selectionStart` / `setSelectionRange` on inputs.
- `diffWriteText` / `replaceAllText` — early-branch to
  `writeNormalInputValue`.
- `runtimeRender` — early-returns when target is a normal input.
- `installKeyListener` — early-returns when target is a normal input.

**`integrations/chrome/src/content.ts`**

- `isTextInput` now returns true for both contenteditables and normal
  inputs.
- `attachToFocused` skips `applyDerivedColours` for inputs (no
  highlight style tag needed).
- The document-level `input` forwarder uses `readTargetText` so the
  branch is transparent to the runtime.
- The `selectionchange` listener early-returns for inputs.
- Cleanup paths (`focusout`, `onConfigChange`, `prefers-color-scheme`
  change) skip the highlight-colour calls when the target is an input.

## Trust gate behavior

The `_` credit-based trust gate works identically on normal inputs:

- `keydown` for `_` with `isTrusted=true` adds a credit.
- `paste` / `drop` count their `_`s as credits.
- Synthetic input events from a hostile page are still
  `isTrusted=false` and filtered at the document-level listener.

There's no new attack surface — the input branch reuses the same
trust gate, just with a different read/write path.

## Caveats users should know about

1. **Enter may submit before a blank fills.** Forms typically submit
   on Enter. If the user types `weather _` followed by Enter, the form
   may submit with `weather _` in the field before the LLM round-trip
   finishes. This is an inherent property of form behavior, not a bug
   we can fix without intercepting Enter (which we don't, see the
   spec discussion below).
2. **Transform-blank on single-line inputs may be surprising.** A
   search box with `make it shorter _` would have its whole body
   rewritten in place. Working as designed but worth knowing.
3. **No visible feedback that OpenCues is active.** We deliberately
   ship no badge / toast / preview in normal-input mode (kept simple
   per the spec discussion). To verify OpenCues is on the input, flip
   `debug-mode: on` in `~/.cues/CUES.md` and watch the DevTools
   console — attach lines (`[OpenCues][normal-input] Attaching to`)
   and write lines (`[opencues][normal-input] writeValue: newLen=...`)
   surface there.

## Debugging

The two log tags to grep for in DevTools:

- `[OpenCues][normal-input] Attaching to` — fires once per focus into
  a normal input. Confirms the integration saw the element.
- `[opencues][normal-input] writeValue: newLen=N` — fires every time
  the runtime wrote a value (blank fill, transform substitution,
  fluid fill).

Both gated behind `debug-mode: on` (live-toggleable from any host's
`opencues settings _` selector, or by editing
`~/.cues/CUES.md` directly). The mirror to the native-host log file
(`/tmp/opencues.log`) is always on, so post-mortem inspection works
without needing the dev tools open at the time.

If a blank silently fails on a normal input:

1. Check the attach line fired (right element type? right `type`
   attribute?).
2. Check the keyword routes correctly — `opencues list` to see what
   the bundle has for the keyword.
3. Check the trust gate didn't drop the `_` — look for warn lines
   near the input event.
4. Check the framework didn't revert the write — sites that
   aggressively replace `.value` from React state can fight us; the
   native-setter dispatch should beat them, but if you see a flash of
   the fill before it disappears, that's the symptom.

## Why no badge / preview / toast?

Considered, deferred. The minimal IF-statement landing here is the
quickest path to "blanks work in input fields". Visual feedback would
mean either:

- A corner badge — requires a fixed-position element that survives
  iframe boundaries and doesn't conflict with the host page's z-stack.
- A ghost-text preview — requires pixel-perfect alignment with the
  input's font / line-height / padding, which is fragile across
  thousands of styled inputs in the wild.
- A toast on fill — adds a notification layer to a content script
  that previously had none.

None of these are hard, but all add scope. Revisit if user feedback
indicates discoverability is the problem.
