# Chrome Extension vs Claude Code: Parity Notes

What the Claude Code patches handle that the Chrome extension doesn't need, handles differently, or has known divergence.

## Not Needed (browser eliminates the problem)

### Invisible Character Toggle (\u200B / \u200C)
**Claude Code:** Appends alternating zero-width characters to force React re-renders.
**Chrome Extension:** Not needed. DOM mutations are immediate. `MutationObserver` detects external changes.

### ZWS Double-Correction
**Claude Code:** Cursor fix must pass clean text to avoid the ZWS strip block subtracting again.
**Chrome Extension:** No ZWS in text. Cursor managed via `Selection`/`Range` API.

### `InputZone.fromText()` + `onOffsetChange()` Persistence
**Claude Code:** Must call `onOffsetChange()` to persist cursor in React state.
**Chrome Extension:** `Selection`/`Range` API is stateful — persists until next user action.

### Raw Terminal Escape Sequences
**Claude Code:** Fallback for `\x1B[1;7D` etc.
**Chrome Extension:** Browsers fire proper `KeyboardEvent` objects.

### ANSI Escape Code Rendering
**Claude Code:** ~200 lines of char-by-char ANSI position tracking.
**Chrome Extension:** CSS classes on `<span>` elements.

### `require()` Function Name Discovery
**Claude Code:** Bundled `cli.js` renames `require`.
**Chrome Extension:** Standard ES module imports.

### Render-Cycle Execution Order
**Claude Code:** Cursor fix must run before auto-populate in same render cycle.
**Chrome Extension:** No render cycle — DOM changes are immediate.

### External Highlight Preservation (shimmer)
**Claude Code:** Skips ANSI wrapping for words with shimmer highlights.
**Chrome Extension:** No shimmer component. Overlay has `pointer-events: none`.

### File-Based State Export
**Claude Code:** Writes JSON to `/tmp/` for shell status line.
**Chrome Extension:** In-memory state + DOM status bar.

### Process-Based TTS
**Claude Code:** Spawns `SpeakCtl.exe` or `speak.sh`.
**Chrome Extension:** Native Web Speech API.

## Handled Differently

### Config Loading
**Claude Code:** `fs.readFileSync()` with 2-second hot-reload TTL polling.
**Chrome Extension:** User pastes into popup. `chrome.storage.local` with `onChanged` listener (event-driven, no polling).

### Cue-Blank Script Execution
**Claude Code:** `child_process.execSync("bash <name>-blank.sh get/set")` via the `blankInvoke` registry's spawn fallback.
**Chrome Extension:** TS-class blanks in `@opencues/runtime/src/blanks/` registered into the chrome `blanksRegistry`. No subprocess.

### Text Replacement
**Claude Code:** `onChange(newFullText)` replaces entire input.
**Chrome Extension:** `document.execCommand('insertText')` preserves undo history.

### Selector/Satellite Script Calls
**Claude Code:** `execFileSync("bash", [script, "set", setting, value])` writes back to OPENCUES.md synchronously.
**Chrome Extension:** In-memory only — `openCues.current[setting] = newValue`. No file writeback. **Divergence:** changes don't persist across page reloads. User must update OPENCUES.md in popup manually.

### Display Form (formerly "Keyword Expansion")
**Claude Code:** A blank emits its own display string from its runtime `get()` — e.g. `StocksBlank` returns `"Reddit $133.44"`, not a bare `$133.44` plus a keyword→display map. The `blankKeywordExpansions` shorthand-expansion config (`aapl` → `AAPL`) was removed in the June 2026 slim-down; there is no expansion map anymore.
**Chrome Extension:** Same — the same runtime blank class produces the self-contained display form directly. **Full parity:** both hosts run the identical `@opencues/runtime` class, so output is byte-identical with no config to keep in sync.

### Context-Word Clearing
**Claude Code:** Clearing is now SHAPE-DERIVED. The `blankClearKeywords` frontmatter dial (and the `PromptImproverBlank` that used it) was removed in the June 2026 slim-down. A captured arg, a typed set-step, or an `integration:` output template consumes the command span; a bare keyword get keeps its label. There is no separate "remove context words before fill" pass.
**Chrome Extension:** Same shape-derived clearing via the shared runtime. **Full parity** — no host-specific descending-index removal step anymore.

### System Volume / Brightness
**Claude Code:** Real system volume/brightness via OS APIs through `volume-blank.sh` / `brightness-blank.sh`.
**Chrome Extension:** Not available — the chrome adapter has no subprocess capability. These blanks are filtered out of the chrome bundle by host-compat. **Divergence:** no system-level hardware control.

## Known Divergence

### Selector/Satellite Persistence
**Claude Code:** Satellite cycling writes back to OPENCUES.md via script, persisting across sessions.
**Chrome Extension:** In-memory only. Setting changes are lost on page reload. To persist, the user must update OPENCUES.md content in the popup.

### Display Form / Context-Word Clearing
**Claude Code:** Both the shorthand-expansion map and the context-word clearing dial were removed in the June 2026 slim-down. Blanks now emit a self-contained display string from their runtime class, and clearing is shape-derived (a captured arg / typed set-step / `integration:` template consumes the command span).
**Chrome Extension:** Same — both behaviours come from the shared `@opencues/runtime` classes, so there is nothing host-specific to diverge. **Full parity.**

### blankClearOnEdit — Text Removal
**Claude Code:** When user edits over a cue-blank pair with `blankClearOnEdit: true`, the pair is removed from text entirely (selector + separator + satellite deleted).
**Chrome Extension:** Implemented — pair indices are queued in `pendingClearOnEdit` and removed on next input event. **Same behavior**, but uses `execCommand('insertText')` instead of `onChange()` for the text replacement.

### Imperative Rewrites (formerly "Consume-All — Two-Step LLM Pipeline")
**Retired (June 2026 slim-down).** The `blankConsumeAll` dial and its `PromptImproverBlank` two-step (extract → transform) pipeline were removed. Free-form imperative rewrites ("improve this prompt", "make it formal") now route through `TransformBlankSource`, which runs a single fused LLM call and merges the result into the buffer — no dedicated consume-all flow.

**Still present:** dynamic multi-line *list* cycling via `_consumeAllAlts` / span-fill, used by blanks that return newline-separated alternatives (e.g. Hacker News). That mechanism is a list-cycling state container, not the retired dial, and runs identically on Claude Code and Chrome through the shared runtime. **Full parity** for that path.

### OPENCUES.md Parser — Regex Avoidance
**Claude Code:** Learned the hard way that regex for frontmatter parsing fails silently due to escape-sequence interactions across TypeScript template → patched string → runtime regex.
**Chrome Extension:** Uses the same line-by-line walker approach (no regex for frontmatter). **Full parity.**

### Cycling Priority Order
**Claude Code:** Strict order: cue-blank values → selector → satellite → dynamic alts → tips. (The `consume-all` step was removed when the dial was retired in June 2026.)
**Chrome Extension:** Same order enforced by the runtime's Cycling module. Cue-blank values are handled by `blankInvoke` before the main alt-cycling path. **Full parity.**

### Voice-Mode Gate
**Claude Code:** Checks `_openCuesCurrent["voice-mode"]` synchronously before every TTS spawn. Satellite cycling updates this in-memory immediately.
**Chrome Extension:** Same — `isVoiceMuted()` checks `openCues.current["voice-mode"]`. Satellite cycling updates in-memory immediately. **Full parity.**

### Stale Result Rejection
**Claude Code:** `_resolverGeneration` counter incremented on config rebuild. Results from old generation are discarded.
**Chrome Extension:** Same — `resolverGeneration` counter in the runtime. **Full parity.**

### Multi-Word Replacement Atomicity
**Claude Code:** All word replacements in a cycle applied in a single pass via `_updW` map.
**Chrome Extension:** Same — `updatedWords` map, sequential forward walk. **Full parity.**

### blankName Merge Guard
**Claude Code:** `if(_oldW2.metadata.blankName && !_nw2.metadata.blankName) continue` — prevents LLM overwriting cue-blank positions.
**Chrome Extension:** Same guard in analysis merge loop. **Full parity.**

### Unconditional Dynamic-List Cleanup
**Claude Code:** `_consumeAllAlts` (the dynamic multi-line list-cycling state, e.g. Hacker News) cleanup runs OUTSIDE the `_hlState.active` guard on text change.
**Chrome Extension:** Same — cleanup runs in `analyze()` which fires on every input event, regardless of highlight state. **Full parity.**

### blankClearOnEdit Cleanup Outside Highlight Guard
**Claude Code:** `_pendingClearOnEdit` words are removed unconditionally on text change.
**Chrome Extension:** Same — `executeClearOnEdit()` is called at the top of the input handler, before any highlight checks. **Full parity.**
