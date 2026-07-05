# VS Code adapter — repair & version-bump guide

> **The runtime package is intentionally never in this loop.** If you
> find yourself editing `packages/opencues-runtime/src/**` to fix a
> VS Code issue, stop and ask why — those modules don't know what host
> they're running in. Repairs live in the adapter band + the extension
> glue (`integrations/vscode/src/`) only.

There is no upstream fork and no version pin: the integration is
self-owned (the extension is our own build artifact) and the VS Code
extension API is stable, so there is no "version bump" runbook here —
`engines.vscode` in `integrations/vscode/package.json` is the only
compatibility floor. This file catalogues host quirks instead.

Design + full risk register: `integrations/vscode/PLAN.md` (Q-numbers
below refer to its quirks table).

## Host quirks (VS Code ≥1.85) — read this before debugging anything

### 1. Programmatic edits echo through `onDidChangeTextDocument` (Q3)
**Symptom:** highlight "flashes on then off" after every cycle; Resolver
re-fires on the runtime's own substitution.
**Why:** `TextEditor.edit` fires the same document-change event as user
typing; there is no "who edited" field.
**Fix:** every write path in the glue calls
`reclassifier.markRuntimeWrite(newText)` BEFORE the edit lands, and the
change handler routes the event source through
`reclassifier.reclassify(text, 'user')`. The wrap is load-bearing — a
naked write reintroduces the May 2026 runaway-loop bug class.

### 2. Keybinding conflicts: Ctrl+Alt+arrows are add-cursor (Q1)
**Symptom:** users lose multi-cursor above/below; or OpenCues nav never
fires.
**Why:** default keybindings collide on Win/Linux.
**Fix:** keybindings are scoped `when: editorTextFocus &&
opencues.cueActive`; the glue maintains the `opencues.cueActive`
context key from runtime state so the bindings only exist while a cue
is navigable. Never widen the `when` clause.

### 3. Decoration ranges auto-shift on edits (Q2)
**Symptom:** dim/highlight drifts off the cued words after typing.
**Why:** VS Code tracks and shifts `setDecorations` ranges on document
edits; the runtime owns range truth and repaints per directive batch —
the two range models diverge between batches.
**Fix:** wholesale `setDecorations(type, ranges)` per decoration type
on every directive batch (coalesced first — see #4); never rely on
VS Code's between-batch tracking.

### 4. Overlapping dim ranges paint patchy (Q11)
**Symptom:** dim looks broken exactly where a cue word sits inside a
span dim.
**Fix:** sort + merge overlapping/adjacent ranges per decoration type
before painting (the CC `applyDirectives` merge lesson, ported).

### 5. Async fills need pushText + explicit repaint (Q10)
**Symptom:** a blank result "sits there" invisibly until the next
keystroke.
**Why:** there is no key dispatch after an async fill to drain pending
state, and no host render loop to piggyback on.
**Fix:** `pushText` applies the edit immediately AND the glue repaints
decorations after every async write.

### 6. External mutations: formatters, Copilot, snippets, file reloads (Q14)
**Symptom:** stale spans / blocked blanks / wrong-word dim after a
format-on-save or an accepted inline completion.
**Why:** third-party edits are indistinguishable from user typing in
`onDidChangeTextDocument`.
**Fix:** heuristic detector in the glue (multi-range edits, or large
edits away from the cursor, that aren't a pending runtime write) →
`resetBufferState()`. Undo/redo is NOT heuristic —
`TextDocumentChangeEvent.reason` is authoritative.

### 7. Multi-cursor suspends OpenCues (Q15)
**Symptom:** cycling writes at the wrong position with 2+ cursors.
**Fix:** `selections.length > 1` → deactivate + suppress dispatch +
`opencues.cueActive` context false until back to a single selection.

### 8. One `edit()` per logical write — atomic multi-segment (Q9/D12)
**Symptom:** Ctrl+Z reverts to a half-applied intermediate state; the
cursor snaps to end-of-buffer on multi-word cycles.
**Fix:** diff old→new into minimal range edits applied in ONE
`TextEditor.edit` callback; check the returned boolean — on `false`,
log + `resetBufferState()`, never retry blind, never fall back to
buffer-length comparisons.

### 9. `supportsCycling` verdict must be cheap and never throw
**Why:** the probe runs inside the resolver build key on every text
change; a throwing probe is swallowed as `true` by the adapter
(chrome-parity), which silently un-gates an over-size document.
**Fix:** the glue computes the verdict from cached
languageId/scheme/size state, not fresh document scans.
